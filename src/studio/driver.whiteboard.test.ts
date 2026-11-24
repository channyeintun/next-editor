import { describe, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_WHITEBOARD_SCENE,
  applyWhiteboardEvent,
  type WhiteboardEvent,
  type WhiteboardSceneState,
} from "../core/src/whiteboard";
import { createStudioDriver, type StudioDriverDeps } from "./driver";
import { flushPendingWhiteboardChange } from "../hooks/useWhiteboardController";
import { REAL_RENDER_CLOCK, createVirtualRenderClock, type RenderClock } from "./renderClock";
import { studioWhiteboardAssetSchema } from "./plan";
import { WHITEBOARD_DRAW_FRAME_MS, buildWhiteboardElement } from "./whiteboardAssets";

vi.mock("../monaco", () => ({
  monaco: {},
  workspacePathFromMonacoModelUri: vi.fn<() => string | null>(),
}));

vi.mock("../hooks/useWhiteboardController", () => ({
  flushPendingWhiteboardChange: vi.fn<() => void>(),
}));

const ASSETS = [
  { id: "box", kind: "rectangle", x: 10, y: 20, width: 100, height: 50 },
  { id: "label", kind: "text", x: 15, y: 90, width: 200, height: 30, text: "scores" },
].map((asset) => studioWhiteboardAssetSchema.parse(asset));

const PLAN_SEED = 29;

function makeDriver(whiteboardAssets = ASSETS, clock: RenderClock = REAL_RENDER_CLOCK) {
  let scene: WhiteboardSceneState = EMPTY_WHITEBOARD_SCENE;
  const events: WhiteboardEvent[] = [];

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
    slidesStore: {} as StudioDriverDeps["slidesStore"],
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
    whiteboardAssets,
    nodeRuntime: {} as StudioDriverDeps["nodeRuntime"],
    preview: {} as StudioDriverDeps["preview"],
    signal: new AbortController().signal,
    clock,
  } satisfies StudioDriverDeps;

  return {
    driver: createStudioDriver(deps),
    events,
    getScene: () => scene,
    whiteboardStore: deps.whiteboardStore,
  };
}

/** Fold the recorded deltas the way replay does, to see what the board ends on. */
function replay(events: readonly WhiteboardEvent[]): WhiteboardSceneState {
  return events.reduce(applyWhiteboardEvent, EMPTY_WHITEBOARD_SCENE);
}

describe("StudioDriver whiteboard drawing", () => {
  it("applies every asset in one delta when no draw budget is given", async () => {
    const { driver, events } = makeDriver();

    const result = await driver.applyWhiteboard({ open: true, upsertIds: ["box", "label"] });

    expect(events).toHaveLength(1);
    expect(events[0].isOpen).toBe(true);
    expect(events[0].upserts).toHaveLength(2);
    expect(result).toMatchObject({ upserted: 2, open: true, frames: 0 });
  });

  it("draws the assets one at a time, one element per recorded step", async () => {
    const { driver, events } = makeDriver();

    await driver.applyWhiteboard({ open: true, upsertIds: ["box", "label"], drawMs: 200 });

    expect(events).toHaveLength(4);
    expect(events.every((event) => event.upserts?.length === 1)).toBe(true);
    expect(events.map((event) => event.upserts?.[0].id)).toEqual(["box", "box", "label", "label"]);
    // The board opens on the first step — the drawing happens in view, not
    // behind a closed panel that pops open holding a finished diagram.
    expect(events[0].isOpen).toBe(true);
    expect(events.slice(1).every((event) => event.isOpen === undefined)).toBe(true);
  });

  it("grows each element across its steps and lands on the finished asset", async () => {
    const { driver, events, getScene } = makeDriver();

    await driver.applyWhiteboard({ open: true, upsertIds: ["box", "label"], drawMs: 200 });

    const boxWidths = events
      .filter((event) => event.upserts?.[0].id === "box")
      .map((event) => event.upserts?.[0].width as number);
    expect(boxWidths).toEqual([50, 100]);

    const labels = events
      .filter((event) => event.upserts?.[0].id === "label")
      .map((event) => event.upserts?.[0].text as string);
    expect(labels).toEqual(["sco", "scores"]);

    // Live board and recorded deltas agree, and both settle on exactly the
    // elements an instant apply would have produced.
    const finished = ASSETS.map((asset) => buildWhiteboardElement(asset, PLAN_SEED));
    const settle = (state: WhiteboardSceneState) =>
      state.elements.map((element) => ({ ...element, version: 1 }));
    expect(settle(getScene())).toEqual(finished);
    expect(settle(replay(events))).toEqual(finished);
  });

  it("wipes the board before drawing when asked", async () => {
    const { driver, events, getScene } = makeDriver();

    await driver.applyWhiteboard({ open: true, upsertIds: ["box"] });
    const before = events.length;
    const result = await driver.applyWhiteboard({ upsertIds: ["label"], clear: true, drawMs: 100 });

    // The removal rides the first frame, so the board is empty before the pen
    // moves — and it is not repeated on later frames of the same draw.
    const drawEvents = events.slice(before);
    expect(drawEvents[0].removedIds).toEqual(["box"]);
    expect(drawEvents.slice(1).every((event) => event.removedIds === undefined)).toBe(true);
    expect(getScene().elements.map((element) => element.id)).toEqual(["label"]);
    expect(replay(events).elements.map((element) => element.id)).toEqual(["label"]);
    expect(result).toMatchObject({ wiped: 1 });
  });

  it("never wipes an element the same action is redrawing", async () => {
    // applyWhiteboardEvent removes after it upserts, so an id in both lists
    // would be deleted instead of redrawn.
    const { driver, events, getScene } = makeDriver();

    await driver.applyWhiteboard({ open: true, upsertIds: ["box", "label"] });
    await driver.applyWhiteboard({ upsertIds: ["label"], clear: true });

    expect(events.at(-1)!.removedIds).toEqual(["box"]);
    expect(getScene().elements.map((element) => element.id)).toEqual(["label"]);
  });

  it("traces a freedraw stroke as a growing prefix of its points", async () => {
    const underline = studioWhiteboardAssetSchema.parse({
      id: "underline",
      kind: "freedraw",
      stroke: "underline",
      x: 10,
      y: 20,
      width: 160,
      height: 20,
    });
    const { driver, events } = makeDriver([underline]);

    await driver.applyWhiteboard({ upsertIds: ["underline"], drawMs: 150 });

    const counts = events.map((event) => (event.upserts![0].points as unknown[]).length);
    expect(counts).toHaveLength(3);
    expect(counts[0]).toBeLessThan(counts[1]);
    expect(counts[1]).toBeLessThan(counts[2]);
  });
});

