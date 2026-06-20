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
      coordinateSpace: "viewport",
      hover: "code-editor",
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

  it("anchors a fixed-content target to its top-left instead of scaling on resize", () => {
    const target = document.createElement("div");

    target.setAttribute("data-cursor-replay-target", "code-editor");
    document.body.appendChild(target);
    mockRect(target, { left: 100, top: 50, width: 400, height: 300 });

    const recordedCursor = createCursorPositionFromClientPoint({
      clientX: 300,
      clientY: 200,
      visible: true,
      targetElement: target,
    });

    // The editor widens and shifts left (e.g. the file explorer was hidden). The
    // cursor must stay at the same offset from the editor's top-left, not slide
    // sideways in proportion to the new width.
    mockRect(target, { left: 20, top: 50, width: 800, height: 300 });

    expect(resolveCursorViewportPosition(recordedCursor)).toEqual({
      x: 220,
      y: 200,
    });
  });

  it("records points relative to the app root when present", () => {
    const app = document.createElement("div");
    const target = document.createElement("div");
    const child = document.createElement("button");

    app.setAttribute("data-cursor-replay-target", "app");
    target.setAttribute("data-cursor-replay-target", "code-editor");
    target.appendChild(child);
    app.appendChild(target);
    document.body.appendChild(app);

    mockRect(app, { left: 50, top: 25, width: 900, height: 600 });
    mockRect(target, { left: 150, top: 75, width: 400, height: 300 });

    const cursor = createCursorPositionFromClientPoint({
      clientX: 300.75,
      clientY: 200.25,
      visible: true,
      flags: 1,
      eventTarget: child,
    });

    expect(cursor).toEqual({
      x: 250,
      y: 175,
      visible: true,
      coordinateSpace: "root",
      flags: 1,
      hover: "code-editor",
      target: {
        id: "code-editor",
        x: 150,
        y: 125,
        rect: { left: 100, top: 50, width: 400, height: 300 },
      },
    });
  });
});
