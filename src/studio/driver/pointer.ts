import { findCursorReplayRoot } from "../../core/src/utils/cursorCoordinates";
import {
  POINTER_PRESS_MS,
  POINTER_SETTLE_MS,
  easePointerAim,
  pointerAimDurationMs,
} from "../../core/src/utils/pointerMotion";
import { dispatchRecordedCursorVisibility } from "../../core/src/utils/recordedCursorVisibility";
import { StudioActionError, abortableSleep, throwIfAborted, tween, waitUntil } from "../async";
import { describeStudioTarget, resolveStudioTarget, studioTargetAimPoint } from "../targets";
import type { StudioDriver, StudioDriverDeps } from "./index";
import { previewAimPoint } from "./webContainer";

/**
 * The studio pointer: the one place the recorded mouse lives. It owns where
 * the pointer last rested and whether it is hidden, and every domain that
 * moves it (a control click, a drag-select, a console point, a dock change, a
 * slide taking the stage) goes through the controller below.
 */

// How long a pointer move waits for its control to render (see moveCursor).
const TARGET_APPEAR_MS = 500;

// The quickest a pointer move may be squeezed to: one quick stroke, about what
// a single recorded hand movement took at any range.
const MIN_TRAVEL_MS = 150;

export interface PointerPoint {
  x: number;
  y: number;
}

export const roundPoint = (point: PointerPoint): PointerPoint => ({
  x: Math.round(point.x),
  y: Math.round(point.y),
});

/**
 * The topmost element at (x, y) inside the cursor-replay root, or null.
 *
 * The mouse-tracking actor drops any sample whose target sits outside the
 * cursor-replay root, and the studio console panel is fixed above the editor
 * but mounted outside that root — so the plain topmost hit would be that panel.
 * Hit-testing through the stack finds what the app itself shows at the point.
 */
function topmostInReplayRoot(x: number, y: number): Element | null {
  const root = findCursorReplayRoot(document);
  const stack =
    typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(x, y) : [];
  return stack.find((candidate) => !root || root.contains(candidate)) ?? null;
}

/**
 * The element a synthetic pointer sample at (x, y) is dispatched on: the
 * topmost one inside the cursor-replay root (so no sample is silently lost
 * under the studio console), falling back to the action's target.
 */
export function cursorDispatchTarget(x: number, y: number, fallback: Element): Element {
  return topmostInReplayRoot(x, y) ?? fallback;
}

/**
 * Whether something else covers `element` at `point` — a maximized slide or
 * whiteboard over the runner dock, say. A hand cannot click what it cannot
 * see. Unknown (no hit-testing) counts as uncovered.
 */
export function isCoveredAt(point: PointerPoint, element: Element): boolean {
  const top = topmostInReplayRoot(point.x, point.y);
  return top !== null && top !== element && !element.contains(top);
}

export interface StudioPointer {
  /** Hide the pointer where it rests until its next gesture (idempotent). */
  hide(): void;
  /** Show a hidden pointer at `point`; a visible pointer is left alone. */
  revealAt(point: PointerPoint): void;
  /** Re-record a resting pointer against the app root (no-op while hidden). */
  pinToApp(): void;
  /** Dispatch one synthetic pointer sample at (x, y), `buttons` 1 while held. */
  dispatch(x: number, y: number, element: Element, buttons?: number): void;
  isHidden(): boolean;
  /** Where the last sample landed, or null before the first one. */
  lastPoint(): PointerPoint | null;
}

export function createStudioPointer(): StudioPointer {
  let lastCursorPoint: PointerPoint | null = null;
  // Whether the recorded pointer is hidden right now (mouseTrackingActor records
  // every sample hidden until it is shown again).
  let pointerHidden = false;

  const dispatch = (x: number, y: number, element: Element, buttons = 0) => {
    // Synthetic pointer input rides the exact capture path human input uses:
    // the mouse-tracking actor listens on the document in the capture phase,
    // so dispatching on the element under the point yields target-aware
    // samples (`createCursorPositionFromClientPoint` walks up from `target`).
    // `buttons` is 1 while the button is held — a click's press, or a select
    // drag — and 0 otherwise, so the recorded cursor shows the press.
    cursorDispatchTarget(x, y, element).dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerType: "mouse",
        buttons,
      }),
    );
    lastCursorPoint = { x, y };
  };

  // Hands off the mouse. The pointer disappears where it rests — at the start,
  // before it has anything to point at; while typing, as the OS hides it; under
  // a slide or whiteboard that covers what it was resting on — and stays hidden
  // until its next gesture. A pointer parked on stale code reads as noise.
  const hide = () => {
    if (pointerHidden) return;
    const at = lastCursorPoint ?? {
      x: Math.round(window.innerWidth / 2),
      y: Math.round(window.innerHeight / 2),
    };
    dispatchRecordedCursorVisibility({ x: at.x, y: at.y, visible: false });
    pointerHidden = true;
  };

  // A hidden pointer never travels: it reappears on the spot its next gesture
  // starts from, so the only motion a learner sees is the gesture itself.
  const revealAt = (point: PointerPoint) => {
    if (!pointerHidden) return;
    dispatchRecordedCursorVisibility({ x: point.x, y: point.y, visible: true });
    pointerHidden = false;
    lastCursorPoint = point;
  };

  // Pin a resting pointer to the app itself just before the layout under it
  // changes (the runner dock opening or shutting). Replay places a sample
  // relative to the element it was recorded over, so a pointer resting on the
  // dock would ride along with the dock's edge — off the bottom of the screen
  // once it shuts. Recorded against the app root, the same spot stays put while
  // the panel moves under it, whenever replay applies the layout change.
  const pinToApp = () => {
    if (pointerHidden || !lastCursorPoint) return;
    const root = findCursorReplayRoot(document);
    if (!root) return;
    root.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: lastCursorPoint.x,
        clientY: lastCursorPoint.y,
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerType: "mouse",
        buttons: 0,
      }),
    );
  };

  // Until its first gesture the pointer has nothing to point at.
  hide();

  return {
    hide,
    revealAt,
    pinToApp,
    dispatch,
    isHidden: () => pointerHidden,
    lastPoint: () => lastCursorPoint,
  };
}

