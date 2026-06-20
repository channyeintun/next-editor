import type {
  CursorTargetRect,
  CursorTargetSnapshot,
  CursorTweenEndpoint,
  MouseCursorPosition,
} from "../types";

export const CURSOR_REPLAY_TARGET_ATTRIBUTE = "data-cursor-replay-target";
export const CURSOR_REPLAY_VIEWPORT_TARGET_ID = "viewport";
export const CURSOR_REPLAY_ROOT_TARGET_ID = "app";

// Targets whose *content* is scaled to fit the box (the preview iframe is
// scaled-to-fit, reveal.js scales slides, and the raw viewport fallback). For
// these, a recorded point must be re-scaled by the box's current size on replay.
//
// Every other target (the code editor, file explorer, terminal dock, layout
// containers, app root) renders fixed-size, top-left-anchored content, so its
// cursor is anchored to the box's top-left by absolute offset instead — that
// keeps the cursor over the same content when the box is merely resized (e.g.
// the editor widens after the file explorer is hidden) rather than sliding it
// sideways in proportion to the new width.
const CURSOR_SCALING_TARGET_IDS: ReadonlySet<string> = new Set([
  CURSOR_REPLAY_VIEWPORT_TARGET_ID,
  "preview-frame",
  "preview-content",
  "preview",
  "slide-preview",
  "slide-content",
]);

interface CreateCursorPositionOptions {
  clientX: number;
  clientY: number;
  visible: boolean;
  flags?: number;
  angle?: number;
  pressure?: number;
  eventTarget?: EventTarget | null;
  rootElement?: Element | null;
  targetElement?: Element | null;
}

export interface CursorViewportPosition {
  x: number;
  y: number;
}

function toFiniteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function isElementLike(value: unknown): value is Element {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { nodeType?: number }).nodeType === 1 &&
    typeof (value as Element).getBoundingClientRect === "function"
  );
}

function getElementFromTarget(target: EventTarget | null | undefined): Element | null {
  if (isElementLike(target)) {
    return target;
  }

  const parentElement = (target as { parentElement?: unknown } | null | undefined)?.parentElement;
  return isElementLike(parentElement) ? parentElement : null;
}

function getOwnerDocument(element: Element | null): Document | null {
  if (element?.ownerDocument) {
    return element.ownerDocument;
  }

  return typeof document === "undefined" ? null : document;
}

function getViewportRect(ownerDocument: Document | null): CursorTargetRect {
  const documentElement = ownerDocument?.documentElement;
  const ownerWindow =
    ownerDocument?.defaultView ?? (typeof window === "undefined" ? undefined : window);

  return {
    left: 0,
    top: 0,
    width: toFiniteNumber(ownerWindow?.innerWidth ?? documentElement?.clientWidth ?? 0),
    height: toFiniteNumber(ownerWindow?.innerHeight ?? documentElement?.clientHeight ?? 0),
  };
}

function getRectSnapshot(element: Element): CursorTargetRect {
  const rect = element.getBoundingClientRect();

  return {
    left: toFiniteNumber(rect.left),
    top: toFiniteNumber(rect.top),
    width: toFiniteNumber(rect.width),
    height: toFiniteNumber(rect.height),
  };
}

function getRectRelativeToRoot(element: Element, rootRect: CursorTargetRect): CursorTargetRect {
  const rect = getRectSnapshot(element);

  return {
    left: rect.left - rootRect.left,
    top: rect.top - rootRect.top,
    width: rect.width,
    height: rect.height,
  };
}

function getTargetId(element: Element | null): string | null {
  const id = element?.getAttribute(CURSOR_REPLAY_TARGET_ATTRIBUTE)?.trim();
  return id || null;
}

