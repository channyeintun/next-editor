// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { StudioAutomationLessonChange } from "../../src/studio/studioWindowHandle.ts";
import { replacementOutcome } from "./updateOutcome.ts";

const change: StudioAutomationLessonChange = {
  lessonId: "l1",
  urlSlug: "rust-borrow",
  changedCues: 2,
  totalCues: 19,
  examples: [],
  publishedDurationMs: 60_000,
  newDurationMs: 61_000,
};

describe("update --replace outcome", () => {
  it("says a replace keeps the earlier narration for viewers already watching", () => {
    expect(
      replacementOutcome({
        replaced: { ...change, audioFile: "b.ogg", previousAudioFile: "a.ogg" },
      }),
    ).toEqual({
      ok: true,
      lines: [
        "replaced: /learn/rust-borrow now plays this render",
        "narration: b.ogg; the earlier a.ogg is kept for viewers who opened the lesson before the change",
      ],
    });
  });

  it("names no earlier file when the lesson had no other one", () => {
    const outcome = replacementOutcome({
      replaced: { ...change, audioFile: "b.ogg", previousAudioFile: null },
    });
    expect(outcome.lines[1]).toBe(
      "narration: b.ogg (the lesson named no other narration file before)",
    );
  });

  it("says an unchanged lesson had nothing written", () => {
    expect(replacementOutcome({ unchanged: change })).toEqual({
      ok: true,
      lines: [
        "unchanged: /learn/rust-borrow already plays exactly this render; nothing was written",
      ],
    });
  });

  it("fails a refused replace with the studio's reason", () => {
    expect(replacementOutcome({ refused: "Sign in first." })).toEqual({
      ok: false,
      lines: ["refused, nothing replaced: Sign in first."],
    });
  });
});
