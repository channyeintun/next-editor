import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor } from "xstate";
import type { MouseCursorPosition } from "../types";
import { IFRAME_INTERACTION_MESSAGE_TYPE } from "../../../utils/iframeInteractionCapture";
import { RECORDED_CURSOR_VISIBILITY_EVENT } from "../../../utils/recordedCursorVisibility";
import { mouseTrackingActor } from "./mouseTrackingActor";

function mockRect(
  element: Element,
  rect: { left: number; top: number; width: number; height: number },
): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...rect,
      x: rect.left,
      y: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      toJSON: () => rect,
    }),
  });
}

const pointerEventTypes =
  "PointerEvent" in window
    ? ["pointermove", "pointerdown", "pointerup"]
    : ["mousemove", "mousedown", "mouseup"];
const [pointerMoveType] = pointerEventTypes;

function firePointer(target: EventTarget, type = pointerMoveType): void {
  target.dispatchEvent(new MouseEvent(type, { clientX: 64, clientY: 48, bubbles: true }));
}

function fireMouseLeave(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent("mouseleave"));
}

// The actor finds added and removed iframes with a MutationObserver, whose
// callback runs in a microtask.
const flushMutations = () => Promise.resolve();

describe("mouseTrackingActor", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const renderApp = () => {
    const app = document.createElement("div");
    const editor = document.createElement("div");
    const line = document.createElement("span");
    app.setAttribute("data-cursor-replay-target", "app");
    editor.setAttribute("data-cursor-replay-target", "code-editor");
    editor.appendChild(line);
    app.appendChild(editor);
    document.body.appendChild(app);
    mockRect(app, { left: 50, top: 25, width: 900, height: 600 });
    mockRect(editor, { left: 150, top: 75, width: 400, height: 300 });
    return { line };
  };

  // jsdom gives an attached iframe a same-origin about:blank document and a
  // 1024x768 window, so the frame below shows it at half size.
  //
  // The actor adds the frame's listeners with an AbortSignal. Vitest swaps the
  // page's AbortController for Node's and patches only the top window's
  // addEventListener to accept Node signals, so the frame's document rejects
  // them. A browser accepts a signal from any window, and jsdom does too when
  // the signal is its own, so jsdom's AbortController from the frame stands in.
  const renderFrame = () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    mockRect(iframe, { left: 100, top: 75, width: 512, height: 384 });
    const frameWindow = iframe.contentWindow as (Window & typeof globalThis) | null;
    if (!frameWindow) throw new Error("the iframe has no window");
    vi.stubGlobal("AbortController", frameWindow.AbortController);
    return iframe;
  };

  // Reading a cross-origin frame's document throws, so it reports moves by
  // postMessage instead.
  const renderCrossOriginFrame = () => {
    const iframe = renderFrame();
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      get: () => {
        throw new DOMException("Blocked a cross-origin frame", "SecurityError");
      },
    });
    return iframe;
  };

  const postFrameMove = (iframe: HTMLIFrameElement, data: Record<string, number>) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        data: { type: IFRAME_INTERACTION_MESSAGE_TYPE, payload: { type: "mousemove", data } },
      }),
    );
  };

  const getFrameDocument = (iframe: HTMLIFrameElement): Document => {
    const frameDocument = iframe.contentDocument;
    if (!frameDocument) throw new Error("the iframe has no document");
    return frameDocument;
  };

  // jsdom clears every listener on a frame's own document when the frame is
  // removed or navigates. A document jsdom does not own keeps its listeners, so
  // only the actor can detach from it.
  const giveFrameDocument = (iframe: HTMLIFrameElement): Document => {
    const frameDocument = document.implementation.createHTMLDocument("");
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      get: () => frameDocument,
    });
    return frameDocument;
  };

  it("looks the app root up once per pointer move", () => {
    const { line } = renderApp();
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();
    const querySelector = vi.spyOn(document, "querySelector");
    const querySelectorAll = vi.spyOn(document, "querySelectorAll");

    line.dispatchEvent(
      new MouseEvent(pointerMoveType, { clientX: 300, clientY: 200, bubbles: true }),
    );

    expect(onMouseMove).toHaveBeenCalledTimes(1);
    expect(onMouseMove.mock.calls[0][0]).toMatchObject({
      x: 250,
      y: 175,
      visible: true,
      coordinateSpace: "root",
      hover: "code-editor",
      target: { id: "code-editor", x: 150, y: 125 },
    });
    expect(querySelector).toHaveBeenCalledTimes(1);
    expect(querySelectorAll).not.toHaveBeenCalled();
    actor.stop();
  });

  it("ignores a pointer move outside the app root", () => {
    renderApp();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();

    outside.dispatchEvent(
      new MouseEvent(pointerMoveType, { clientX: 10, clientY: 10, bubbles: true }),
    );

    expect(onMouseMove).not.toHaveBeenCalled();
    actor.stop();
  });

  it("hides the cursor only when the pointer leaves the page", () => {
    const { line } = renderApp();
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();

    // The capture listener on the document also sees leaves from its elements,
    // and the body's when the pointer only moves below a short body.
    fireMouseLeave(line);
    fireMouseLeave(document.body);

    expect(onMouseMove).not.toHaveBeenCalled();

    fireMouseLeave(document.documentElement);

    expect(onMouseMove).toHaveBeenCalledTimes(1);
    expect(onMouseMove).toHaveBeenLastCalledWith({ x: 0, y: 0, visible: false });
    actor.stop();
  });

  it("reports a pointer move inside a same-origin iframe once, in page coordinates", () => {
    renderApp();
    const iframe = renderFrame();
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();

    firePointer(getFrameDocument(iframe).body);

    // (100 + 64 / 2, 75 + 48 / 2), relative to the app root at (50, 25).
    expect(onMouseMove).toHaveBeenCalledTimes(1);
    expect(onMouseMove.mock.calls[0][0]).toMatchObject({ x: 82, y: 74, visible: true });
    actor.stop();
  });

  it("leaves hiding the cursor to the page when the pointer leaves a same-origin iframe", () => {
    renderApp();
    const frameDocument = getFrameDocument(renderFrame());
    const button = frameDocument.createElement("button");
    frameDocument.body.appendChild(button);
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();

    // The frame's root also gets a mouseleave when the pointer only moves on
    // to the page, and its body when the pointer moves below a short body.
    fireMouseLeave(button);
    fireMouseLeave(frameDocument.body);
    fireMouseLeave(frameDocument.documentElement);

    expect(onMouseMove).not.toHaveBeenCalled();

    // Leaving the window from inside the frame sends the page's root a
    // mouseleave too.
    fireMouseLeave(document.documentElement);

    expect(onMouseMove).toHaveBeenCalledTimes(1);
    expect(onMouseMove).toHaveBeenLastCalledWith({ x: 0, y: 0, visible: false });
    actor.stop();
  });

  it("tracks an iframe added after the actor starts", async () => {
    renderApp();
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();
    const iframe = renderFrame();
    await flushMutations();

    firePointer(getFrameDocument(iframe).body);

    expect(onMouseMove).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("still reports a move once after the iframe fires load again", () => {
    renderApp();
    const iframe = renderFrame();
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();

    iframe.dispatchEvent(new Event("load"));
    iframe.dispatchEvent(new Event("load"));
    firePointer(getFrameDocument(iframe).body);

    expect(onMouseMove).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("moves its listeners to the new document when the iframe loads one", () => {
    renderApp();
    const iframe = renderFrame();
    const firstDocument = giveFrameDocument(iframe);
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();

    const nextDocument = giveFrameDocument(iframe);
    iframe.dispatchEvent(new Event("load"));
    firePointer(firstDocument.body);

    expect(onMouseMove).not.toHaveBeenCalled();

    firePointer(nextDocument.body);

    expect(onMouseMove).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("drops the old listeners when the iframe's src changes", async () => {
    renderApp();
    const iframe = renderFrame();
    const frameDocument = giveFrameDocument(iframe);
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();

    // jsdom does not load srcdoc, so the frame keeps its document; the actor
    // still sets the frame up again with new handlers. A load listener left from
    // the first setup would attach the old handler again here.
    iframe.setAttribute("srcdoc", "<p>next</p>");
    await flushMutations();
    iframe.dispatchEvent(new Event("load"));
    firePointer(frameDocument.body);

    expect(onMouseMove).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("stops reporting moves from an iframe removed from the page", async () => {
    renderApp();
    const iframe = renderFrame();
    const frameDocument = giveFrameDocument(iframe);
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();

    firePointer(frameDocument.body);
    iframe.remove();
    await flushMutations();
    firePointer(frameDocument.body);

    expect(onMouseMove).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("stops reporting iframe events after the actor stops", () => {
    renderApp();
    const iframe = renderFrame();
    const frameDocument = getFrameDocument(iframe);
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();
    const fireFrameEvents = () => {
      for (const type of pointerEventTypes) firePointer(frameDocument.body, type);
    };

    fireFrameEvents();

    expect(onMouseMove).toHaveBeenCalledTimes(3);

    actor.stop();
    fireFrameEvents();
    iframe.dispatchEvent(new Event("load"));
    fireFrameEvents();

    expect(onMouseMove).toHaveBeenCalledTimes(3);
  });

  it("stops reporting page and window events after the actor stops", () => {
    const { line } = renderApp();
    const crossOriginFrame = renderCrossOriginFrame();
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();
    const firePageEvents = () => {
      for (const type of pointerEventTypes) firePointer(line, type);
      fireMouseLeave(document.documentElement);
      window.dispatchEvent(
        new CustomEvent(RECORDED_CURSOR_VISIBILITY_EVENT, {
          detail: { x: 300, y: 200, visible: true },
        }),
      );
      postFrameMove(crossOriginFrame, { clientX: 64, clientY: 48 });
    };

    firePageEvents();

    expect(onMouseMove).toHaveBeenCalledTimes(6);

    actor.stop();
    firePageEvents();

    expect(onMouseMove).toHaveBeenCalledTimes(6);
  });

  it("drops a cross-origin frame's move whose point is not a finite number", () => {
    renderApp();
    const iframe = renderCrossOriginFrame();
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();

    postFrameMove(iframe, { clientX: Number.NaN, clientY: 48 });
    postFrameMove(iframe, { clientX: 64, clientY: Number.POSITIVE_INFINITY });

    expect(onMouseMove).not.toHaveBeenCalled();

    postFrameMove(iframe, { clientX: 64, clientY: 48 });

    expect(onMouseMove).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("falls back for a cross-origin frame's size and buttons that are not finite", () => {
    renderApp();
    const iframe = renderCrossOriginFrame();
    const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
    const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();

    postFrameMove(iframe, {
      clientX: 64,
      clientY: 48,
      windowWidth: Number.POSITIVE_INFINITY,
      windowHeight: Number.NaN,
      buttons: Number.NaN,
    });

    // Without a size the frame's own box is its viewport: (100 + 64, 75 + 48),
    // relative to the app root at (50, 25).
    expect(onMouseMove).toHaveBeenCalledTimes(1);
    expect(onMouseMove.mock.calls[0][0]).toMatchObject({ x: 114, y: 98, flags: 0 });
    actor.stop();
  });

  it("listens to mouse events instead when the browser has no pointer events", () => {
    const pointerEvent = Object.getOwnPropertyDescriptor(window, "PointerEvent");
    Reflect.deleteProperty(window, "PointerEvent");
    try {
      const { line } = renderApp();
      const frameDocument = getFrameDocument(renderFrame());
      const onMouseMove = vi.fn<(position: MouseCursorPosition) => void>();
      const actor = createActor(mouseTrackingActor, { input: { onMouseMove } }).start();
      const fireMouseEvents = () => {
        for (const type of ["mousemove", "mousedown", "mouseup"]) {
          firePointer(line, type);
          firePointer(frameDocument.body, type);
        }
      };

      fireMouseEvents();
      firePointer(line, "pointermove");
      firePointer(frameDocument.body, "pointermove");

      expect(onMouseMove).toHaveBeenCalledTimes(6);

      actor.stop();
      fireMouseEvents();

      expect(onMouseMove).toHaveBeenCalledTimes(6);
    } finally {
      if (pointerEvent) Object.defineProperty(window, "PointerEvent", pointerEvent);
    }
  });
});
