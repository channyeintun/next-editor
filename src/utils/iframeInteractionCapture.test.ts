import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createIframeInteractionCaptureScript,
  IFRAME_INTERACTION_MESSAGE_TYPE,
} from "./iframeInteractionCapture";

const SETUP_MARKER = "__TEST_INTERACTION_CAPTURE__";
const CLEANUP_MARKER = `${SETUP_MARKER}:cleanup`;

class FakeElement {
  readonly tagName: string;
  readonly id: string;
  children: FakeElement[] = [];
  className = "";
  parentElement: FakeElement | null = null;

  constructor(tagName: string, id = "") {
    this.tagName = tagName;
    this.id = id;
  }
}

class FakeInputElement extends FakeElement {
  value = "";
}

class FakeTextAreaElement extends FakeElement {
  value = "";
}

type Listener = (event: Record<string, unknown>) => void;

function createListenerTarget() {
  const listeners = new Map<string, Set<Listener>>();

  return {
    addEventListener(type: string, listener: Listener) {
      const listenersForType = listeners.get(type) ?? new Set<Listener>();
      listenersForType.add(listener);
      listeners.set(type, listenersForType);
    },
    emit(type: string, event: Record<string, unknown>) {
      listeners.get(type)?.forEach((listener) => listener(event));
    },
    hasListener(type: string) {
      return Boolean(listeners.get(type)?.size);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
  };
}

function createCaptureHarness() {
  const parentPostMessage = vi.fn<(message: unknown, targetOrigin: string) => void>();
  const documentTarget = createListenerTarget();
  const windowTarget = createListenerTarget();
  const body = new FakeElement("BODY");
  const button = new FakeElement("BUTTON", "target");
  body.children.push(button);
  button.parentElement = body;

  const frameDocument = {
    ...documentTarget,
    body,
    documentElement: new FakeElement("HTML"),
    scrollingElement: { scrollLeft: 0, scrollTop: 0 },
  };
  const frameWindow = {
    ...windowTarget,
    cancelAnimationFrame: vi.fn<(id: number) => void>(),
    history: {
      pushState: vi.fn<() => void>(),
      replaceState: vi.fn<() => void>(),
    },
    location: {
      hash: "",
      href: "https://preview.test/",
      pathname: "/",
      search: "",
    },
    innerHeight: 600,
    innerWidth: 800,
    parent: {
      postMessage: parentPostMessage,
    },
    requestAnimationFrame: vi.fn<(callback: FrameRequestCallback) => number>((callback) => {
      callback(0);
      return 1;
    }),
  } as Record<string, unknown>;

  const install = new Function(
    "window",
    "document",
    "Element",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    createIframeInteractionCaptureScript(SETUP_MARKER),
  );
  const installWithRouteCapture = new Function(
    "window",
    "document",
    "Element",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    createIframeInteractionCaptureScript(SETUP_MARKER, { includeRouteChange: true }),
  );
  const installWithMouseMoveCapture = new Function(
    "window",
    "document",
    "Element",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    createIframeInteractionCaptureScript(SETUP_MARKER, { includeMouseMove: true }),
  );

  const installArgs = [
    frameWindow,
    frameDocument,
    FakeElement,
    FakeInputElement,
    FakeTextAreaElement,
  ] as const;

  return {
    button,
    documentTarget,
    frameWindow,
    install: () => install(...installArgs),
    installWithRouteCapture: () => installWithRouteCapture(...installArgs),
    installWithMouseMoveCapture: () => installWithMouseMoveCapture(...installArgs),
    parentPostMessage,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createIframeInteractionCaptureScript", () => {
  it("removes injected document listeners when the generated cleanup runs", () => {
    const { button, documentTarget, frameWindow, install, parentPostMessage } =
      createCaptureHarness();

    install();
    documentTarget.emit("click", {
      button: 0,
      clientX: 12,
      clientY: 34,
      target: button,
    });

    expect(parentPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          data: expect.objectContaining({ clientX: 12, clientY: 34 }),
          type: "click",
        }),
        type: IFRAME_INTERACTION_MESSAGE_TYPE,
      }),
      "*",
    );

    const cleanup = frameWindow[CLEANUP_MARKER];
    expect(typeof cleanup).toBe("function");

    (cleanup as () => void)();
    parentPostMessage.mockClear();

    expect(documentTarget.hasListener("click")).toBe(false);
    documentTarget.emit("click", {
      button: 0,
      clientX: 56,
      clientY: 78,
      target: button,
    });

    expect(parentPostMessage).not.toHaveBeenCalled();
    expect(frameWindow[SETUP_MARKER]).toBeUndefined();
    expect(frameWindow[CLEANUP_MARKER]).toBeUndefined();
  });

  it("restores wrapped history methods when the generated cleanup runs", () => {
    const { frameWindow, installWithRouteCapture } = createCaptureHarness();
    const history = frameWindow.history as {
      pushState: () => void;
      replaceState: () => void;
    };
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    installWithRouteCapture();

    expect(history.pushState).not.toBe(originalPushState);
    expect(history.replaceState).not.toBe(originalReplaceState);

    const cleanup = frameWindow[CLEANUP_MARKER] as () => void;
    cleanup();

    expect(history.pushState).toBe(originalPushState);
    expect(history.replaceState).toBe(originalReplaceState);
  });

  it("emits mousemove coordinates with iframe viewport dimensions when enabled", () => {
    const { button, documentTarget, installWithMouseMoveCapture, parentPostMessage } =
      createCaptureHarness();

    installWithMouseMoveCapture();
    documentTarget.emit("mousemove", {
      buttons: 1,
      clientX: 200,
      clientY: 150,
      target: button,
    });

    expect(parentPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          data: expect.objectContaining({
            buttons: 1,
            clientX: 200,
            clientY: 150,
            windowHeight: 600,
            windowWidth: 800,
          }),
          type: "mousemove",
        }),
        type: IFRAME_INTERACTION_MESSAGE_TYPE,
      }),
      "*",
    );
  });
});
