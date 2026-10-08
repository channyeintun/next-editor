import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createRuntimePanelStore } from "../stores/runtimePanelStore";
import { POINTER_PRESS_MS, POINTER_SETTLE_MS } from "../core/src/utils/pointerMotion";
import { RECORDED_CURSOR_VISIBILITY_EVENT } from "../core/src/utils/recordedCursorVisibility";
import type { Terminal } from "@xterm/xterm";
import { registerXtermTerminal } from "../components/xtermRegistry";
import { createStudioDriver, type StudioDriverDeps } from "./driver";

vi.mock("../monaco", () => ({
  monaco: {},
  workspacePathFromMonacoModelUri: vi.fn<() => string | null>(),
}));

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function place(element: Element, box: Box) {
  element.getBoundingClientRect = () =>
    ({
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
    }) as DOMRect;
}

// An app root with a file row (a full-width button whose name is short) and the
// runner dock's Run button, laid out like the real sidebar and dock.
function mountApp() {
  const app = document.createElement("div");
  app.setAttribute("data-cursor-replay-target", "app");
  const row = document.createElement("button");
  row.setAttribute("data-studio-target", "file:main.rs");
  const name = document.createElement("span");
  name.setAttribute("data-studio-aim", "");
  name.textContent = "main.rs";
  row.append(name);
  const run = document.createElement("button");
  run.setAttribute("data-studio-target", "runtime-run");
  app.append(row, run);
  document.body.append(app);
  place(row, { left: 8, top: 100, width: 232, height: 32 });
  place(name, { left: 40, top: 106, width: 48, height: 20 });
  place(run, { left: 870, top: 385, width: 60, height: 30 });
  return { app, row, name, run };
}

// The runner dock's console: an xterm container whose screen is 80 columns of
// 8px by 10 rows of 18px, showing `lines` from the top.
function mountConsole(app: Element, lines: string[], viewportY = 0) {
  const dock = document.createElement("div");
  dock.setAttribute("data-cursor-replay-target", "runtime-dock");
  const container = document.createElement("div");
  container.setAttribute("data-cursor-replay-target", "terminal-go-runner");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  container.append(screen);
  dock.append(container);
  app.append(dock);
  place(container, { left: 300, top: 500, width: 800, height: 200 });
  place(screen, { left: 310, top: 510, width: 640, height: 180 });
  const rows = lines.map((text) => {
    const cells = [...text.padEnd(80, " ")];
    return {
      isWrapped: false,
      length: 80,
      translateToString: () => text,
      getCell: (x: number) => ({
        getChars: () => (cells[x] === " " ? "" : cells[x]),
        getWidth: () => 1,
      }),
    };
  });
  const terminal = {
    cols: 80,
    rows: 10,
    buffer: { active: { length: rows.length, viewportY, getLine: (y: number) => rows[y] } },
  };
  registerXtermTerminal(container, terminal as unknown as Terminal);
  return container;
}

function makeDriver(preview: Partial<StudioDriverDeps["preview"]> = {}) {
  const runtimePanelStore = createRuntimePanelStore();
  const deps = {
    getEditor: () => null,
    workspace: {
      getFile: () => null,
      getProject: () => ({ lessonType: "rust" }) as never,
      setActiveFilePath: () => {},
    },
    notifyWorkspaceEvent: () => {},
    notifyRuntimeEvent: () => {},
    runtimePanelStore,
    slidesStore: {} as StudioDriverDeps["slidesStore"],
    whiteboardStore: {} as StudioDriverDeps["whiteboardStore"],
    notifySlideEvent: () => {},
    notifyWhiteboardEvent: () => {},
    notifyPreviewEvent: () => {},
    runtimeMode: "fixture",
    runtime: { kind: "rust-playground", defaultMode: "fixture" } as StudioDriverDeps["runtime"],
    planSeed: 29,
    whiteboardAssets: [],
    webContainerRuntime: {} as StudioDriverDeps["webContainerRuntime"],
    preview: preview as StudioDriverDeps["preview"],
    signal: new AbortController().signal,
  } satisfies StudioDriverDeps;
  return { driver: createStudioDriver(deps), runtimePanelStore };
}

type Sample =
  | { kind: "visibility"; visible: boolean; x: number; y: number }
  | { kind: "move"; x: number; y: number; buttons: number; at: number };

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
    at: performance.now(),
  });
};

const moves = () => samples.filter((sample) => sample.kind === "move");

