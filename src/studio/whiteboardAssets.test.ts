import { describe, expect, it } from "vite-plus/test";
import { studioWhiteboardAssetSchema } from "./plan";
import {
  WHITEBOARD_DRAW_FRAME_MS,
  buildWhiteboardElement,
  planWhiteboardDrawFrames,
  whiteboardDrawDurationMs,
} from "./whiteboardAssets";

const RECT = studioWhiteboardAssetSchema.parse({
  id: "box",
  kind: "rectangle",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
});

const TEXT = studioWhiteboardAssetSchema.parse({
  id: "label",
  kind: "text",
  x: 15,
  y: 25,
  width: 90,
  height: 30,
  text: "hello",
  fontSize: 24,
});

const STROKE = studioWhiteboardAssetSchema.parse({
  id: "mark",
  kind: "freedraw",
  stroke: "underline",
  x: 30,
  y: 40,
  width: 180,
  height: 24,
});

describe("buildWhiteboardElement", () => {
  it("is deterministic for the same plan seed", () => {
    expect(buildWhiteboardElement(RECT, 7)).toEqual(buildWhiteboardElement(RECT, 7));
  });

  it("varies seeds per asset and per plan seed", () => {
    const rect = buildWhiteboardElement(RECT, 7);
    const text = buildWhiteboardElement(TEXT, 7);
    const rectOtherPlan = buildWhiteboardElement(RECT, 8);
    expect(rect.seed).not.toBe(text.seed);
    expect(rect.seed).not.toBe(rectOtherPlan.seed);
  });

  it("produces render-ready Excalidraw fields", () => {
    const rect = buildWhiteboardElement(RECT, 7);
    expect(rect).toMatchObject({
      id: "box",
      type: "rectangle",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      version: 1,
      isDeleted: false,
    });
    expect(typeof rect.versionNonce).toBe("number");

    const text = buildWhiteboardElement(TEXT, 7);
    expect(text).toMatchObject({
      type: "text",
      text: "hello",
      originalText: "hello",
      fontSize: 24,
    });
  });

  it("builds a freedraw stroke as points relative to where the pen landed", () => {
    const stroke = buildWhiteboardElement(STROKE, 7);
    const points = stroke.points as [number, number][];
    expect(stroke.type).toBe("freedraw");
    expect(points[0]).toEqual([0, 0]);
    expect(points.length).toBeGreaterThan(16);
    // The stroke stays inside its authored box (plus the hand's waver).
    expect(stroke.x as number).toBeGreaterThanOrEqual(STROKE.x - 4);
    expect(Math.max(...points.map(([x]) => x))).toBeLessThanOrEqual(STROKE.width + 4);
  });
});

describe("buildWhiteboardElement frames", () => {
  it("grows a shape from its anchor corner", () => {
    const half = buildWhiteboardElement(RECT, 7, { progress: 0.5, version: 1 });
    expect(half).toMatchObject({ x: 10, y: 20, width: 50, height: 25, version: 1 });
  });

  it("types text a prefix at a time and keeps the box stable", () => {
    const partial = buildWhiteboardElement(TEXT, 7, { progress: 0.5, version: 3 });
    expect(partial).toMatchObject({
      text: "hel",
      originalText: "hel",
      width: 90,
      height: 30,
      version: 3,
    });
  });

  it("reveals a stroke as a growing prefix of the same path", () => {
    const full = buildWhiteboardElement(STROKE, 7).points as [number, number][];
    const partial = buildWhiteboardElement(STROKE, 7, { progress: 0.4, version: 1 }).points as [
      number,
      number,
    ][];
    expect(partial.length).toBeGreaterThan(1);
    expect(partial.length).toBeLessThan(full.length);
    expect(partial).toEqual(full.slice(0, partial.length));
  });

  it("ends a drawn element exactly where an undrawn one starts", () => {
    // Only the version differs — otherwise the board would settle onto a
    // different element than an instant apply of the same asset produces, and
    // roughjs would redraw its sketch lines on the last frame.
    for (const asset of [RECT, TEXT, STROKE]) {
      const drawn = buildWhiteboardElement(asset, 7, { progress: 1, version: 4 });
      expect({ ...drawn, version: 1 }).toEqual(buildWhiteboardElement(asset, 7));
    }
  });

  it("keeps the sketch seed steady across frames", () => {
    const first = buildWhiteboardElement(RECT, 7, { progress: 0.2, version: 1 });
    const last = buildWhiteboardElement(RECT, 7, { progress: 1, version: 5 });
    expect(first.seed).toBe(last.seed);
    expect(first.versionNonce).toBe(last.versionNonce);
  });
});

describe("planWhiteboardDrawFrames", () => {
  it("does not animate without a draw budget", () => {
    expect(planWhiteboardDrawFrames(3, 0)).toEqual([]);
    expect(planWhiteboardDrawFrames(0, 800)).toEqual([]);
  });

  it("draws one asset at a time, each finishing at full progress", () => {
    const frames = planWhiteboardDrawFrames(2, 200);
    expect(frames).toEqual([
      { assetIndex: 0, progress: 0.5, version: 1 },
      { assetIndex: 0, progress: 1, version: 2 },
      { assetIndex: 1, progress: 0.5, version: 1 },
      { assetIndex: 1, progress: 1, version: 2 },
    ]);
  });

  it("spends the budget across the assets rather than per asset", () => {
    expect(whiteboardDrawDurationMs(4, 800)).toBe(800);
    expect(whiteboardDrawDurationMs(1, 800)).toBe(800);
  });

  it("still staggers when there are more assets than frames in the budget", () => {
    const frames = planWhiteboardDrawFrames(9, 100);
    expect(frames.map((frame) => frame.assetIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(frames.every((frame) => frame.progress === 1)).toBe(true);
    expect(whiteboardDrawDurationMs(9, 100)).toBe(9 * WHITEBOARD_DRAW_FRAME_MS);
  });
});