export async function moveCursor(
  deps: Pick<StudioDriverDeps, "preview" | "signal">,
  pointer: StudioPointer,
  { target, durationMs, press = false }: Parameters<StudioDriver["moveCursor"]>[0],
): ReturnType<StudioDriver["moveCursor"]> {
  const { signal } = deps;
  const started = performance.now();
  // A control can take a frame to appear — the Run button renders once the
  // dock it lives in has opened — so give it a moment before failing.
  if (!resolveStudioTarget(target)) {
    try {
      await waitUntil(() => resolveStudioTarget(target) !== null, {
        timeoutMs: TARGET_APPEAR_MS,
        signal,
        description: describeStudioTarget(target),
      });
    } catch {
      throwIfAborted(signal);
    }
  }
  const frame = resolveStudioTarget(target);
  if (!frame) {
    throw new StudioActionError(`Missing studio target: ${describeStudioTarget(target)}`);
  }

  // Aiming into the preview is best-effort: the authored preview.click /
  // preview.input that follows, with its own timeout and retry, stays the
  // one check that fails the render. An element that is not mounted yet,
  // hidden, or off the preview's view just gets no click from the pointer.
  let previewPoint: PointerPoint | null = null;
  if (target.kind === "preview") {
    let skipped = "the element is hidden or outside the preview's visible area";
    try {
      previewPoint = await previewAimPoint(
        deps,
        target.testId,
        frame,
        Math.min(2_000, Math.max(250, durationMs)),
      );
    } catch (error) {
      throwIfAborted(signal);
      skipped = `the preview element could not be located: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!previewPoint) {
      return { target: describeStudioTarget(target), skipped };
    }
  }
  // Re-resolved every step: a React re-render can swap the DOM node, and
  // layout can shift while the pointer travels.
  const destination = (): { point: PointerPoint; element: Element } => {
    if (previewPoint) return { point: previewPoint, element: frame };
    const element = resolveStudioTarget(target);
    const rect = element?.getBoundingClientRect();
    if (!element || !rect || (rect.width === 0 && rect.height === 0)) {
      throw new StudioActionError(
        `Studio target became invisible: ${describeStudioTarget(target)}`,
      );
    }
    return { point: studioTargetAimPoint(element), element };
  };

  const initial = destination();
  if (isCoveredAt(initial.point, initial.element)) {
    return {
      target: describeStudioTarget(target),
      skipped: "something else covers it on screen",
    };
  }

  // The plan budgets the longest approach; the move takes the time its real
  // distance needs (pointerAimDurationMs) and starts later instead of
  // crawling, so it still arrives when the plan said it would.
  const clickMs = press ? POINTER_SETTLE_MS + POINTER_PRESS_MS : 0;
  const travelBudgetMs = Math.max(0, durationMs - clickMs);
  const from = pointer.isHidden() ? null : pointer.lastPoint();
  const aim = destination().point;
  // Never squeezed below one quick stroke, even when a late start left no
  // budget: a hand does not teleport.
  const travelMs = from
    ? Math.min(
        Math.max(travelBudgetMs, MIN_TRAVEL_MS),
        pointerAimDurationMs(Math.hypot(aim.x - from.x, aim.y - from.y)),
      )
    : 0;
  const restMs = travelBudgetMs - travelMs - (performance.now() - started);
  if (restMs > 0) {
    await abortableSleep(restMs, signal);
  }

  if (!from) {
    pointer.revealAt(roundPoint(destination().point));
  } else {
    await tween(travelMs, easePointerAim, signal, (eased) => {
      const { point, element } = destination();
      pointer.dispatch(
        Math.round(from.x + (point.x - from.x) * eased),
        Math.round(from.y + (point.y - from.y) * eased),
        element,
      );
    });
  }

  if (press) {
    // Rest on the control, then click it: press, hold, release. Only the
    // recorded button state changes — no pointerdown/click reaches the
    // page, so the action itself stays the semantic command it always was.
    await abortableSleep(POINTER_SETTLE_MS, signal);
    const { point, element } = destination();
    const { x, y } = roundPoint(point);
    pointer.dispatch(x, y, element, 1);
    await abortableSleep(POINTER_PRESS_MS, signal);
    pointer.dispatch(x, y, element, 0);
  }

  return { target: describeStudioTarget(target), travelMs, pressed: press };
}
