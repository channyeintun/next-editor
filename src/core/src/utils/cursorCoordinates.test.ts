import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { registerCursorCellAnchor } from "./cursorCellAnchors";
import {
  CURSOR_REPLAY_SCALE_ATTRIBUTE,
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
    vi.restoreAllMocks();
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
    target.setAttribute(CURSOR_REPLAY_SCALE_ATTRIBUTE, "content");
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

  it("anchors a target without the scale attribute to its top-left, whatever its id", () => {
    // The live element decides, not the recorded id: a preview frame that does
    // not declare scaled content keeps the recorded offset from its top-left.
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
      x: 220,
      y: 160,
    });
  });

  it("re-scales a viewport sample by the current window size", () => {
    // The viewport has no element to carry the attribute, so it scales by id.
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);

    expect(
      resolveCursorViewportPosition({
        x: 30,
        y: 40,
        visible: true,
        coordinateSpace: "viewport",
        target: {
          id: "viewport",
          x: 30,
          y: 40,
          rect: { left: 0, top: 0, width: 400, height: 300 },
        },
      }),
    ).toEqual({ x: 60, y: 80 });
  });

  it("records and resolves a point over a terminal by its place in the text", () => {
    const root = document.createElement("div");
    root.setAttribute("data-cursor-replay-target", "app");
    const terminal = document.createElement("div");
    terminal.setAttribute("data-cursor-replay-target", "terminal-go-runner");
    root.appendChild(terminal);
    document.body.appendChild(root);
    mockRect(root, { left: 0, top: 0, width: 1000, height: 800 });
    mockRect(terminal, { left: 100, top: 500, width: 600, height: 200 });
    // While recording, (330, 560) is line 3, character 8; on replay that line
    // sits two rows lower, as on a console that fits more rows.
    let replaying = false;
    registerCursorCellAnchor(terminal, {
      toCell: (x, y) => (x === 330 && y === 560 ? { line: 3, offset: 8, dx: 0.6, dy: 0.5 } : null),
      toClient: (cell) => (cell.line === 3 && replaying ? { x: 330, y: 600 } : null),
    });

    const cursor = createCursorPositionFromClientPoint({
      clientX: 330,
      clientY: 560,
      visible: true,
      eventTarget: terminal,
    });
    expect(cursor.target).toMatchObject({
      id: "terminal-go-runner",
      cell: { line: 3, offset: 8, dx: 0.6, dy: 0.5 },
    });

    replaying = true;
    expect(resolveCursorViewportPosition(cursor)).toEqual({ x: 330, y: 600 });
    // A line no longer on screen falls back to the recorded pixel offset.
    replaying = false;
    expect(resolveCursorViewportPosition(cursor)).toEqual({ x: 330, y: 560 });
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

  // Replay resolves a recorded point against the element that now carries its
  // target id, on every animation frame.
  const recordedPointOn = (id: string) =>
    resolveCursorViewportPosition({
      x: 30,
      y: 40,
      visible: true,
      coordinateSpace: "viewport",
      target: { id, x: 30, y: 40, rect: { left: 0, top: 0, width: 400, height: 300 } },
    });

  const addTarget = (id: string, rect: { left: number; top: number }) => {
    const target = document.createElement("div");
    target.setAttribute("data-cursor-replay-target", id);
    document.body.appendChild(target);
    mockRect(target, { ...rect, width: 400, height: 300 });
    return target;
  };

  it("resolves a recorded target by its exact id without scanning every target", () => {
    addTarget("terminal-ab", { left: 500, top: 500 });
    addTarget("terminal-a", { left: 100, top: 50 });
    const querySelectorAll = vi.spyOn(document, "querySelectorAll");

    expect(recordedPointOn("terminal-a")).toEqual({ x: 130, y: 90 });
    expect(querySelectorAll).not.toHaveBeenCalled();
  });

  it.each([
    ["a double quote", 'term"inal'],
    ["a backslash", "term\\inal"],
    ["a newline", "term\ninal"],
    ["a closing bracket", "term]inal"],
  ])("matches a recorded id containing %s", (_label, id) => {
    addTarget("terminal", { left: 500, top: 500 });
    addTarget(id, { left: 100, top: 50 });

    expect(recordedPointOn(id)).toEqual({ x: 130, y: 90 });
  });

  it("falls back to the recorded point when no element carries the id", () => {
    addTarget("terminal", { left: 100, top: 50 });

    expect(recordedPointOn('missing"]\n[x')).toEqual({ x: 30, y: 40 });
  });
});
