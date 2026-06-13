import type { CursorTargetRect, CursorTargetSnapshot, MouseCursorPosition } from "../types";

export const CURSOR_REPLAY_TARGET_ATTRIBUTE = "data-cursor-replay-target";
export const CURSOR_REPLAY_VIEWPORT_TARGET_ID = "viewport";

interface CreateCursorPositionOptions {
  clientX: number;
  clientY: number;
  visible: boolean;
  eventTarget?: EventTarget | null;
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
    areCursorTargetsEqual(previous.target, next.target)
  );
}

export function createCursorPositionFromClientPoint({
  clientX,
  clientY,
  visible,
  eventTarget,
  targetElement,
}: CreateCursorPositionOptions): MouseCursorPosition {
  const x = toFiniteNumber(clientX);
  const y = toFiniteNumber(clientY);
  const preferredTarget = findClosestReplayTarget(targetElement ?? null);
  const eventElement = getElementFromTarget(eventTarget);
  const replayTarget = preferredTarget ?? findClosestReplayTarget(eventElement);
  const ownerDocument = getOwnerDocument(replayTarget ?? eventElement ?? targetElement ?? null);

  if (!replayTarget) {
    const rect = getViewportRect(ownerDocument);

    return {
      x,
      y,
      visible,
      target: createTargetSnapshot(CURSOR_REPLAY_VIEWPORT_TARGET_ID, rect, x, y),
    };
  }

  const targetId = getTargetId(replayTarget);
  if (!targetId) {
    return { x, y, visible };
  }

  return {
    x,
    y,
    visible,
    target: createTargetSnapshot(targetId, getRectSnapshot(replayTarget), x, y),
  };
}

export function resolveCursorViewportPosition(
  cursor: MouseCursorPosition,
): CursorViewportPosition | null {
  if (!cursor.visible) {
    return null;
  }

  const target = cursor.target;
  if (!target) {
    return { x: cursor.x, y: cursor.y };
  }

  const ownerDocument = typeof document === "undefined" ? null : document;
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
    return { x: cursor.x, y: cursor.y };
  }

  return {
    x: currentRect.left + (target.x / target.rect.width) * currentRect.width,
    y: currentRect.top + (target.y / target.rect.height) * currentRect.height,
  };
}