describe("StudioDriver whiteboard drawing on the render's clock", () => {
  it("draws a frame every WHITEBOARD_DRAW_FRAME_MS exactly, saving the canvas report after each", async () => {
    const flush = vi.mocked(flushPendingWhiteboardChange);
    flush.mockReset();
    const clock = createVirtualRenderClock();
    const started = clock.perfNow();
    const { driver, events, whiteboardStore } = makeDriver(ASSETS, clock);
    const publishedAt: number[] = [];
    const flushedAt: number[] = [];
    const notify = events.push.bind(events);
    events.push = (...items) => {
      publishedAt.push(clock.perfNow() - started);
      return notify(...items);
    };
    flush.mockImplementation(() => {
      flushedAt.push(clock.perfNow() - started);
    });

    await driver.applyWhiteboard({ open: true, upsertIds: ["box", "label"], drawMs: 200 });

    expect(publishedAt.length).toBeGreaterThan(1);
    expect(publishedAt).toEqual(publishedAt.map((_, index) => index * WHITEBOARD_DRAW_FRAME_MS));
    // Saved right after each step settles, at the step's own time.
    expect(flushedAt).toEqual(publishedAt);
    expect(flush).toHaveBeenCalledWith(whiteboardStore);
  });

  it("keeps each frame on its planned time when every timer fires late", async () => {
    let now = 0;
    const lateClock: RenderClock = {
      kind: "real",
      perfNow: () => now,
      wallNow: () => now,
      sleep: async (ms) => {
        now += ms + 7;
      },
      frame: async () => {},
    };
    const { driver, events } = makeDriver(ASSETS, lateClock);
    const publishedAt: number[] = [];
    const notify = events.push.bind(events);
    events.push = (...items) => {
      publishedAt.push(now);
      return notify(...items);
    };

    await driver.applyWhiteboard({ open: true, upsertIds: ["box", "label"], drawMs: 200 });

    // Frame k is one overshoot past k frames, never k overshoots.
    expect(publishedAt.length).toBeGreaterThan(2);
    expect(publishedAt).toEqual(
      publishedAt.map((_, index) => (index === 0 ? 0 : index * WHITEBOARD_DRAW_FRAME_MS + 7)),
    );
  });

  it("saves a one-step apply's canvas report too, and nothing on the real clock", async () => {
    const flush = vi.mocked(flushPendingWhiteboardChange);
    flush.mockReset();
    const virtual = makeDriver(ASSETS, createVirtualRenderClock());
    await virtual.driver.applyWhiteboard({ open: true, upsertIds: ["box"] });
    expect(flush).toHaveBeenCalledTimes(1);

    flush.mockReset();
    const real = makeDriver();
    await real.driver.applyWhiteboard({ open: true, upsertIds: ["box", "label"], drawMs: 100 });
    expect(flush).not.toHaveBeenCalled();
  });
});
