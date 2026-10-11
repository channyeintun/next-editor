import { describe, expect, it } from "vite-plus/test";
import {
  approach,
  edgePoint,
  fitsWithin,
  HOVER_RING_WIDTH,
  perimeterPercent,
  pixelNudge,
  ringRadius,
  ringShape,
  shortestTurn,
} from "./hoverRingMotion";

describe("edgePoint", () => {
  it("projects a point from the box's centre onto the edge it faces", () => {
    expect(edgePoint(100, 50, 90, 25)).toEqual({ x: 100, y: 25 });
    expect(edgePoint(100, 50, 50, 10)).toEqual({ x: 50, y: 0 });
    expect(edgePoint(100, 50, 50, 49)).toEqual({ x: 50, y: 50 });
    expect(edgePoint(100, 50, 0, 25)).toEqual({ x: 0, y: 25 });
  });

  it("puts the centre itself on the top edge", () => {
    expect(edgePoint(100, 50, 50, 25)).toEqual({ x: 50, y: 0 });
  });
});

describe("perimeterPercent", () => {
  const square = { width: 100, height: 50, radius: 0 };

  it("counts clockwise from the top-left corner of a square-cornered box", () => {
    expect(perimeterPercent(square, 50, 0)).toBeCloseTo((50 / 300) * 100);
    expect(perimeterPercent(square, 100, 25)).toBeCloseTo((125 / 300) * 100);
    expect(perimeterPercent(square, 50, 50)).toBeCloseTo((200 / 300) * 100);
    expect(perimeterPercent(square, 0, 25)).toBeCloseTo((275 / 300) * 100);
  });

  it("counts from where a rounded rect's outline starts: the end of its top-left curve", () => {
    // A pill: two straight 80px edges joined by half circles of radius 10.
    const pill = { width: 100, height: 20, radius: 10 };
    const total = 160 + 20 * Math.PI;
    expect(perimeterPercent(pill, 10, 0)).toBeCloseTo(0);
    expect(perimeterPercent(pill, 50, 0)).toBeCloseTo((40 / total) * 100);
    // The far tip of each half circle.
    expect(perimeterPercent(pill, 100, 10)).toBeCloseTo(((80 + 5 * Math.PI) / total) * 100);
    expect(perimeterPercent(pill, 0, 10)).toBeCloseTo(((160 + 15 * Math.PI) / total) * 100);
    expect(perimeterPercent(pill, 50, 20)).toBeCloseTo(((120 + 10 * Math.PI) / total) * 100);
  });

  it("rises steadily as the point walks clockwise round a rounded box", () => {
    const box = { width: 60, height: 28, radius: 6 };
    const points: Array<[number, number]> = [];
    for (let x = 7; x <= 60; x += 4) points.push([x, 0]);
    for (let y = 1; y <= 28; y += 3) points.push([60, y]);
    for (let x = 59; x >= 0; x -= 4) points.push([x, 28]);
    for (let y = 27; y >= 1; y -= 3) points.push([0, y]);
    const percents = points.map(([x, y]) => perimeterPercent(box, x, y));
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]);
    }
    expect(percents.at(-1)).toBeLessThan(100);
  });

  it("clamps a radius larger than the box allows", () => {
    expect(perimeterPercent({ width: 100, height: 20, radius: 9999 }, 50, 0)).toBeCloseTo(
      perimeterPercent({ width: 100, height: 20, radius: 10 }, 50, 0),
    );
  });

  it("is 0 for an empty box", () => {
    expect(perimeterPercent({ width: 0, height: 20, radius: 0 }, 5, 5)).toBe(0);
  });
});

describe("shortestTurn", () => {
  it("goes the short way round, across the start if need be", () => {
    expect(shortestTurn(10, 30)).toBe(20);
    expect(shortestTurn(30, 10)).toBe(-20);
    expect(shortestTurn(90, 10)).toBe(20);
    expect(shortestTurn(10, 90)).toBe(-20);
  });
});

