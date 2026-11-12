import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWhiteboardSceneAnchor } from "../components/whiteboardSceneAnchor";
import {
  registerCursorCellAnchor,
  unregisterCursorCellAnchor,
} from "../core/src/utils/cursorCellAnchors";
import { RECORDED_CURSOR_VISIBILITY_EVENT } from "../core/src/utils/recordedCursorVisibility";
import {
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardEvent,
  type WhiteboardSceneState,
} from "../core/src/whiteboard";
import { DEFAULT_PREVIEW_STATE, type SlidesContext } from "../stores/slidesStore";
import type { SlidePreviewState } from "../types/slides";
import { measureLineWithCanvas } from "../utils/whiteboardTextFit";
import { createStudioDriver, type StudioDriverDeps } from "./driver";
import { studioWhiteboardAssetSchema } from "./plan";
import { whiteboardPointAim } from "./whiteboardPen";

vi.mock("../monaco", () => ({
  monaco: {},
  workspacePathFromMonacoModelUri: vi.fn<() => string | null>(),
}));

const ASSETS = [
  { id: "box", kind: "rectangle", x: 10, y: 20, width: 100, height: 50 },
  { id: "label", kind: "text", x: 15, y: 90, width: 200, height: 30, text: "scores" },
].map((asset) => studioWhiteboardAssetSchema.parse(asset));
const LABEL = ASSETS[1];

const PLAN_SEED = 29;
const SLIDE_ID = "intro";

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

/** The app root holding the whiteboard canvas (100, 50, 800×600) and a slide box (200, 100, 960×540). */
function mountStage() {
  const app = document.createElement("div");
  app.setAttribute("data-cursor-replay-target", "app");
  const board = document.createElement("div");
  board.setAttribute("data-cursor-replay-target", "whiteboard-canvas");
  const slide = document.createElement("div");
  slide.setAttribute("data-cursor-replay-target", "slide-content");
  app.append(board, slide);
  document.body.append(app);
  place(board, { left: 100, top: 50, width: 800, height: 600 });
  place(slide, { left: 200, top: 100, width: 960, height: 540 });
  return { app, board, slide };
}

function makeDriver() {
  let scene: WhiteboardSceneState = EMPTY_WHITEBOARD_SCENE;
  const events: WhiteboardEvent[] = [];
  let slidesContext: SlidesContext = {
    slides: [{ id: SLIDE_ID, name: "Intro", contentType: "markdown", content: "# Intro" }] as never,
    previewState: { ...DEFAULT_PREVIEW_STATE },
    deckBorrowed: false,
    saveFailed: false,
  };

  const deps = {
    getEditor: () => null,
    workspace: {
      getFile: () => null,
      getProject: () => ({ lessonType: "rust" }) as never,
      setActiveFilePath: () => {},
    },
    notifyWorkspaceEvent: () => {},
    notifyRuntimeEvent: () => {},
    runtimePanelStore: {} as StudioDriverDeps["runtimePanelStore"],
    slidesStore: {
      getSnapshot: () => ({ context: slidesContext }),
      trigger: {
        setPreviewState: ({ previewState }: { previewState: SlidePreviewState }) => {
          slidesContext = { ...slidesContext, previewState };
        },
      },
    } as unknown as StudioDriverDeps["slidesStore"],
    whiteboardStore: {
      getSnapshot: () => ({ context: { scene } }),
      trigger: {
        setScene: ({ scene: next }: { scene: WhiteboardSceneState }) => {
          scene = next;
        },
      },
    } as unknown as StudioDriverDeps["whiteboardStore"],
    notifySlideEvent: () => {},
    notifyWhiteboardEvent: (event: WhiteboardEvent) => {
      events.push(event);
    },
    notifyPreviewEvent: () => {},
    runtimeMode: "live",
    runtime: { kind: "rust-playground" } as StudioDriverDeps["runtime"],
    planSeed: PLAN_SEED,
    whiteboardAssets: ASSETS,
    webContainerRuntime: {} as StudioDriverDeps["webContainerRuntime"],
    preview: {} as StudioDriverDeps["preview"],
    signal: new AbortController().signal,
  } satisfies StudioDriverDeps;

  return { driver: createStudioDriver(deps), events };
}

