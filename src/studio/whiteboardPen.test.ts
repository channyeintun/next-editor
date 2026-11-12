import { describe, expect, it } from "vite-plus/test";
import type { MeasureTextLine } from "../utils/whiteboardTextFit";
import { studioWhiteboardAssetSchema } from "./plan";
import {
  penDrawProgress,
  penDrawsApply,
  penHoldsButton,
  whiteboardPenPoint,
  whiteboardPenStart,
  whiteboardPointAim,
} from "./whiteboardPen";
import { whiteboardStrokeTip } from "./whiteboardAssets";

// Ten units per character keeps every expected x a round number.
const measure: MeasureTextLine = (_font: string, line: string) => line.length * 10;

const asset = (fields: Record<string, unknown>) =>
  studioWhiteboardAssetSchema.parse({ id: "a", x: 300, y: 200, width: 200, height: 80, ...fields });

const RECT = asset({ kind: "rectangle" });
const TEXT = asset({ kind: "text", width: 400, height: 40, text: "x" });
const STROKE = asset({ kind: "freedraw", stroke: "arrow-up-right" });

const text = (fields: Record<string, unknown>) =>
  asset({ kind: "text", width: 400, height: 40, ...fields });

describe("pen gating", () => {
  it("draws only when an asset has enough steps", () => {
    expect(penDrawsApply(5)).toBe(false);
    expect(penDrawsApply(6)).toBe(true);
  });

  it("holds the button for shapes and strokes, not for text", () => {
    expect(penHoldsButton(TEXT)).toBe(false);
    expect(penHoldsButton(RECT)).toBe(true);
    expect(penHoldsButton(STROKE)).toBe(true);
  });
});

describe("penDrawProgress", () => {
  it("returns null while the pen is on its way, then rises to exactly 1", () => {
    for (const step of [1, 2, 3]) expect(penDrawProgress(RECT, step, 9, 3)).toBeNull();
    const values: number[] = [];
    for (let step = 4; step <= 9; step++) {
      const value = penDrawProgress(RECT, step, 9, 3);
      expect(value).not.toBeNull();
      values.push(value as number);
    }
    for (const value of values) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // Strictly rising: sorting and removing repeats changes nothing.
    expect([...new Set(values)].sort((a, b) => a - b)).toEqual(values);
    expect(values[values.length - 1]).toBe(1);
  });

  it("puts something on the board at the first step without a lead", () => {
    const first = penDrawProgress(RECT, 1, 9, 0) as number;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.2);
  });

  it("types text at a steady rate", () => {
    for (let step = 4; step <= 9; step++) {
      expect(penDrawProgress(TEXT, step, 9, 3) as number).toBeCloseTo((step - 3) / 6, 6);
    }
  });

  it("eases a stroke through a smoothstep with its midpoint at half", () => {
    expect(penDrawProgress(STROKE, 5, 10, 0) as number).toBeCloseTo(0.5, 5);
  });

  it("front-loads a shape's drag", () => {
    expect(penDrawProgress(RECT, 5, 10, 0) as number).toBeGreaterThan(0.6);
  });
});

describe("shape and stroke pen points", () => {
  it("drags a rectangle out from its corner", () => {
    expect(whiteboardPenPoint(RECT, 7, 0.5)).toEqual({ x: 400, y: 240 });
    expect(whiteboardPenPoint(RECT, 7, 1)).toEqual({ x: 500, y: 280 });
    expect(whiteboardPenStart(RECT, 7)).toEqual({ x: 300, y: 200 });
  });

  it("follows the stroke tip for a freedraw asset", () => {
    for (const progress of [0.3, 1]) {
      expect(whiteboardPenPoint(STROKE, 7, progress)).toEqual(
        whiteboardStrokeTip(STROKE, 7, progress),
      );
    }
    expect(whiteboardPenStart(STROKE, 7)).toEqual(whiteboardStrokeTip(STROKE, 7, 0));
  });
});

describe("text pen points", () => {
  it("sits just past the last typed character of a left-aligned line", () => {
    const left = text({ text: "hello world", fontSize: 30 });
    expect(whiteboardPenPoint(left, 7, 1, measure)).toEqual({ x: 413, y: 224 });
    // ceil(11 * 0.5) = 6 characters: "hello ".
    expect(whiteboardPenPoint(left, 7, 0.5, measure).x).toBe(363);
    expect(whiteboardPenStart(left, 7, measure)).toEqual({ x: 300, y: 224 });
  });

  it("moves to the second line once it is typed", () => {
    const two = text({ text: "ab\ncdef", fontSize: 20 });
    expect(whiteboardPenPoint(two, 7, 1, measure)).toEqual({ x: 343, y: 241 });
  });

  it("centres a line on the middle of the box", () => {
    const centered = text({ text: "abcd", align: "center" });
    expect(whiteboardPenPoint(centered, 7, 1, measure).x).toBe(523);
    expect(whiteboardPenStart(centered, 7, measure).x).toBe(480);
  });

  it("right-aligns a line to the box edge", () => {
    const right = text({ text: "abcd", align: "right" });
    expect(whiteboardPenPoint(right, 7, 1, measure).x).toBe(703);
    expect(whiteboardPenStart(right, 7, measure).x).toBe(660);
  });

  it("falls back to the share of the box without a measurer", () => {
    const plain = text({ text: "abcd" });
    expect(whiteboardPenPoint(plain, 7, 0.5).x).toBe(503);
  });
});

describe("whiteboardPointAim", () => {
  it("aims at the middle of a shape's bottom edge", () => {
    expect(whiteboardPointAim(RECT)).toEqual({ x: 400, y: 280 });
  });

  it("aims below the middle of a left-aligned text line", () => {
    const one = text({ text: "abcd", fontSize: 20 });
    expect(whiteboardPointAim(one, measure)).toEqual({ x: 320, y: 228 });
  });

  it("aims at the last line of multi-line text", () => {
    const two = text({ text: "ab\ncdef", fontSize: 20 });
    expect(whiteboardPointAim(two, measure)).toEqual({ x: 320, y: 253 });
  });

  it("aims at the middle of centred text", () => {
    const centered = text({ text: "abcd", fontSize: 20, align: "center" });
    expect(whiteboardPointAim(centered, measure).x).toBe(500);
  });
});
