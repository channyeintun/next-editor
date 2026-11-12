import { describe, expect, it } from "vite-plus/test";
import { studioWhiteboardAssetSchema, studioWhiteboardStrokeSchema } from "./plan";
import { buildWhiteboardElement, whiteboardStrokeTip } from "./whiteboardAssets";

type Pt = [number, number];

const strokeAsset = (stroke: string, id = "s") =>
  studioWhiteboardAssetSchema.parse({
    id,
    kind: "freedraw",
    stroke,
    x: 300,
    y: 200,
    width: 200,
    height: 80,
  });

// Absolute scene points of a freedraw element: its points are relative to its x/y.
function absolutePoints(stroke: string, seed = 7): Pt[] {
  const element = buildWhiteboardElement(strokeAsset(stroke), seed) as unknown as {
    x: number;
    y: number;
    points: Pt[];
  };
  return element.points.map(([px, py]) => [element.x + px, element.y + py]);
}

const near = (p: Pt, x: number, y: number, tolerance: number) =>
  Math.abs(p[0] - x) <= tolerance && Math.abs(p[1] - y) <= tolerance;

describe("freedraw stroke presets", () => {
  for (const stroke of studioWhiteboardStrokeSchema.options) {
    it(`${stroke} is a thin stroke inside its box`, () => {
      const element = buildWhiteboardElement(strokeAsset(stroke), 7) as unknown as {
        type: string;
        strokeWidth: number;
        x: number;
        y: number;
        points: Pt[];
      };
      expect(element.type).toBe("freedraw");
      expect(element.strokeWidth).toBe(1);
      expect(Array.isArray(element.points)).toBe(true);
      expect(element.points.length).toBeGreaterThanOrEqual(16);
      for (const [px, py] of element.points) {
        expect(Number.isFinite(px)).toBe(true);
        expect(Number.isFinite(py)).toBe(true);
      }
      expect(element.points[0]).toEqual([0, 0]);
      for (const [px, py] of element.points) {
        const x = element.x + px;
        const y = element.y + py;
        expect(x).toBeGreaterThanOrEqual(300 - 12);
        expect(x).toBeLessThanOrEqual(500 + 12);
        expect(y).toBeGreaterThanOrEqual(200 - 12);
        expect(y).toBeLessThanOrEqual(280 + 12);
      }
    });
  }

  it("builds the same element twice and a different one for another plan seed", () => {
    const asset = strokeAsset("wavy");
    expect(buildWhiteboardElement(asset, 7)).toEqual(buildWhiteboardElement(asset, 7));
    const a = buildWhiteboardElement(asset, 7) as unknown as { points: Pt[] };
    const b = buildWhiteboardElement(asset, 8) as unknown as { points: Pt[] };
    expect(a.points).not.toEqual(b.points);
  });

  it("arrow-left starts at the right and reaches the left edge", () => {
    const points = absolutePoints("arrow-left");
    expect(points[0][0]).toBeGreaterThan(480);
    expect(Math.min(...points.map((p) => p[0]))).toBeLessThan(310);
  });

  it("arrow-up starts at the bottom and reaches the top edge", () => {
    const points = absolutePoints("arrow-up");
    expect(points[0][1]).toBeGreaterThan(265);
    expect(Math.min(...points.map((p) => p[1]))).toBeLessThan(210);
  });

  it("arrow-up-right runs from the bottom-left to the top-right corner", () => {
    const points = absolutePoints("arrow-up-right");
    expect(points[0][0]).toBeLessThan(315);
    expect(points[0][1]).toBeGreaterThan(265);
    expect(points.some((p) => near(p, 500, 200, 12))).toBe(true);
  });

  it("arrow-down-left runs from the top-right to the bottom-left corner", () => {
    const points = absolutePoints("arrow-down-left");
    expect(points[0][0]).toBeGreaterThan(485);
    expect(points[0][1]).toBeLessThan(215);
    expect(points.some((p) => near(p, 300, 280, 12))).toBe(true);
  });

  it("arrow-arc-right leaves bottom-left, tops out on the top edge, lands bottom-right", () => {
    const points = absolutePoints("arrow-arc-right");
    expect(points[0][0]).toBeLessThan(312);
    expect(points[0][1]).toBeGreaterThan(268);
    expect(Math.min(...points.map((p) => p[1]))).toBeLessThanOrEqual(212);
    expect(points.some((p) => near(p, 500, 280, 12))).toBe(true);
  });

  it("arrow-arc-left leaves top-right, dips to the bottom edge, lands top-left", () => {
    const points = absolutePoints("arrow-arc-left");
    expect(points[0][0]).toBeGreaterThan(488);
    expect(points[0][1]).toBeLessThan(212);
    expect(Math.max(...points.map((p) => p[1]))).toBeGreaterThanOrEqual(268);
    expect(points.some((p) => near(p, 300, 200, 12))).toBe(true);
  });

  it("brace-right points right at the vertical middle", () => {
    const points = absolutePoints("brace-right");
    expect(points[0][0]).toBeLessThan(312);
    expect(points.some((p) => p[0] >= 488 && Math.abs(p[1] - 240) <= 15)).toBe(true);
  });

  it("brace-down points down at the horizontal middle", () => {
    const points = absolutePoints("brace-down");
    const lowest = points.reduce((best, p) => (p[1] > best[1] ? p : best));
    expect(Math.abs(lowest[0] - 400)).toBeLessThanOrEqual(20);
  });

  it("wavy changes vertical direction repeatedly", () => {
    const points = absolutePoints("wavy");
    let flips = 0;
    let previous = 0;
    for (let i = 1; i < points.length; i++) {
      const dy = points[i][1] - points[i - 1][1];
      if (dy === 0) continue;
      const sign = Math.sign(dy);
      if (previous !== 0 && sign !== previous) flips += 1;
      previous = sign;
    }
    expect(flips).toBeGreaterThanOrEqual(6);
  });

  it("scribble spans the upper and lower parts of the box", () => {
    const ys = absolutePoints("scribble").map((p) => p[1]);
    expect(Math.min(...ys)).toBeLessThan(225);
    expect(Math.max(...ys)).toBeGreaterThan(255);
  });
});