function findClosestReplayTarget(element: Element | null): Element | null {
  let current: Element | null = element;

  while (current) {
    if (getTargetId(current)) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function findReplayTargetById(id: string, ownerDocument: Document): Element | null {
  const targets = ownerDocument.querySelectorAll(`[${CURSOR_REPLAY_TARGET_ATTRIBUTE}]`);

  for (const target of targets) {
    if (getTargetId(target) === id) {
      return target;
    }
  }

  return null;
}

function findRootReplayTarget(ownerDocument: Document | null): Element | null {
  if (!ownerDocument) {
    return null;
  }

  return findReplayTargetById(CURSOR_REPLAY_ROOT_TARGET_ID, ownerDocument);
}

function createTargetSnapshot(
  id: string,
  rect: CursorTargetRect,
  clientX: number,
  clientY: number,
): CursorTargetSnapshot {
  return {
    id,
    rect,
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function createCursorMetadata({
  coordinateSpace,
  flags,
  hover,
  angle,
  pressure,
}: Pick<
  MouseCursorPosition,
  "coordinateSpace" | "flags" | "hover" | "angle" | "pressure"
>): Partial<MouseCursorPosition> {
  return {
    ...(coordinateSpace ? { coordinateSpace } : {}),
    ...(typeof flags === "number" ? { flags } : {}),
    ...(hover !== undefined ? { hover } : {}),
    ...(typeof angle === "number" ? { angle } : {}),
    ...(typeof pressure === "number" ? { pressure } : {}),
  };
}

function areTargetRectsEqual(
  previous: CursorTargetRect | undefined,
  next: CursorTargetRect | undefined,
): boolean {
  if (!previous && !next) return true;
  if (!previous || !next) return false;

  return (
    previous.left === next.left &&
    previous.top === next.top &&
    previous.width === next.width &&
    previous.height === next.height
  );
}

function areCursorTargetsEqual(
  previous: CursorTargetSnapshot | undefined,
  next: CursorTargetSnapshot | undefined,
): boolean {
  if (!previous && !next) return true;
  if (!previous || !next) return false;

  return (
    previous.id === next.id &&
    previous.x === next.x &&
    previous.y === next.y &&
    areTargetRectsEqual(previous.rect, next.rect)
  );
}

export function areMouseCursorPositionsEqual(
  previous: MouseCursorPosition | undefined,
  next: MouseCursorPosition | undefined,
): boolean {
  if (!previous && !next) return true;
  if (!previous || !next) return false;

  return (
    previous.x === next.x &&
    previous.y === next.y &&
    previous.visible === next.visible &&
    previous.coordinateSpace === next.coordinateSpace &&
    previous.flags === next.flags &&
    previous.hover === next.hover &&
    previous.angle === next.angle &&
    previous.pressure === next.pressure &&
    areCursorTargetsEqual(previous.target, next.target)
  );
}

export function createCursorPositionFromClientPoint({
  clientX,
  clientY,
  visible,
  flags,
  angle,
  pressure,
  eventTarget,
  rootElement,
  targetElement,
}: CreateCursorPositionOptions): MouseCursorPosition {
  const preferredTarget = findClosestReplayTarget(targetElement ?? null);
  const eventElement = getElementFromTarget(eventTarget);
  const replayTarget = preferredTarget ?? findClosestReplayTarget(eventElement);
  const ownerDocument = getOwnerDocument(
    rootElement ?? replayTarget ?? eventElement ?? targetElement ?? null,
  );
  const rootTarget = rootElement ?? findRootReplayTarget(ownerDocument);

  if (rootTarget) {
    const rootRect = getRectSnapshot(rootTarget);
    const x = Math.floor(toFiniteNumber(clientX) - rootRect.left);
    const y = Math.floor(toFiniteNumber(clientY) - rootRect.top);
    const target = replayTarget ?? rootTarget;
    const targetId = getTargetId(target) ?? CURSOR_REPLAY_ROOT_TARGET_ID;

    return {
      x,
      y,
      visible,
      ...createCursorMetadata({
        coordinateSpace: "root",
        flags,
        hover: targetId,
        angle,
        pressure,
      }),
      target: createTargetSnapshot(targetId, getRectRelativeToRoot(target, rootRect), x, y),
    };
  }

  const x = Math.floor(toFiniteNumber(clientX));
  const y = Math.floor(toFiniteNumber(clientY));

  if (!replayTarget) {
    const rect = getViewportRect(ownerDocument);

    return {
      x,
      y,
      visible,
      ...createCursorMetadata({
        coordinateSpace: "viewport",
        flags,
        hover: CURSOR_REPLAY_VIEWPORT_TARGET_ID,
        angle,
        pressure,
      }),
      target: createTargetSnapshot(CURSOR_REPLAY_VIEWPORT_TARGET_ID, rect, x, y),
    };
  }

  const targetId = getTargetId(replayTarget);
  if (!targetId) {
    return {
      x,
      y,
      visible,
      ...createCursorMetadata({ coordinateSpace: "viewport", flags, angle, pressure }),
    };
  }

  return {
    x,
    y,
    visible,
    ...createCursorMetadata({
      coordinateSpace: "viewport",
      flags,
      hover: targetId,
      angle,
      pressure,
    }),
    target: createTargetSnapshot(targetId, getRectSnapshot(replayTarget), x, y),
  };
}

function resolveEndpointToViewport(
  cursor: CursorTweenEndpoint | MouseCursorPosition,
  ownerDocument: Document | null,
): CursorViewportPosition | null {
  if (!cursor.visible) return null;

  const target = cursor.target;
  if (!target) {
    if (cursor.coordinateSpace === "root") {
      const rootRect = ownerDocument
        ? (() => {
            const rootElement = findRootReplayTarget(ownerDocument);
            return rootElement ? getRectSnapshot(rootElement) : null;
          })()
        : null;

      if (rootRect) {
        return { x: rootRect.left + cursor.x, y: rootRect.top + cursor.y };
      }
    }

    return { x: cursor.x, y: cursor.y };
  }

  const currentRect =
    target.id === CURSOR_REPLAY_VIEWPORT_TARGET_ID
      ? getViewportRect(ownerDocument)
      : ownerDocument
        ? (() => {
            const targetElement = findReplayTargetById(target.id, ownerDocument);
            return targetElement ? getRectSnapshot(targetElement) : null;
          })()
        : null;

  if (!currentRect || target.rect.width <= 0 || target.rect.height <= 0) {
    if (cursor.coordinateSpace === "root") {
      const rootElement = ownerDocument ? findRootReplayTarget(ownerDocument) : null;
      const rootRect = rootElement ? getRectSnapshot(rootElement) : null;

      if (rootRect) {
        return { x: rootRect.left + cursor.x, y: rootRect.top + cursor.y };
      }
    }

    return { x: cursor.x, y: cursor.y };
  }

  if (CURSOR_SCALING_TARGET_IDS.has(target.id)) {
    return {
      x: currentRect.left + (target.x / target.rect.width) * currentRect.width,
      y: currentRect.top + (target.y / target.rect.height) * currentRect.height,
    };
  }

  return {
    x: currentRect.left + target.x,
    y: currentRect.top + target.y,
  };
}

export function resolveCursorViewportPosition(
  cursor: MouseCursorPosition,
): CursorViewportPosition | null {
  if (!cursor.visible) {
    return null;
  }

  const ownerDocument = typeof document === "undefined" ? null : document;
  const tween = cursor.tween;

  if (tween) {
    const from = resolveEndpointToViewport(tween.from, ownerDocument);
    const to = resolveEndpointToViewport(tween.to, ownerDocument);

    if (!from || !to) {
      return from ?? to;
    }

    return {
      x: from.x + (to.x - from.x) * tween.progress,
      y: from.y + (to.y - from.y) * tween.progress,
    };
  }

  return resolveEndpointToViewport(cursor, ownerDocument);
}
