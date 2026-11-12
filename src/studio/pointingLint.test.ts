import { describe, expect, it } from "vite-plus/test";
import type { StudioPlan } from "./plan";
import { SLIDE_UNPOINTED_MAX_MS, pointingGaps } from "./pointingLint";

type Actions = StudioPlan["actions"];

const base = { timeoutMs: 10_000 };
const retry = { maxAttempts: 1, delayMs: 0 };

function planOf(
  actions: Actions,
  durationMs = 60_000,
  slides: StudioPlan["slides"] = [],
): Pick<StudioPlan, "actions" | "narration" | "slides"> {
  return {
    actions,
    slides,
    narration: { expectedDurationMs: durationMs } as StudioPlan["narration"],
  };
}

const show = (id: string, slideId: string, at: number): Actions[number] => ({
  ...base,
  id,
  at,
  type: "slide.show",
  slideId,
  maximized: true,
});

const pointSlide = (id: string, at: number): Actions[number] => ({
  ...base,
  id,
  at,
  type: "slide.point",
  target: { x: 0.2, y: 0.5 },
  durationMs: 800,
});

describe("pointingGaps", () => {
  it("flags a slide that stays up past the limit with nothing pointed at", () => {
    const warnings = pointingGaps(
      planOf([
        show("s1", "intro", 1_000),
        { ...base, id: "close", at: 1_000 + SLIDE_UNPOINTED_MAX_MS + 4_000, type: "slide.close" },
      ]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/slide "intro" stays up 12s/);
  });

  it("accepts a short slide and a pointed one", () => {
    const warnings = pointingGaps(
      planOf([
        show("s1", "title", 0),
        show("s2", "reasons", SLIDE_UNPOINTED_MAX_MS),
        pointSlide("p1", SLIDE_UNPOINTED_MAX_MS + 2_000),
        { ...base, id: "close", at: 50_000, type: "slide.close" },
      ]),
    );
    expect(warnings).toEqual([]);
  });

  it("judges each slide by itself: a point on one does not cover the next", () => {
    const warnings = pointingGaps(
      planOf([
        show("s1", "first", 0),
        pointSlide("p1", 2_000),
        show("s2", "second", 20_000),
        { ...base, id: "close", at: 45_000, type: "slide.close" },
      ]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/slide "second" stays up 25s/);
  });

  it("measures a slide that is never closed to the end of the narration", () => {
    const warnings = pointingGaps(planOf([show("s1", "outro", 40_000)], 60_000));
    expect(warnings[0]).toMatch(/slide "outro" stays up 20s/);
  });

  it("flags a preview whose elements are checked but never pointed at", () => {
    const actions: Actions = [
      { ...base, id: "open", at: 10_000, type: "preview.open", mode: "docked", retry },
      {
        ...base,
        id: "check",
        at: 12_000,
        type: "expect.preview",
        target: { by: "testId", value: "total" },
        textContains: "3",
        retry,
      },
    ];
    expect(pointingGaps(planOf(actions))).toEqual([
      expect.stringMatching(/the preview is open for 50s .* checks 1 with expect\.preview/),
    ]);

    const pointed: Actions = [
      ...actions,
      {
        ...base,
        id: "point",
        at: 13_000,
        type: "preview.point",
        target: { by: "testId", value: "total" },
        durationMs: 800,
      },
    ];
    expect(pointingGaps(planOf(pointed))).toEqual([]);
  });

  it("leaves a preview alone when the lesson only shows that it runs", () => {
    const actions: Actions = [
      { ...base, id: "open", at: 10_000, type: "preview.open", mode: "docked", retry },
      { ...base, id: "route", at: 12_000, type: "expect.preview", route: "/", retry },
    ];
    expect(pointingGaps(planOf(actions))).toEqual([]);
  });

  it("flags a markdown slide that is pointed at, once, and leaves html and deck slides alone", () => {
    const actions: Actions = [
      show("s1", "notes", 1_000),
      pointSlide("p1", 2_000),
      pointSlide("p2", 4_000),
      show("s2", "styled", 6_000),
      pointSlide("p3", 7_000),
      show("s3", "deck", 9_000),
      pointSlide("p4", 10_000),
      { ...base, id: "close", at: 12_000, type: "slide.close" },
    ];
    const slides: StudioPlan["slides"] = [
      { id: "notes", contentType: "markdown", content: "# Notes" },
      { id: "styled", contentType: "html", content: "<p>Styled</p>" },
      { id: "deck", contentType: "google-svg", content: "<svg/>" },
    ];

    expect(pointingGaps(planOf(actions, 60_000, slides))).toEqual([
      expect.stringMatching(/^slide "notes" is markdown and is pointed at/),
    ]);
  });
});
