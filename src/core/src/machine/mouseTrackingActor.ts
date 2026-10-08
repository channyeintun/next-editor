import { fromCallback, type EventObject } from "xstate";
import type { MouseCursorPosition } from "../types";
import {
  CURSOR_REPLAY_ROOT_TARGET_ID,
  CURSOR_REPLAY_TARGET_ATTRIBUTE,
  createCursorPositionFromClientPoint,
} from "../utils/cursorCoordinates";
import {
  isRecordedCursorVisibilityDetail,
  RECORDED_CURSOR_VISIBILITY_EVENT,
} from "../../../utils/recordedCursorVisibility";
import { startIframeCursorTracking } from "./iframeCursorTracking";

// ============================================================================
// Mouse Tracking Actor
//
// A long-lived xstate callback actor that watches pointer movement across the
// host document and every preview iframe, normalizes each point to the
// recording root's coordinate space, and reports it via `input.onMouseMove`.
// The preview iframes are tracked by `startIframeCursorTracking`
// (iframeCursorTracking.ts), which reports their points in page coordinates.
// Every host listener is added with an AbortSignal, so the returned cleanup
// removes them all by aborting, after disposing of the iframe tracking.
// ============================================================================

interface MouseTrackingInput {
  onMouseMove: (pos: MouseCursorPosition) => void;
}

/**
 * True only when the pointer actually left the page.
 *
 * `mouseleave` does not bubble, but a *capture*-phase listener on `document`
 * still sees every descendant's leave — so crossing out of any hovered element
 * (a toolbar button, a file row, a Monaco view-line being re-rendered) used to
 * record a `{0, 0, hidden}` cursor sample. Those bypass the movement throttle
 * (visibility changed), force an extra frame each, and break interpolation in
 * `getCursorPositionAtTime`, which refuses to tween across a visibility flip.
 * Worst case the pointer is stationary when the node under it is removed, so no
 * `pointermove` corrects it and the replayed cursor stays hidden for the rest of
 * that stretch. Leaving the viewport for real does target the root element.
 * Only the host page uses it. Preview iframes have no mouseleave listener (see
 * `attachToDocument` in iframeCursorTracking.ts).
 */
function isPageBoundaryLeave(event: Event, doc: Document): boolean {
  return event.target === doc.documentElement || event.target === doc.body;
}

function getPointerFlags(event: MouseEvent): number {
  return Number.isFinite(event.buttons) ? event.buttons : 0;
}

function getPointerAngle(event: MouseEvent): number | undefined {
  const pointerEvent = event as Partial<PointerEvent>;
  if (typeof pointerEvent.tiltX !== "number" || typeof pointerEvent.tiltY !== "number") {
    return undefined;
  }

  return Math.atan2(pointerEvent.tiltY, pointerEvent.tiltX);
}

function getPointerPressure(event: MouseEvent): number | undefined {
  const pressure = (event as Partial<PointerEvent>).pressure;
  return typeof pressure === "number" ? pressure : undefined;
}

// Nothing is sent to it: leaving `recording` stops it, which runs the cleanup. `never`
// would say so more precisely but does not satisfy xstate's actor-logic constraint.
type MouseTrackingEvent = EventObject;

export const mouseTrackingActor = fromCallback<MouseTrackingEvent, MouseTrackingInput>(
  ({ input }) => {
    let forceRecordedCursorHidden = false;
    const supportsPointerEvents = typeof window !== "undefined" && "PointerEvent" in window;
    // Move, down and up. A browser without pointer events sends the mouse events.
    const pointerEventTypes = supportsPointerEvents
      ? (["pointermove", "pointerdown", "pointerup"] as const)
      : (["mousemove", "mousedown", "mouseup"] as const);
    // Aborting it removes the host document and window listeners.
    const lifetime = new AbortController();

    // Each handler looks the root up once and passes it on as `rootElement`.
    // Without it createCursorPositionFromClientPoint finds the root again by
    // itself, and this runs on every pointer event, ahead of the machine's frame
    // throttle.
    const getRootElement = (): Element | null =>
      document.querySelector(
        `[${CURSOR_REPLAY_TARGET_ATTRIBUTE}="${CURSOR_REPLAY_ROOT_TARGET_ID}"]`,
      );

    const handlePointerEvent = (e: MouseEvent) => {
      const rootElement = getRootElement();
      if (rootElement && e.target instanceof Node && !rootElement.contains(e.target)) {
        return;
      }

      input.onMouseMove(
        createCursorPositionFromClientPoint({
          clientX: e.clientX,
          clientY: e.clientY,
          visible: !forceRecordedCursorHidden,
          flags: getPointerFlags(e),
          angle: getPointerAngle(e),
          pressure: getPointerPressure(e),
          eventTarget: e.target,
          rootElement,
        }),
      );
    };

    const handleMouseLeave = (event: Event) => {
      if (!isPageBoundaryLeave(event, document)) return;
      input.onMouseMove({ x: 0, y: 0, visible: false });
    };

    const handleRecordedCursorVisibility = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isRecordedCursorVisibilityDetail(event.detail)) {
        return;
      }

      forceRecordedCursorHidden = !event.detail.visible;
      input.onMouseMove(
        createCursorPositionFromClientPoint({
          clientX: event.detail.x,
          clientY: event.detail.y,
          visible: event.detail.visible,
          eventTarget:
            typeof document.elementFromPoint === "function"
              ? document.elementFromPoint(event.detail.x, event.detail.y)
              : null,
          rootElement: getRootElement(),
        }),
      );
    };

    // Set the preview iframes up first, then the host listeners.
    const stopIframeTracking = startIframeCursorTracking({
      pointerEventTypes,
      readPointer: (e) => ({
        flags: getPointerFlags(e),
        angle: getPointerAngle(e),
        pressure: getPointerPressure(e),
      }),
      onPoint: ({ iframe, ...point }) =>
        input.onMouseMove(
          createCursorPositionFromClientPoint({
            ...point,
            visible: !forceRecordedCursorHidden,
            targetElement: iframe,
            rootElement: getRootElement(),
          }),
        ),
    });
    for (const type of pointerEventTypes) {
      document.addEventListener(type, handlePointerEvent, {
        capture: true,
        signal: lifetime.signal,
      });
    }
    document.addEventListener("mouseleave", handleMouseLeave, {
      capture: true,
      signal: lifetime.signal,
    });
    window.addEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, handleRecordedCursorVisibility, {
      signal: lifetime.signal,
    });

    return () => {
      stopIframeTracking();
      lifetime.abort();
    };
  },
);
