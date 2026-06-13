import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createCursorPositionFromClientPoint,
  resolveCursorViewportPosition,
} from "./cursorCoordinates";

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

describe("cursorCoordinates", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("records points relative to the closest cursor replay target", () => {
    const target = document.createElement("div");
    const child = document.createElement("button");

    target.setAttribute("data-cursor-replay-target", "code-editor");
    target.appendChild(child);
    document.body.appendChild(target);
    mockRect(target, { left: 100, top: 50, width: 400, height: 300 });

    const cursor = createCursorPositionFromClientPoint({
      clientX: 300,
      clientY: 200,
      visible: true,
      eventTarget: child,
    });

    expect(cursor).toEqual({
      x: 300,
      y: 200,
      visible: true,
      target: {
        id: "code-editor",
        x: 200,
        y: 150,
        rect: { left: 100, top: 50, width: 400, height: 300 },
      },
    });
  });

  it("resolves a recorded relative point against the current target size", () => {
    const target = document.createElement("div");

    target.setAttribute("data-cursor-replay-target", "preview-frame");
    document.body.appendChild(target);
    mockRect(target, { left: 100, top: 50, width: 400, height: 300 });

    const recordedCursor = createCursorPositionFromClientPoint({
      clientX: 300,
      clientY: 200,
      visible: true,
      targetElement: target,
    });

    mockRect(target, { left: 20, top: 10, width: 800, height: 600 });

    expect(resolveCursorViewportPosition(recordedCursor)).toEqual({
      x: 420,
      y: 310,
    });
  });
});
