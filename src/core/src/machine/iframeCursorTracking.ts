import { IFRAME_INTERACTION_MESSAGE_TYPE } from "../../../utils/iframeInteractionCapture";

// ============================================================================
// Iframe Cursor Tracking
//
// Watches pointer movement inside every preview iframe on the page and reports
// each point in the page's client coordinates via `onPoint`. Same-origin frames
// are listened to directly. Cross-origin frames can't be, so they report
// through postMessage (see `handleIframeInteractionMessage`). A
// MutationObserver picks up frames that are added, removed or given a new
// source. The returned disposer stops the observer and removes every listener.
// ============================================================================

// The events tracked: pointer events, or mouse events in a browser without
// them. Literal types keep each listener typed as taking a MouseEvent.
type TrackedPointerEventType =
  | "pointermove"
  | "pointerdown"
  | "pointerup"
  | "mousemove"
  | "mousedown"
  | "mouseup";

/** A pointer event inside `iframe`, at a point in the page's client coordinates. */
export interface IframePointerSample {
  iframe: HTMLIFrameElement;
  clientX: number;
  clientY: number;
  flags: number;
  angle?: number;
  pressure?: number;
}

interface IframeCursorTrackingOptions {
  pointerEventTypes: readonly TrackedPointerEventType[];
  readPointer: (event: MouseEvent) => { flags: number; angle?: number; pressure?: number };
  onPoint: (sample: IframePointerSample) => void;
}

export function startIframeCursorTracking(options: IframeCursorTrackingOptions): () => void {
  // Aborting it removes the window's message listener.
  const lifetime = new AbortController();

  // `frame` holds the iframe's load listener. `doc` holds the listeners on the
  // document the iframe shows now; a newly loaded document replaces it.
  type IframeScopes = { frame: AbortController; doc?: AbortController };

  const iframeScopes = new Map<HTMLIFrameElement, IframeScopes>();
  const iframeWindowMap = new Map<Window, HTMLIFrameElement>();
  // Caches each frame's window only so removal can still find it once the
  // frame has detached: its contentWindow is null by then.
  const iframeWindows = new Map<HTMLIFrameElement, Window>();
  const directlyTrackedIframes = new Set<HTMLIFrameElement>();

  const getIframeViewportSize = (iframe: HTMLIFrameElement): { width: number; height: number } => {
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
    const scopes: IframeScopes = { frame: new AbortController() };
    iframeScopes.set(iframe, scopes);

    const onIframePointerEvent = (e: MouseEvent) => {
      const viewport = getIframeViewportSize(iframe);
      const point = toParentClientPoint(
        iframe,
        e.clientX,
        e.clientY,
        viewport.width,
        viewport.height,
      );

      options.onPoint({
        iframe,
        clientX: point.clientX,
        clientY: point.clientY,
        ...options.readPointer(e),
      });
    };

    const attachToDocument = () => {
      scopes.doc?.abort();
      scopes.doc = new AbortController();
      const { signal } = scopes.doc;

      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) {
          directlyTrackedIframes.delete(iframe);
          return;
        }

        for (const type of options.pointerEventTypes) {
          iframeDoc.addEventListener(type, onIframePointerEvent, { capture: true, signal });
        }
        // No mouseleave listener on the frame. When the pointer leaves the
        // window from inside the frame, the page's root gets a mouseleave
        // too, and mouseTrackingActor's handleMouseLeave hides the cursor. The
        // frame's root also gets one when the pointer only moves on to the
        // page, and its body gets one when the pointer moves below a short
        // body. Both would hide a cursor that is still on screen.
        directlyTrackedIframes.add(iframe);
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

    iframe.addEventListener("load", attachToDocument, { signal: scopes.frame.signal });
    attachToDocument();
  };

  const removeIframeListeners = (iframe: HTMLIFrameElement) => {
    directlyTrackedIframes.delete(iframe);
    forgetIframeWindow(iframe);

    const scopes = iframeScopes.get(iframe);
    scopes?.frame.abort();
    scopes?.doc?.abort();
    iframeScopes.delete(iframe);
  };

  const handleIframeInteractionMessage = (event: MessageEvent) => {
    const { type, payload } = event.data || {};
    if (type !== IFRAME_INTERACTION_MESSAGE_TYPE) {
      return;
    }

    if (payload?.type !== "mousemove") {
      return;
    }

    if (typeof payload?.data?.clientX !== "number" || typeof payload?.data?.clientY !== "number") {
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

    options.onPoint({
      iframe,
      clientX: point.clientX,
      clientY: point.clientY,
      flags: typeof payload.data.buttons === "number" ? payload.data.buttons : 0,
    });
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
  window.addEventListener("message", handleIframeInteractionMessage, {
    signal: lifetime.signal,
  });

  return () => {
    observer.disconnect();
    lifetime.abort();
    iframeScopes.forEach((scopes) => {
      scopes.frame.abort();
      scopes.doc?.abort();
    });
    iframeScopes.clear();
    iframeWindowMap.clear();
    iframeWindows.clear();
    directlyTrackedIframes.clear();
  };
}