describe("partial stroke frames", () => {
  it("a partial frame is a prefix of the full stroke", () => {
    const asset = strokeAsset("arrow-up-right");
    const full = buildWhiteboardElement(asset, 7) as unknown as { points: Pt[] };
    const partial = buildWhiteboardElement(asset, 7, { progress: 0.5, version: 4 }) as unknown as {
      points: Pt[];
      version: number;
    };
    const count = partial.points.length;
    expect(partial.points).toEqual(full.points.slice(0, count));
    expect(count).toBeGreaterThanOrEqual(full.points.length * 0.4);
    expect(count).toBeLessThanOrEqual(full.points.length * 0.6);
    expect(partial.version).toBe(4);
  });

  it("the stroke tip follows the first and last point of the element", () => {
    const asset = strokeAsset("arrow-up-right");
    const element = buildWhiteboardElement(asset, 7) as unknown as {
      x: number;
      y: number;
      points: Pt[];
    };
    const last = element.points[element.points.length - 1];

    const end = whiteboardStrokeTip(asset, 7, 1);
    expect(end.x).toBeCloseTo(element.x + last[0], 6);
    expect(end.y).toBeCloseTo(element.y + last[1], 6);

    const start = whiteboardStrokeTip(asset, 7, 0);
    expect(start.x).toBeCloseTo(element.x, 6);
    expect(start.y).toBeCloseTo(element.y, 6);
  });
});

describe("shape style fields", () => {
  const shape = (extra: Record<string, unknown>) =>
    studioWhiteboardAssetSchema.parse({
      id: "shape",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      ...extra,
    });

  it("applies rounding, dash, fill style and fill colour to a rectangle", () => {
    const element = buildWhiteboardElement(
      shape({
        kind: "rectangle",
        rounded: true,
        strokeStyle: "dashed",
        backgroundColor: "#a5d8ff",
        fillStyle: "hachure",
      }),
      7,
    );
    expect(element.roundness).toEqual({ type: 3 });
    expect(element.strokeStyle).toBe("dashed");
    expect(element.fillStyle).toBe("hachure");
    expect(element.backgroundColor).toBe("#a5d8ff");
    expect(element.strokeWidth).toBe(2);
  });

  it("leaves a default rectangle square, solid and solid-filled", () => {
    const element = buildWhiteboardElement(shape({ kind: "rectangle" }), 7);
    expect(element.roundness).toBeNull();
    expect(element.strokeStyle).toBe("solid");
    expect(element.fillStyle).toBe("solid");
  });

  it("rounds a diamond with the proportional rule", () => {
    const element = buildWhiteboardElement(shape({ kind: "diamond", rounded: true }), 7);
    expect(element.type).toBe("diamond");
    expect(element.roundness).toEqual({ type: 2 });
  });

  it("never rounds an ellipse", () => {
    const element = buildWhiteboardElement(shape({ kind: "ellipse", rounded: true }), 7);
    expect(element.roundness).toBeNull();
  });
});

describe("text alignment", () => {
  const text = (extra: Record<string, unknown> = {}) =>
    studioWhiteboardAssetSchema.parse({
      id: "t",
      kind: "text",
      x: 0,
      y: 0,
      width: 200,
      height: 40,
      text: "hi",
      ...extra,
    });

  it("carries the authored alignment", () => {
    expect(buildWhiteboardElement(text({ align: "center" }), 7).textAlign).toBe("center");
  });

  it("defaults to left with the Virgil font and 1.25 line height", () => {
    const element = buildWhiteboardElement(text(), 7);
    expect(element.textAlign).toBe("left");
    expect(element.fontFamily).toBe(1);
    expect(element.lineHeight).toBe(1.25);
  });
});

describe("asset schema", () => {
  const base = { id: "a", kind: "freedraw", x: 0, y: 0, width: 10, height: 10 };

  it("rejects an unknown stroke name", () => {
    expect(studioWhiteboardAssetSchema.safeParse({ ...base, stroke: "zigzag-arrow" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown fill style", () => {
    expect(studioWhiteboardAssetSchema.safeParse({ ...base, fillStyle: "dots" }).success).toBe(
      false,
    );
  });
});
