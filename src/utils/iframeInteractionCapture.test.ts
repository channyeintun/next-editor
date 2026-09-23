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
  testId = "";

  constructor(tagName: string, id = "") {
    this.tagName = tagName;
    this.id = id;
  }

  attributes = new Map<string, string>();

  getAttribute(name: string) {
    return name === "data-testid" ? this.testId || null : (this.attributes.get(name) ?? null);
  }

  hasAttribute(name: string) {
    return this.getAttribute(name) !== null;
  }
}

class FakeInputElement extends FakeElement {
  type = "text";
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
  button.testId = "submit";
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

  const createInput = (type: string) => {
    const input = new FakeInputElement("INPUT");
    input.type = type;
    body.children.push(input);
    input.parentElement = body;
    return input;
  };

  return {
    button,
    createInput,
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

  it("serializes SVG className to a string so postMessage can clone it", () => {
    const { button, documentTarget, install, parentPostMessage } = createCaptureHarness();

    // SVG elements expose className as an SVGAnimatedString rather than a plain
    // string; posting it verbatim throws a DataCloneError.
    (button as unknown as { className: unknown }).className = {
      baseVal: "icon stroke-current",
    };

    install();
    documentTarget.emit("click", {
      button: 0,
      clientX: 5,
      clientY: 6,
      target: button,
    });

    expect(parentPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          target: expect.objectContaining({
            className: "icon stroke-current",
            testId: "submit",
          }),
          type: "click",
        }),
        type: IFRAME_INTERACTION_MESSAGE_TYPE,
      }),
      "*",
    );
  });

  it("masks password values and keys the way the rrweb recorder does", () => {
    const { createInput, documentTarget, install, parentPostMessage } = createCaptureHarness();
    const password = createInput("password");
    const text = createInput("text");
    // rrweb marks a password field whose type was later switched ("show
    // password") and keeps masking it; the interaction track must agree.
    const revealed = createInput("text");
    revealed.attributes.set("data-rr-is-password", "true");

    install();
    documentTarget.emit("keydown", { code: "KeyS", key: "s", target: password });
    documentTarget.emit("keyup", { code: "KeyS", key: "s", target: password });
    password.value = "s3cret";
    documentTarget.emit("input", { target: password });
    revealed.value = "hunter2";
    documentTarget.emit("input", { target: revealed });
    documentTarget.emit("keydown", { code: "KeyA", key: "a", target: text });
    text.value = "Ada";
    documentTarget.emit("input", { target: text });

    const payloads = parentPostMessage.mock.calls.map(
      ([message]) =>
        (message as { payload: { type: string; data: Record<string, unknown> } }).payload,
    );
    const [passwordKeyDown, passwordKeyUp, passwordInput, revealedInput, textKeyDown, textInput] =
      payloads;

    expect(passwordKeyDown.type).toBe("keydown");
    expect(passwordKeyDown.data).not.toHaveProperty("key");
    expect(passwordKeyDown.data).not.toHaveProperty("code");
    expect(passwordKeyUp.type).toBe("keyup");
    expect(passwordKeyUp.data).not.toHaveProperty("key");
    expect(passwordInput.data.value).toBe("******");
    expect(revealedInput.data.value).toBe("*******");
    expect(textKeyDown.data).toMatchObject({ code: "KeyA", key: "a" });
    expect(textInput.data.value).toBe("Ada");
    expect(JSON.stringify(payloads)).not.toMatch(/s3cret|hunter2/);
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