describe("StudioDriver pointer", () => {
  beforeEach(() => {
    samples = [];
    // jsdom has no PointerEvent; the driver only needs a MouseEvent's fields.
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
    Reflect.deleteProperty(document, "elementsFromPoint");
    vi.unstubAllGlobals();
  });

  it("starts hidden, then appears on the file's name — not the empty middle of its row — and clicks it", async () => {
    mountApp();
    const { driver } = makeDriver();

    // Nothing to point at until the first gesture.
    expect(samples).toEqual([expect.objectContaining({ kind: "visibility", visible: false })]);

    const result = await driver.moveCursor({
      target: { kind: "file", path: "main.rs" },
      durationMs: 600,
      press: true,
    });

    // A hidden pointer never travels in from a stale spot: it shows on the name
    // (64, 116), rests, then presses and releases there.
    expect(samples[1]).toEqual({ kind: "visibility", visible: true, x: 64, y: 116 });
    expect(moves().map(({ x, y, buttons }) => ({ x, y, buttons }))).toEqual([
      { x: 64, y: 116, buttons: 1 },
      { x: 64, y: 116, buttons: 0 },
    ]);
    const [press, release] = moves() as Extract<Sample, { kind: "move" }>[];
    expect(release.at - press.at).toBeGreaterThanOrEqual(POINTER_PRESS_MS - 5);
    expect(result).toMatchObject({ pressed: true, travelMs: 0 });
  });

  it("travels a visible pointer in one straight stroke that leaves and lands at rest", async () => {
    mountApp();
    const { driver } = makeDriver();
    await driver.moveCursor({
      target: { kind: "file", path: "main.rs" },
      durationMs: POINTER_SETTLE_MS + POINTER_PRESS_MS + 10,
      press: true,
    });
    samples = [];

    const result = await driver.moveCursor({
      target: { kind: "run-button" },
      durationMs: 1_120,
      press: true,
    });

    const path = moves().filter((sample) => sample.buttons === 0);
    const travel = path.slice(0, -1);
    // From the name to the Run button's centre (900, 400), never backwards.
    expect(travel[0].x).toBeLessThan(80);
    expect(travel.at(-1)).toMatchObject({ x: 900, y: 400 });
    for (let index = 1; index < travel.length; index++) {
      expect(travel[index].x).toBeGreaterThanOrEqual(travel[index - 1].x);
    }
    // Straight: every sample sits on the line between the two points.
    const slope = (400 - 116) / (900 - 64);
    for (const step of travel) {
      expect(Math.abs(116 + (step.x - 64) * slope - step.y)).toBeLessThanOrEqual(2);
    }
    // Leaves and lands gently: the first and last steps are short beside the middle.
    const stepLengths = travel.slice(1).map((step, index) => step.x - travel[index].x);
    const longest = Math.max(...stepLengths);
    expect(stepLengths[0]).toBeLessThan(longest / 2);
    expect(stepLengths.at(-1)!).toBeLessThan(longest / 2);
    // Then the click on the button itself.
    expect(moves().filter((sample) => sample.buttons === 1)).toEqual([
      expect.objectContaining({ x: 900, y: 400 }),
    ]);
    // The travel time comes from the distance, not the plan's whole budget.
    expect(result.travelMs).toBeLessThan(1_120 - POINTER_SETTLE_MS - POINTER_PRESS_MS);
    expect(result.travelMs).toBeGreaterThan(700);
  });

  it("does not click a control something else covers on screen", async () => {
    const { app, run } = mountApp();
    const slide = document.createElement("div");
    app.append(slide);
    document.elementsFromPoint = () => [slide, run, app];
    const { driver } = makeDriver();

    const result = await driver.moveCursor({
      target: { kind: "run-button" },
      durationMs: 600,
      press: true,
    });

    expect(result).toMatchObject({ skipped: expect.stringContaining("covers") });
    expect(moves()).toEqual([]);
  });

  it("skips — never fails — the click on a preview element it cannot locate", async () => {
    const { app } = mountApp();
    const frame = document.createElement("iframe");
    frame.setAttribute("data-cursor-replay-target", "preview-frame");
    app.append(frame);
    place(frame, { left: 700, top: 60, width: 600, height: 400 });
    const { driver } = makeDriver({
      executeCommand: () =>
        Promise.reject(new Error('Preview target data-testid="greet" was not found')),
    });

    const result = await driver.moveCursor({
      target: { kind: "preview", testId: "greet" },
      durationMs: 600,
      press: true,
    });

    expect(result).toMatchObject({ skipped: expect.stringContaining("could not be located") });
    expect(moves()).toEqual([]);
  });

  it("skips a hidden preview element instead of clicking the frame's corner", async () => {
    const { app } = mountApp();
    const frame = document.createElement("iframe");
    frame.setAttribute("data-cursor-replay-target", "preview-frame");
    app.append(frame);
    place(frame, { left: 700, top: 60, width: 600, height: 400 });
    const box = { left: 0, top: 0, width: 0, height: 0, viewportWidth: 600, viewportHeight: 400 };
    const { driver } = makeDriver({
      executeCommand: () =>
        Promise.resolve({
          command: "inspect",
          route: "/",
          scrollLeft: 0,
          scrollTop: 0,
          targetBox: box,
        }),
    });

    const result = await driver.moveCursor({
      target: { kind: "preview", testId: "greet" },
      durationMs: 600,
      press: true,
    });

    expect(result).toMatchObject({ skipped: expect.stringContaining("hidden") });
    expect(moves()).toEqual([]);
  });

  it("clicks a preview element at its spot inside the frame", async () => {
    const { app } = mountApp();
    const frame = document.createElement("iframe");
    frame.setAttribute("data-cursor-replay-target", "preview-frame");
    app.append(frame);
    // The frame shows a 1200x800 page scaled into 600x400.
    place(frame, { left: 700, top: 60, width: 600, height: 400 });
    const box = {
      left: 100,
      top: 200,
      width: 200,
      height: 40,
      viewportWidth: 1200,
      viewportHeight: 800,
    };
    const { driver } = makeDriver({
      executeCommand: () =>
        Promise.resolve({
          command: "inspect",
          route: "/",
          scrollLeft: 0,
          scrollTop: 0,
          targetBox: box,
        }),
    });

    await driver.moveCursor({
      target: { kind: "preview", testId: "greet" },
      durationMs: 600,
      press: true,
    });

    expect(moves().map(({ x, y, buttons }) => ({ x, y, buttons }))).toEqual([
      { x: 800, y: 170, buttons: 1 },
      { x: 800, y: 170, buttons: 0 },
    ]);
  });

  it("points at a console line: travels to just past its last character, and does not click", async () => {
    const { app } = mountApp();
    mountConsole(app, ["[go-run] go run main.go", "0 apple", "1 banana", "2 mango"]);
    const { driver } = makeDriver();
    await driver.moveCursor({
      target: { kind: "run-button" },
      durationMs: POINTER_SETTLE_MS + POINTER_PRESS_MS + 10,
      press: true,
    });
    samples = [];

    const result = await driver.pointConsole({
      target: { text: "banana", occurrence: 1 },
      durationMs: 800,
      timeoutMs: 1_000,
    });

    // "1 banana" ends at column 8 on row 2: (310 + 8.6·8, 510 + 2.5·18).
    const path = moves();
    expect(path.at(-1)).toMatchObject({ x: 379, y: 555, buttons: 0 });
    expect(path.every((sample) => sample.buttons === 0)).toBe(true);
    for (let index = 1; index < path.length; index++) {
      expect(path[index].y).toBeGreaterThanOrEqual(path[index - 1].y);
    }
    expect(result).toMatchObject({ line: "1 banana" });
  });

  it("shows a hidden pointer right at the console line instead of travelling in", async () => {
    const { app } = mountApp();
    mountConsole(app, ["0 apple", "1 banana"]);
    const { driver } = makeDriver();

    await driver.pointConsole({
      target: { text: "apple", occurrence: 1 },
      durationMs: 800,
      timeoutMs: 1_000,
    });

    expect(samples[1]).toEqual({ kind: "visibility", visible: true, x: 371, y: 519 });
    // One sample on the same spot, through the console — no travel.
    expect(moves().map(({ x, y, buttons }) => ({ x, y, buttons }))).toEqual([
      { x: 371, y: 519, buttons: 0 },
    ]);
  });

  it("fails clearly for a console line that never appears or has scrolled away", async () => {
    const { app } = mountApp();
    mountConsole(app, ["0 apple", "1 banana", "2 mango"], 2);
    const { driver } = makeDriver();

    await expect(
      driver.pointConsole({
        target: { text: "cherry", occurrence: 1 },
        durationMs: 800,
        timeoutMs: 80,
      }),
    ).rejects.toThrow(/cherry.*is the runner dock open/);
    await expect(
      driver.pointConsole({
        target: { text: "apple", occurrence: 1 },
        durationMs: 800,
        timeoutMs: 80,
      }),
    ).rejects.toThrow(/scrolled out of the console's view/);
  });

  it("pins a resting pointer to the app before the dock under it shuts", async () => {
    mountApp();
    const { driver } = makeDriver();
    await driver.moveCursor({
      target: { kind: "run-button" },
      durationMs: POINTER_SETTLE_MS + POINTER_PRESS_MS + 10,
      press: true,
    });
    samples = [];

    const targets: EventTarget[] = [];
    const onTarget = (event: Event) => targets.push(event.target!);
    document.addEventListener("pointermove", onTarget, true);
    await driver.collapseRuntimeDock(1_000);
    document.removeEventListener("pointermove", onTarget, true);

    // The same spot, recorded against the app root rather than the dock — so
    // replay does not carry the arrow down with the dock's edge.
    expect(moves()).toEqual([expect.objectContaining({ x: 900, y: 400, buttons: 0 })]);
    expect(targets).toEqual([document.querySelector('[data-cursor-replay-target="app"]')]);
  });
});