interface Move {
  x: number;
  y: number;
  buttons: number;
  target: EventTarget | null;
}
interface Visibility {
  x: number;
  y: number;
  visible: boolean;
}

let moves: Move[] = [];
let visibility: Visibility[] = [];
const onMove = (event: Event) => {
  const pointer = event as MouseEvent;
  moves.push({
    x: pointer.clientX,
    y: pointer.clientY,
    buttons: pointer.buttons,
    target: pointer.target,
  });
};
const onVisibility = (event: Event) => {
  const { x, y, visible } = (event as CustomEvent<Visibility>).detail;
  visibility.push({ x, y, visible });
};

/** Clears what was recorded so far, so a case looks only at the gesture under test. */
function resetSamples() {
  moves = [];
  visibility = [];
}

/** The client point the driver aims at for `asset` at the default view (no scroll, zoom 1). */
function defaultViewAim(asset: (typeof ASSETS)[number]) {
  const aim = whiteboardPointAim(asset, measureLineWithCanvas);
  return { x: Math.round(100 + aim.x), y: Math.round(50 + aim.y) };
}

describe("StudioDriver point actions and the whiteboard pen", () => {
  beforeEach(() => {
    resetSamples();
    // jsdom has no PointerEvent; the driver only needs a MouseEvent's fields.
    if (typeof globalThis.PointerEvent === "undefined") {
      vi.stubGlobal("PointerEvent", MouseEvent);
    }
    // jsdom has no 2D canvas: text is measured by its share of the box, as the
    // driver does without a canvas, and jsdom's "not implemented" notice stays quiet.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    window.addEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, onVisibility);
    document.addEventListener("pointermove", onMove, true);
  });

  afterEach(() => {
    window.removeEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, onVisibility);
    document.removeEventListener("pointermove", onMove, true);
    document.body.replaceChildren();
    Reflect.deleteProperty(document, "elementsFromPoint");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("pointWhiteboard", () => {
    it("reveals a hidden pointer under the asset, on the canvas itself", async () => {
      const { board } = mountStage();
      const { driver } = makeDriver();
      await driver.applyWhiteboard({ open: true, upsertIds: ["box"] });
      resetSamples();

      const result = await driver.pointWhiteboard({
        target: { assetId: "box" },
        durationMs: 800,
        timeoutMs: 1_000,
      });

      // The middle of the box's bottom edge: scene (60, 70) → client (160, 120).
      expect(visibility).toEqual([{ x: 160, y: 120, visible: true }]);
      expect(moves).toEqual([{ x: 160, y: 120, buttons: 0, target: board }]);
      expect(result).toEqual({ assetId: "box", travelMs: 0 });
    });

    it("travels a visible pointer to the next asset in one eased move", async () => {
      const { board } = mountStage();
      const { driver } = makeDriver();
      await driver.applyWhiteboard({ open: true, upsertIds: ["box", "label"] });
      await driver.pointWhiteboard({
        target: { assetId: "box" },
        durationMs: 800,
        timeoutMs: 1_000,
      });
      resetSamples();

      const result = await driver.pointWhiteboard({
        target: { assetId: "label" },
        durationMs: 800,
        timeoutMs: 1_000,
      });

      const aim = defaultViewAim(LABEL);
      const from = { x: 160, y: 120 };
      const distance = (point: Move, to: { x: number; y: number }) =>
        Math.hypot(point.x - to.x, point.y - to.y);
      expect(visibility).toEqual([]);
      expect(moves.length).toBeGreaterThan(2);
      expect(distance(moves[0], from)).toBeLessThan(distance(moves.at(-1)!, from));
      expect(moves.at(-1)).toMatchObject(aim);
      expect(moves.every((move) => move.buttons === 0 && move.target === board)).toBe(true);
      expect(result).toMatchObject({ assetId: "label", travelMs: expect.any(Number) });
      expect(result.travelMs).toBeGreaterThan(0);
    });

    it("fails, naming the asset, when it was never drawn on the board", async () => {
      mountStage();
      const { driver } = makeDriver();
      await driver.applyWhiteboard({ open: true, upsertIds: ["box"] });

      await expect(
        driver.pointWhiteboard({ target: { assetId: "label" }, durationMs: 800, timeoutMs: 100 }),
      ).rejects.toThrow(/Timed out after 100ms.*"label"/);
    });

    it("aims through the board's own anchor, which knows the canvas's scroll and zoom", async () => {
      const { board } = mountStage();
      const anchor = createWhiteboardSceneAnchor(board, () => ({
        scrollX: 50,
        scrollY: 0,
        zoom: 2,
      }));
      registerCursorCellAnchor(board, anchor);
      try {
        const { driver } = makeDriver();
        await driver.applyWhiteboard({ open: true, upsertIds: ["box"] });
        resetSamples();

        await driver.pointWhiteboard({
          target: { assetId: "box" },
          durationMs: 800,
          timeoutMs: 1_000,
        });

        // Scene (60, 70) at scroll (50, 0) and zoom 2: (100 + 110·2, 50 + 70·2).
        expect(visibility).toEqual([{ x: 320, y: 190, visible: true }]);
        expect(moves.at(-1)).toMatchObject({ x: 320, y: 190 });
      } finally {
        unregisterCursorCellAnchor(board, anchor);
      }
    });
  });

  describe("the pen while a whiteboard.apply is drawn in", () => {
    it("drags a shape out from its anchor corner to its far corner, then lifts", async () => {
      const { board } = mountStage();
      const { driver, events } = makeDriver();

      const result = await driver.applyWhiteboard({
        open: true,
        upsertIds: ["box"],
        drawMs: 600,
      });

      // The hidden pointer appears where the drag starts: scene (10, 20).
      expect(visibility.filter((entry) => entry.visible)).toEqual([
        { x: 110, y: 70, visible: true },
      ]);
      expect(moves.every((move) => move.target === board)).toBe(true);
      const held = moves.filter((move) => move.buttons === 1);
      expect(held.length).toBeGreaterThan(2);
      for (let index = 1; index < held.length; index++) {
        expect(held[index].x).toBeGreaterThanOrEqual(held[index - 1].x);
        expect(held[index].y).toBeGreaterThanOrEqual(held[index - 1].y);
      }
      // The far corner, scene (110, 70): still held, then the pen lifts.
      expect(moves.slice(-2).map(({ x, y, buttons }) => ({ x, y, buttons }))).toEqual([
        { x: 210, y: 120, buttons: 1 },
        { x: 210, y: 120, buttons: 0 },
      ]);
      expect(result).toMatchObject({ pen: true });
      const last = events.at(-1)!.upserts![0];
      expect(last).toMatchObject({ id: "box", width: 100, height: 50 });
    });

    it("still begins the drag at the anchor corner when the board renders a step late", async () => {
      // A board that is just opening is not on screen for the apply's first
      // step: React renders the panel after the scene is published.
      const { board } = mountStage();
      place(board, { left: 100, top: 50, width: 0, height: 0 });
      const { driver } = makeDriver();
      window.setTimeout(() => place(board, { left: 100, top: 50, width: 800, height: 600 }), 70);

      await driver.applyWhiteboard({ open: true, upsertIds: ["box"], drawMs: 600 });

      expect(visibility.filter((entry) => entry.visible)).toEqual([
        { x: 110, y: 70, visible: true },
      ]);
      // The press lands on the corner before the pen is anywhere else.
      expect(moves.slice(0, 2).map(({ x, y, buttons }) => ({ x, y, buttons }))).toEqual([
        { x: 110, y: 70, buttons: 0 },
        { x: 110, y: 70, buttons: 1 },
      ]);
      expect(moves.at(-1)).toMatchObject({ x: 210, y: 120, buttons: 0 });
    });

    it("writes text along its line without holding the button", async () => {
      mountStage();
      const { driver } = makeDriver();

      await driver.applyWhiteboard({ open: true, upsertIds: ["label"], drawMs: 600 });

      expect(moves.length).toBeGreaterThan(0);
      expect(moves.every((move) => move.buttons === 0)).toBe(true);
      for (let index = 1; index < moves.length; index++) {
        expect(moves[index].x).toBeGreaterThanOrEqual(moves[index - 1].x);
      }
      expect(moves.at(-1)!.x).toBeGreaterThanOrEqual(moves[0].x);
    });

    it("stays out of an apply too dense to follow", async () => {
      mountStage();
      const { driver } = makeDriver();

      const result = await driver.applyWhiteboard({
        open: true,
        upsertIds: ["box", "label"],
        drawMs: 300,
      });

      expect(moves).toEqual([]);
      expect(result).not.toHaveProperty("pen");
    });

    it("spends its lead reaching the second asset before any of it is drawn", async () => {
      mountStage();
      const { driver, events } = makeDriver();

      await driver.applyWhiteboard({ open: true, upsertIds: ["box", "label"], drawMs: 1_200 });

      // The box lies above client y 120; the label's line lies below it.
      expect(moves.some((move) => move.y <= 120)).toBe(true);
      expect(moves.some((move) => move.y > 130)).toBe(true);
      const firstVersion = (id: string) =>
        Math.min(
          ...events
            .filter((event) => event.upserts?.[0].id === id)
            .map((event) => event.upserts![0].version as number),
        );
      expect(firstVersion("box")).toBe(1);
      expect(firstVersion("label")).toBe(4);
    });
  });

  describe("hiding a pointer that rests on the board", () => {
    it("hides it when the board closes", async () => {
      mountStage();
      const { driver } = makeDriver();
      await driver.applyWhiteboard({ open: true, upsertIds: ["box"] });
      await driver.pointWhiteboard({
        target: { assetId: "box" },
        durationMs: 800,
        timeoutMs: 1_000,
      });
      resetSamples();

      await driver.applyWhiteboard({ open: false, upsertIds: [] });

      expect(visibility).toEqual([{ x: 160, y: 120, visible: false }]);
    });

    it("hides it when the open board changes without the pen", async () => {
      mountStage();
      const { driver } = makeDriver();
      await driver.applyWhiteboard({ open: true, upsertIds: ["box"] });
      await driver.pointWhiteboard({
        target: { assetId: "box" },
        durationMs: 800,
        timeoutMs: 1_000,
      });
      resetSamples();

      await driver.applyWhiteboard({ upsertIds: ["label"] });

      expect(visibility).toEqual([{ x: 160, y: 120, visible: false }]);
    });
  });

  describe("pointSlide", () => {
    it("reveals the pointer at the fraction of the slide's box, on the slide itself", async () => {
      const { slide } = mountStage();
      const { driver } = makeDriver();
      await driver.showSlide({ slideId: SLIDE_ID, maximized: true });
      resetSamples();

      const result = await driver.pointSlide({
        target: { x: 0.25, y: 0.5 },
        durationMs: 800,
        timeoutMs: 1_000,
      });

      expect(visibility).toEqual([{ x: 440, y: 370, visible: true }]);
      expect(moves).toEqual([{ x: 440, y: 370, buttons: 0, target: slide }]);
      expect(result).toEqual({ x: 0.25, y: 0.5, travelMs: 0 });
    });

    it("fails when no slide is open", async () => {
      mountStage();
      const { driver } = makeDriver();

      await expect(
        driver.pointSlide({ target: { x: 0.25, y: 0.5 }, durationMs: 800, timeoutMs: 100 }),
      ).rejects.toThrow(/slide on screen/);
    });

    it("hides a pointer resting on the slide as it closes, and only then", async () => {
      mountStage();
      const resting = makeDriver();
      await resting.driver.showSlide({ slideId: SLIDE_ID, maximized: true });
      await resting.driver.pointSlide({
        target: { x: 0.25, y: 0.5 },
        durationMs: 800,
        timeoutMs: 1_000,
      });
      resetSamples();
      await resting.driver.closeSlide();
      expect(visibility).toEqual([{ x: 440, y: 370, visible: false }]);

      // A pointer that is already hidden is left alone.
      const hidden = makeDriver();
      await hidden.driver.showSlide({ slideId: SLIDE_ID, maximized: true });
      resetSamples();
      await hidden.driver.closeSlide();
      expect(visibility).toEqual([]);
    });
  });
});
