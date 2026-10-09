import { describe, expect, it } from "vite-plus/test";
import { buildTimeline, sampleStyles, timeForRevealed } from "./animator";
import type { DeckStep } from "./types";

const steps: DeckStep[] = [
  // Step 0: fade el1 in over 400ms starting at 0.
  [
    {
      elementId: "el1",
      durationMs: 400,
      delayMs: 0,
      tracks: [{ kind: "opacity", from: 0, to: 1 }],
    },
  ],
  // Step 1: el2 opacity + scale, plus el3 translate delayed 100ms.
  [
    {
      elementId: "el2",
      durationMs: 200,
      delayMs: 0,
      tracks: [
        { kind: "opacity", from: 0, to: 1 },
        { kind: "scale", from: 0, to: 1 },
      ],
    },
    {
      elementId: "el3",
      durationMs: 200,
      delayMs: 100,
      tracks: [{ kind: "translate", fromX: 0, fromY: 1, toX: 0, toY: 0 }],
    },
  ],
];

describe("buildTimeline", () => {
  it("lays steps end to end and records step end times", () => {
    const tl = buildTimeline(steps);
    // Step 0 length = 400; step 1 length = max(0+200, 100+200) = 300.
    expect(tl.stepEndTimes).toEqual([400, 700]);
    expect(tl.total).toBe(700);
    const el3 = tl.entries.find((e) => e.entry.elementId === "el3");
    expect(el3).toMatchObject({ start: 500, end: 700 }); // 400 + delay 100 .. +200
  });

  // The steps reach the slide frame by postMessage, so buildTimeline validates
  // them instead of trusting the DeckStep type.
  it("clamps a delay or duration to 60 s", () => {
    const tl = buildTimeline([
      [{ elementId: "a", delayMs: 0, durationMs: 100000, tracks: [] }],
      [{ elementId: "b", delayMs: 100000, durationMs: 0, tracks: [] }],
    ]);
    expect(tl.stepEndTimes).toEqual([60000, 120000]);
    expect(tl.entries[0]).toMatchObject({ start: 0, end: 60000 });
    expect(tl.entries[1].entry).toMatchObject({ delayMs: 60000, durationMs: 0 });
  });

  it("reads at most 1000 steps", () => {
    const many: DeckStep[] = Array.from({ length: 1001 }, (_, index) => [
      { elementId: `e${index}`, delayMs: 0, durationMs: 1, tracks: [] },
    ]);
    const tl = buildTimeline(many);
    expect(tl.stepEndTimes).toHaveLength(1000);
    expect(tl.entries.some((e) => e.entry.elementId === "e1000")).toBe(false);
    expect(tl.total).toBe(1000);
  });

  it("drops entries without a string elementId and coerces a NaN delay to 0", () => {
    const tl = buildTimeline([
      [
        { elementId: 7, delayMs: 0, durationMs: 100, tracks: [] },
        { elementId: "x".repeat(1025), delayMs: 0, durationMs: 100, tracks: [] },
        { elementId: "ok", delayMs: Number.NaN, durationMs: 50, tracks: [] },
      ],
    ]);
    expect(tl.entries.map((e) => e.entry.elementId)).toEqual(["ok"]);
    expect(tl.entries[0]).toMatchObject({ start: 0, end: 50 });
    expect(tl.total).toBe(50);
  });

  it("keeps only the first four known tracks, with non-finite numbers as 0", () => {
    const tl = buildTimeline([
      [
        {
          elementId: "a",
          delayMs: 0,
          durationMs: 10,
          tracks: [
            { kind: "rotate", from: 0, to: 1 },
            { kind: "opacity", from: Number.POSITIVE_INFINITY, to: 1 },
            null,
            { kind: "translate", fromX: "1", fromY: 0, toX: 1, toY: 1 },
            { kind: "scale", from: 0, to: 1 },
          ],
        },
      ],
    ]);
    expect(tl.entries[0].entry.tracks).toEqual([
      { kind: "opacity", from: 0, to: 1 },
      { kind: "translate", fromX: 0, fromY: 0, toX: 1, toY: 1 },
    ]);
  });

  it("returns an empty timeline for anything but an array of steps", () => {
    expect(buildTimeline(undefined)).toEqual({ entries: [], stepEndTimes: [], total: 0 });
    expect(buildTimeline([null])).toEqual({ entries: [], stepEndTimes: [0], total: 0 });
  });
});

describe("timeForRevealed", () => {
  const tl = buildTimeline(steps);
  it("maps reveal counts to timeline positions", () => {
    expect(timeForRevealed(tl, 0)).toBe(0);
    expect(timeForRevealed(tl, 1)).toBe(400);
    expect(timeForRevealed(tl, 2)).toBe(700);
    expect(timeForRevealed(tl, 5)).toBe(700); // clamped
  });
});

describe("sampleStyles", () => {
  const tl = buildTimeline(steps);

  it("keeps everything hidden at t=0", () => {
    const s = sampleStyles(tl, 0);
    expect(s.get("el1")?.opacity).toBe(0);
    expect(s.get("el2")?.opacity).toBe(0);
  });

  it("interpolates opacity linearly at the midpoint", () => {
    const s = sampleStyles(tl, 200); // halfway through el1's 400ms fade
    expect(s.get("el1")?.opacity).toBeCloseTo(0.5, 5);
  });

  it("fully reveals step 0 at its end time", () => {
    const s = sampleStyles(tl, 400);
    expect(s.get("el1")?.opacity).toBe(1);
  });

  it("does not combine scale and translate: opacity stays separate, transform is scale alone", () => {
    const s = sampleStyles(tl, 700); // fully revealed
    expect(s.get("el2")?.opacity).toBe(1);
    expect(s.get("el2")?.transform).toBe("scale(1)");
    // el3 ends at translate(0%, 0%).
    expect(s.get("el3")?.transform).toBe("translate(0%, 0%)");
  });

  it("when an entry has both scale and translate tracks, the later track in entry.tracks wins (no combined string)", () => {
    // scale listed after translate -> transform should be the scale string,
    // never a combination of both.
    const tlScaleLast = buildTimeline([
      [
        {
          elementId: "x",
          durationMs: 100,
          delayMs: 0,
          tracks: [
            { kind: "translate", fromX: 0, fromY: 0, toX: 1, toY: 1 },
            { kind: "scale", from: 0, to: 1 },
          ],
        },
      ],
    ]);
    const sScaleLast = sampleStyles(tlScaleLast, 100);
    expect(sScaleLast.get("x")?.transform).toBe("scale(1)");

    // translate listed after scale -> transform should be the translate string.
    const tlTranslateLast = buildTimeline([
      [
        {
          elementId: "x",
          durationMs: 100,
          delayMs: 0,
          tracks: [
            { kind: "scale", from: 0, to: 1 },
            { kind: "translate", fromX: 0, fromY: 0, toX: 1, toY: 1 },
          ],
        },
      ],
    ]);
    const sTranslateLast = sampleStyles(tlTranslateLast, 100);
    expect(sTranslateLast.get("x")?.transform).toBe("translate(100%, 100%)");
  });

  it("eases scale/translate (not linear) mid-step", () => {
    const tl2 = buildTimeline([
      [
        {
          elementId: "x",
          durationMs: 100,
          delayMs: 0,
          tracks: [{ kind: "scale", from: 0, to: 1 }],
        },
      ],
    ]);
    const s = sampleStyles(tl2, 25); // 25% linear -> easeInOutCubic(0.25) = 0.0625
    expect(s.get("x")?.transform).toBe("scale(0.0625)");
  });
});