describe("approach", () => {
  it("covers its rate's share each frame, then lands on the target", () => {
    const spring = { value: 0, target: 100 };
    expect(approach(spring, 0.25, 1)).toBe(true);
    expect(spring.value).toBeCloseTo(25);
    expect(approach(spring, 0.25, 2)).toBe(true);
    expect(spring.value).toBeCloseTo(100 - 75 * 0.75 * 0.75);
    while (approach(spring, 0.25, 4));
    expect(spring.value).toBe(100);
  });
});

describe("ringRadius", () => {
  it("is concentric with the host's corner, at the stroke's centre line", () => {
    expect(ringRadius("6px", 0, 40, 28)).toBe(6 - HOVER_RING_WIDTH / 2);
    expect(ringRadius("6px", 3, 46, 34)).toBe(9 - HOVER_RING_WIDTH / 2);
  });

  it("rounds a pill fully and resolves a percentage against the short side", () => {
    expect(ringRadius("3.35544e+07px", 0, 80, 27)).toBe(13.5);
    expect(ringRadius("50%", 0, 80, 27)).toBe(13);
  });

  it("is square for a square host", () => {
    expect(ringRadius("0px", 0, 24, 24)).toBe(0);
  });
});

describe("ringShape", () => {
  const host = { width: 40, height: 28, borderLeft: 0, borderTop: 0, radius: "6px", scale: 1 };

  it("sits on whole pixels, with the stroke inset by half its width", () => {
    const shape = ringShape(host, 0);
    expect(shape).toMatchObject({ left: 0, top: 0, outerWidth: 40, outerHeight: 28, stroke: 1 });
    expect(shape.ring).toEqual({ width: 39, height: 27, radius: 5.5 });
  });

  it("counts the gap from the border edge, outside any border", () => {
    const shape = ringShape({ ...host, borderLeft: 1, borderTop: 1, radius: "9999px" }, 2);
    // Placed from the padding box, one border in from the border edge.
    expect(shape).toMatchObject({ left: -3, top: -3, outerWidth: 44, outerHeight: 32 });
    expect(shape.ring.radius).toBe(15.5);
  });

  it("widens the stroke under a scaled-down ancestor so it stays a screen pixel", () => {
    const shape = ringShape({ ...host, scale: 0.5 }, 0);
    expect(shape.stroke).toBe(2);
    expect(shape.ring).toEqual({ width: 38, height: 26, radius: 5 });
  });
});

describe("pixelNudge", () => {
  it("moves each edge onto the nearest device pixel, in host pixels", () => {
    const box = { left: 10.4, top: 3, right: 97.1, bottom: 35 };
    const at1x = pixelNudge(box, 1, 1);
    expect(at1x.left).toBeCloseTo(-0.4);
    expect(at1x.right).toBeCloseTo(-0.1);
    expect(at1x.top).toBe(0);
    expect(pixelNudge(box, 2, 1).left).toBeCloseTo(0.1);
    // Under a half-size ancestor a screen pixel is two host pixels.
    expect(pixelNudge(box, 1, 0.5).left).toBeCloseTo(-0.8);
  });

  it("grows or shrinks the ring with its box", () => {
    const host = {
      width: 86.6,
      height: 28,
      borderLeft: 1,
      borderTop: 1,
      radius: "9999px",
      scale: 1,
    };
    const shape = ringShape(host, 2, { left: -0.4, top: 0, right: 0.2, bottom: 0 });
    expect(shape.left).toBeCloseTo(-3.4);
    expect(shape.outerWidth).toBeCloseTo(91.2);
    expect(shape.ring.width).toBeCloseTo(90.2);
  });
});

describe("fitsWithin", () => {
  const clip = { left: 0, top: 0, right: 100, bottom: 40 };

  it("lets an outside ring draw where the clip has room for it", () => {
    expect(fitsWithin({ left: 8, top: 4, right: 40, bottom: 36 }, clip)).toBe(true);
    // Subpixel layout: half a pixel over still counts as inside.
    expect(fitsWithin({ left: -0.4, top: 4, right: 40, bottom: 36 }, clip)).toBe(true);
  });

  it("does not where the clip would cut it", () => {
    expect(fitsWithin({ left: -2, top: 4, right: 40, bottom: 36 }, clip)).toBe(false);
    expect(fitsWithin({ left: 8, top: 4, right: 40, bottom: 42 }, clip)).toBe(false);
  });
});
