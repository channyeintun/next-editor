import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor } from "xstate";
import type { MouseCursorPosition } from "../types";
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

const pointerMoveType = "PointerEvent" in window ? "pointermove" : "mousemove";

describe("mouseTrackingActor", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
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
});
