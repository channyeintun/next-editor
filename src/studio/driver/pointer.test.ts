import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RECORDED_CURSOR_VISIBILITY_EVENT } from "../../core/src/utils/recordedCursorVisibility";
import { createStudioPointer } from "./pointer";

type Sample =
  | { kind: "visibility"; visible: boolean; x: number; y: number }
  | { kind: "move"; x: number; y: number; buttons: number; target: EventTarget | null };

let samples: Sample[] = [];
const onVisibility = (event: Event) => {
  const { visible, x, y } = (event as CustomEvent<{ visible: boolean; x: number; y: number }>)
    .detail;
  samples.push({ kind: "visibility", visible, x, y });
};
const onMove = (event: Event) => {
  const pointer = event as MouseEvent;
  samples.push({
    kind: "move",
    x: pointer.clientX,
    y: pointer.clientY,
    buttons: pointer.buttons,
    target: pointer.target,
  });
};

function mountAppRoot() {
  const app = document.createElement("div");
  app.setAttribute("data-cursor-replay-target", "app");
  const control = document.createElement("button");
  app.append(control);
  document.body.append(app);
  return { app, control };
}

describe("createStudioPointer", () => {
  beforeEach(() => {
    samples = [];
    // jsdom has no PointerEvent; the pointer only needs a MouseEvent's fields.
    if (typeof globalThis.PointerEvent === "undefined") {
      vi.stubGlobal("PointerEvent", MouseEvent);
    }
    window.addEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, onVisibility);
    document.addEventListener("pointermove", onMove, true);
  });

  afterEach(() => {
    window.removeEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, onVisibility);
    document.removeEventListener("pointermove", onMove, true);
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("starts hidden in the middle of the window, with no resting point yet", () => {
    const pointer = createStudioPointer();

    expect(samples).toEqual([
      {
        kind: "visibility",
        visible: false,
        x: Math.round(window.innerWidth / 2),
        y: Math.round(window.innerHeight / 2),
      },
    ]);
    expect(pointer.isHidden()).toBe(true);
    expect(pointer.lastPoint()).toBeNull();
  });

  it("hides only once while already hidden", () => {
    const pointer = createStudioPointer();
    samples = [];

    pointer.hide();
    pointer.hide();

    expect(samples).toEqual([]);
    expect(pointer.isHidden()).toBe(true);
  });

  it("reveals only a hidden pointer, resting it where it reappears", () => {
    const pointer = createStudioPointer();
    samples = [];

    pointer.revealAt({ x: 40, y: 60 });
    pointer.revealAt({ x: 400, y: 600 });

    expect(samples).toEqual([{ kind: "visibility", visible: true, x: 40, y: 60 }]);
    expect(pointer.isHidden()).toBe(false);
    expect(pointer.lastPoint()).toEqual({ x: 40, y: 60 });
  });

  it("hides a visible pointer where it last rested", () => {
    const { control } = mountAppRoot();
    const pointer = createStudioPointer();
    pointer.revealAt({ x: 40, y: 60 });
    pointer.dispatch(120, 80, control);
    samples = [];

    pointer.hide();

    expect(samples).toEqual([{ kind: "visibility", visible: false, x: 120, y: 80 }]);
    expect(pointer.isHidden()).toBe(true);
  });

  it("records each dispatched sample as the resting point, with its button state", () => {
    const { control } = mountAppRoot();
    const pointer = createStudioPointer();
    samples = [];

    pointer.dispatch(10, 20, control, 1);
    pointer.dispatch(30, 40, control);

    expect(samples).toEqual([
      { kind: "move", x: 10, y: 20, buttons: 1, target: control },
      { kind: "move", x: 30, y: 40, buttons: 0, target: control },
    ]);
    expect(pointer.lastPoint()).toEqual({ x: 30, y: 40 });
  });

  it("pins only a visible, resting pointer to the app root", () => {
    const { app, control } = mountAppRoot();
    const pointer = createStudioPointer();
    samples = [];

    // Hidden: nothing to pin.
    pointer.pinToApp();
    expect(samples).toEqual([]);

    pointer.revealAt({ x: 40, y: 60 });
    pointer.dispatch(120, 80, control, 1);
    samples = [];

    pointer.pinToApp();

    expect(samples).toEqual([{ kind: "move", x: 120, y: 80, buttons: 0, target: app }]);
    expect(pointer.lastPoint()).toEqual({ x: 120, y: 80 });
  });

  it("pins nothing without an app root to pin to", () => {
    const pointer = createStudioPointer();
    pointer.revealAt({ x: 40, y: 60 });
    samples = [];

    pointer.pinToApp();

    expect(samples).toEqual([]);
  });
});
