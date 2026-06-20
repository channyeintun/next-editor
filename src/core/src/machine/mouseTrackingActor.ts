import { fromCallback } from "xstate";
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
import { IFRAME_INTERACTION_MESSAGE_TYPE } from "../../../utils/iframeInteractionCapture";

// ============================================================================
// Mouse Tracking Actor
//
// A long-lived xstate callback actor that watches pointer movement across the
// host document and every (same-origin) preview iframe, normalizes each point to
// the recording root's coordinate space, and reports it via `input.onMouseMove`.
// Cross-origin iframes can't be listened to directly, so they report through
// postMessage (see `handleIframeInteractionMessage`). All listeners and observers
// are torn down in the returned cleanup function.
// ============================================================================

interface MouseTrackingInput {
  onMouseMove: (pos: MouseCursorPosition) => void;
}

export const mouseTrackingActor = fromCallback<{ type: "STOP" }, MouseTrackingInput>(
  ({ input }) => {
    let forceRecordedCursorHidden = false;
    const supportsPointerEvents = typeof window !== "undefined" && "PointerEvent" in window;

    const getRootElement = (): Element | null =>
      document.querySelector(
        `[${CURSOR_REPLAY_TARGET_ATTRIBUTE}="${CURSOR_REPLAY_ROOT_TARGET_ID}"]`,
      );

    const shouldCaptureTarget = (target: EventTarget | null): boolean => {
      const rootElement = getRootElement();
      if (!rootElement || !(target instanceof Node)) return true;

      return rootElement.contains(target);
    };

    const getPointerFlags = (event: MouseEvent): number =>
      Number.isFinite(event.buttons) ? event.buttons : 0;

    const getPointerAngle = (event: MouseEvent): number | undefined => {
      const pointerEvent = event as Partial<PointerEvent>;
      if (typeof pointerEvent.tiltX !== "number" || typeof pointerEvent.tiltY !== "number") {
        return undefined;
      }

      return Math.atan2(pointerEvent.tiltY, pointerEvent.tiltX);
    };

    const getPointerPressure = (event: MouseEvent): number | undefined => {
      const pressure = (event as Partial<PointerEvent>).pressure;
      return typeof pressure === "number" ? pressure : undefined;
    };

    const handlePointerEvent = (e: MouseEvent) => {
      if (!shouldCaptureTarget(e.target)) {
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
        }),
      );
    };

    const handleMouseLeave = () => {
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
        }),
      );
    };

    // Handle iframe mouse tracking
    type IframeMouseListeners = {
      document: Document;
      move: (e: MouseEvent) => void;
      down: (e: MouseEvent) => void;
      up: (e: MouseEvent) => void;
      leave: () => void;
    };

    const iframeListeners = new Map<HTMLIFrameElement, IframeMouseListeners>();
    const iframeLoadHandlers = new Map<HTMLIFrameElement, () => void>();
    const iframeWindowMap = new Map<Window, HTMLIFrameElement>();
    const iframeWindows = new Map<HTMLIFrameElement, Window>();
    const directlyTrackedIframes = new Set<HTMLIFrameElement>();

    const removeIframeDocumentListeners = (handlers: IframeMouseListeners) => {
      if (supportsPointerEvents) {
        handlers.document.removeEventListener("pointermove", handlers.move, true);
        handlers.document.removeEventListener("pointerdown", handlers.down, true);
        handlers.document.removeEventListener("pointerup", handlers.up, true);
      } else {
        handlers.document.removeEventListener("mousemove", handlers.move, true);
        handlers.document.removeEventListener("mousedown", handlers.down, true);
        handlers.document.removeEventListener("mouseup", handlers.up, true);
      }

      handlers.document.removeEventListener("mouseleave", handlers.leave, true);
    };

    const getIframeViewportSize = (
      iframe: HTMLIFrameElement,
    ): { width: number; height: number } => {
      try {
        const iframeWindow = iframe.contentWindow;
        const iframeDocument = iframe.contentDocument || iframeWindow?.document;
        const documentElement = iframeDocument?.documentElement;

        return {
          width: iframeWindow?.innerWidth || documentElement?.clientWidth || 0,
          height: iframeWindow?.innerHeight || documentElement?.clientHeight || 0,
        };
      } catch {
        return { width: 0, height: 0 };
      }
    };

    const toParentClientPoint = (
      iframe: HTMLIFrameElement,
      clientX: number,
      clientY: number,
      viewportWidth?: number,
      viewportHeight?: number,
    ): { clientX: number; clientY: number } => {
      const rect = iframe.getBoundingClientRect();
      const width = viewportWidth && viewportWidth > 0 ? viewportWidth : rect.width;
      const height = viewportHeight && viewportHeight > 0 ? viewportHeight : rect.height;

      return {
        clientX: rect.left + clientX * (rect.width / Math.max(width, 1)),
        clientY: rect.top + clientY * (rect.height / Math.max(height, 1)),
      };
    };

    const rememberIframeWindow = (iframe: HTMLIFrameElement) => {
      const iframeWindow = iframe.contentWindow;

      if (iframeWindow) {
        const previousWindow = iframeWindows.get(iframe);

        if (previousWindow && previousWindow !== iframeWindow) {
          iframeWindowMap.delete(previousWindow);
        }

        iframeWindows.set(iframe, iframeWindow);
        iframeWindowMap.set(iframeWindow, iframe);
      }
    };

    const forgetIframeWindow = (iframe: HTMLIFrameElement) => {
      const iframeWindow = iframeWindows.get(iframe);

      if (iframeWindow && iframeWindowMap.get(iframeWindow) === iframe) {
        iframeWindowMap.delete(iframeWindow);
      }

      iframeWindows.delete(iframe);
    };

    const setupIframeListeners = (iframe: HTMLIFrameElement) => {
      removeIframeListeners(iframe);
      rememberIframeWindow(iframe);

      const onIframePointerEvent = (e: MouseEvent) => {
        const viewport = getIframeViewportSize(iframe);
        const point = toParentClientPoint(
          iframe,
          e.clientX,
          e.clientY,
          viewport.width,
          viewport.height,
        );

        input.onMouseMove(
          createCursorPositionFromClientPoint({
            clientX: point.clientX,
            clientY: point.clientY,
            visible: !forceRecordedCursorHidden,
            flags: getPointerFlags(e),
            angle: getPointerAngle(e),
            pressure: getPointerPressure(e),
            targetElement: iframe,
          }),
        );
      };

      const onIframeMouseLeave = () => {
        input.onMouseMove({ x: 0, y: 0, visible: false });
      };

      const attachToDocument = () => {
        const existing = iframeListeners.get(iframe);
        if (existing) {
          removeIframeDocumentListeners(existing);
          iframeListeners.delete(iframe);
        }

        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!iframeDoc) {
            directlyTrackedIframes.delete(iframe);
            return;
          }

          if (supportsPointerEvents) {
            iframeDoc.addEventListener("pointermove", onIframePointerEvent, true);
            iframeDoc.addEventListener("pointerdown", onIframePointerEvent, true);
            iframeDoc.addEventListener("pointerup", onIframePointerEvent, true);
          } else {
            iframeDoc.addEventListener("mousemove", onIframePointerEvent, true);
            iframeDoc.addEventListener("mousedown", onIframePointerEvent, true);
            iframeDoc.addEventListener("mouseup", onIframePointerEvent, true);
          }

          iframeDoc.addEventListener("mouseleave", onIframeMouseLeave, true);
          directlyTrackedIframes.add(iframe);

          iframeListeners.set(iframe, {
            document: iframeDoc,
            move: onIframePointerEvent,
            down: onIframePointerEvent,
            up: onIframePointerEvent,
            leave: onIframeMouseLeave,
          });
        } catch (err) {
          // Cross-origin iframes can't be accessed directly; this is expected.
          // They are tracked instead via postMessage (see handleIframeInteractionMessage),
          // so swallow the SecurityError silently and only surface unexpected errors.
          directlyTrackedIframes.delete(iframe);
          if (!(err instanceof DOMException && err.name === "SecurityError")) {
            console.error("Cannot track mouse in iframe:", err);
          }
        }
      };

      const handleLoad = () => {
        attachToDocument();
      };

      iframe.addEventListener("load", handleLoad);
      iframeLoadHandlers.set(iframe, handleLoad);
      attachToDocument();
    };

    const removeIframeListeners = (iframe: HTMLIFrameElement) => {
      directlyTrackedIframes.delete(iframe);
      forgetIframeWindow(iframe);

      const handlers = iframeListeners.get(iframe);
      const loadHandler = iframeLoadHandlers.get(iframe);

      if (loadHandler) {
        iframe.removeEventListener("load", loadHandler);
        iframeLoadHandlers.delete(iframe);
      }

      if (handlers) {
        try {
          removeIframeDocumentListeners(handlers);
        } catch (err) {
          console.error("Error removing iframe listeners:", err);
        }
        iframeListeners.delete(iframe);
      }
    };

    const handleIframeInteractionMessage = (event: MessageEvent) => {
      const { type, payload } = event.data || {};
      if (type !== IFRAME_INTERACTION_MESSAGE_TYPE) {
        return;
      }

      if (payload?.type !== "mousemove") {
        return;
      }

      if (
        typeof payload?.data?.clientX !== "number" ||
        typeof payload?.data?.clientY !== "number"
      ) {
        return;
      }

      const sourceWindow = event.source as Window | null;
      if (!sourceWindow) {
        return;
      }

      const iframe = iframeWindowMap.get(sourceWindow);
      if (!iframe || directlyTrackedIframes.has(iframe)) {
        return;
      }

      const point = toParentClientPoint(
        iframe,
        payload.data.clientX,
        payload.data.clientY,
        typeof payload.data.windowWidth === "number" ? payload.data.windowWidth : undefined,
        typeof payload.data.windowHeight === "number" ? payload.data.windowHeight : undefined,
      );

      input.onMouseMove(
        createCursorPositionFromClientPoint({
          clientX: point.clientX,
          clientY: point.clientY,
          visible: !forceRecordedCursorHidden,
          flags: typeof payload.data.buttons === "number" ? payload.data.buttons : 0,
          targetElement: iframe,
        }),
      );
    };

    // Listen for new iframes and content changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "childList") {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLIFrameElement) {
              setupIframeListeners(node);
            } else if (node instanceof HTMLElement) {
              node.querySelectorAll("iframe").forEach(setupIframeListeners);
            }
          });
          mutation.removedNodes.forEach((node) => {
            if (node instanceof HTMLIFrameElement) {
              removeIframeListeners(node);
            } else if (node instanceof HTMLElement) {
              node.querySelectorAll("iframe").forEach(removeIframeListeners);
            }
          });
        } else if (mutation.type === "attributes" && mutation.target instanceof HTMLIFrameElement) {
          if (mutation.attributeName === "src" || mutation.attributeName === "srcdoc") {
            setupIframeListeners(mutation.target);
          }
        }
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcdoc"],
    });

    // Initial setup
    document.querySelectorAll("iframe").forEach(setupIframeListeners);
    if (supportsPointerEvents) {
      document.addEventListener("pointermove", handlePointerEvent, true);
      document.addEventListener("pointerdown", handlePointerEvent, true);
      document.addEventListener("pointerup", handlePointerEvent, true);
    } else {
      document.addEventListener("mousemove", handlePointerEvent, true);
      document.addEventListener("mousedown", handlePointerEvent, true);
      document.addEventListener("mouseup", handlePointerEvent, true);
    }

    document.addEventListener("mouseleave", handleMouseLeave, true);
    window.addEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, handleRecordedCursorVisibility);
    window.addEventListener("message", handleIframeInteractionMessage);

    return () => {
      observer.disconnect();
      if (supportsPointerEvents) {
        document.removeEventListener("pointermove", handlePointerEvent, true);
        document.removeEventListener("pointerdown", handlePointerEvent, true);
        document.removeEventListener("pointerup", handlePointerEvent, true);
      } else {
        document.removeEventListener("mousemove", handlePointerEvent, true);
        document.removeEventListener("mousedown", handlePointerEvent, true);
        document.removeEventListener("mouseup", handlePointerEvent, true);
      }

      document.removeEventListener("mouseleave", handleMouseLeave, true);
      window.removeEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, handleRecordedCursorVisibility);
      window.removeEventListener("message", handleIframeInteractionMessage);

      // Clean up load listeners
      iframeLoadHandlers.forEach((handler, iframe) => {
        iframe.removeEventListener("load", handler);
      });
      iframeLoadHandlers.clear();
      iframeWindowMap.clear();
      iframeWindows.clear();
      directlyTrackedIframes.clear();

      iframeListeners.forEach((handlers) => {
        try {
          removeIframeDocumentListeners(handlers);
        } catch (err) {
          console.error("Failed to cleanup iframe listeners:", err);
        }
      });
      iframeListeners.clear();
    };
  },
);
