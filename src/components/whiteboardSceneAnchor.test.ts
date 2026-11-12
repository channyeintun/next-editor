import { describe, expect, it } from "vite-plus/test";
import {
  createWhiteboardSceneAnchor,
  whiteboardSceneCell,
  type WhiteboardCanvasView,
} from "./whiteboardSceneAnchor";

const DEFAULT_VIEW: WhiteboardCanvasView = { scrollX: 0, scrollY: 0, zoom: 1 };

function surface(width = 800, height = 600): HTMLElement {
  const element = document.createElement("div");
  element.getBoundingClientRect = () =>
    ({
      left: 100,
      top: 50,
      right: 100 + width,
      bottom: 50 + height,
      width,
      height,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

describe("whiteboardSceneCell", () => {
  it("splits a scene point into whole cell and fraction", () => {
    expect(whiteboardSceneCell({ x: 320.25, y: 199.5 })).toEqual({
      line: 199,
      offset: 320,
      dx: 0.25,
      dy: 0.5,
    });
  });

  it("floors negative points", () => {
    expect(whiteboardSceneCell({ x: -10.5, y: -0.25 })).toEqual({
      line: -1,
      offset: -11,
      dx: 0.5,
      dy: 0.75,
    });
  });
});

describe("createWhiteboardSceneAnchor", () => {
  it("maps client points to scene cells at the default view", () => {
    const anchor = createWhiteboardSceneAnchor(surface(), () => DEFAULT_VIEW);
    const cell = anchor.toCell(420, 250);
    expect(cell).toEqual({ line: 200, offset: 320, dx: 0, dy: 0 });
    expect(anchor.toClient(cell!)).toEqual({ x: 420, y: 250 });
  });

  it("round-trips under a panned and zoomed view", () => {
    const anchor = createWhiteboardSceneAnchor(surface(), () => ({
      scrollX: 40,
      scrollY: -30,
      zoom: 1.5,
    }));
    for (const [x, y] of [
      [300, 200],
      [512.4, 333.3],
    ]) {
      const back = anchor.toClient(anchor.toCell(x, y)!)!;
      expect(Math.abs(back.x - x)).toBeLessThan(0.02);
      expect(Math.abs(back.y - y)).toBeLessThan(0.02);
    }
  });

  it("resolves the same cell to a different client point when the view changes", () => {
    const cell = whiteboardSceneCell({ x: 320, y: 200 });
    let view: WhiteboardCanvasView = DEFAULT_VIEW;
    const anchor = createWhiteboardSceneAnchor(surface(), () => view);
    expect(anchor.toClient(cell)).toEqual({ x: 420, y: 250 });
    view = { scrollX: 100, scrollY: 0, zoom: 1 };
    expect(anchor.toClient(cell)).toEqual({ x: 520, y: 250 });
    view = { scrollX: 0, scrollY: 0, zoom: 2 };
    expect(anchor.toClient(cell)).toEqual({ x: 740, y: 450 });
  });

  it("returns no cell for a client point outside the surface", () => {
    const anchor = createWhiteboardSceneAnchor(surface(), () => DEFAULT_VIEW);
    expect(anchor.toCell(50, 100)).toBeNull();
    expect(anchor.toCell(950, 100)).toBeNull();
  });

  it("clamps an off-board scene point to the nearest edge", () => {
    const anchor = createWhiteboardSceneAnchor(surface(), () => DEFAULT_VIEW);
    expect(anchor.toClient(whiteboardSceneCell({ x: 5000, y: 200 }))).toEqual({ x: 900, y: 250 });
    expect(anchor.toClient(whiteboardSceneCell({ x: -5000, y: -5000 }))).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("returns null until the canvas has a view", () => {
    const anchor = createWhiteboardSceneAnchor(surface(), () => null);
    expect(anchor.toCell(420, 250)).toBeNull();
    expect(anchor.toClient(whiteboardSceneCell({ x: 320, y: 200 }))).toBeNull();
  });

  it("returns null for a surface with no size", () => {
    const anchor = createWhiteboardSceneAnchor(surface(0, 0), () => DEFAULT_VIEW);
    expect(anchor.toCell(100, 50)).toBeNull();
    expect(anchor.toClient(whiteboardSceneCell({ x: 320, y: 200 }))).toBeNull();
  });
});
