import { describe, expect, it, vi } from "vite-plus/test";
import { narrationTimelineOnRecordingClock } from "./runStudioRender";

vi.mock("../monaco", () => ({
  monaco: {},
  workspacePathFromMonacoModelUri: vi.fn<() => string | null>(),
}));

const plan = {
  narration: {
    audioPath: "narration.wav",
    mimeType: "audio/wav",
    expectedDurationMs: 10_000,
    captions: {
      id: "en",
      language: "en",
      cues: [
        {
          start: 0,
          end: 1_000,
          text: "Hello there",
          words: [
            { start: 0, end: 400, text: "Hello" },
            { start: 400, end: 1_000, text: "there" },
          ],
        },
        { start: 1_200, end: 2_000, text: "Bye" },
      ],
    },
  },
  chapters: [{ time: 1_200, title: "Ending" }],
};

describe("narrationTimelineOnRecordingClock", () => {
  it("attaches the plan's own timeline when narration starts with the recording", () => {
    const result = narrationTimelineOnRecordingClock(plan, 0);
    expect(result.captions).toBe(plan.narration.captions);
    expect(result.chapters).toBe(plan.chapters);
  });

  it("shifts cues, word timings and chapters by the audio start offset", () => {
    const result = narrationTimelineOnRecordingClock(plan, 250);
    expect(result.captions.cues).toEqual([
      {
        start: 250,
        end: 1_250,
        text: "Hello there",
        words: [
          { start: 250, end: 650, text: "Hello" },
          { start: 650, end: 1_250, text: "there" },
        ],
      },
      { start: 1_450, end: 2_250, text: "Bye" },
    ]);
    expect(result.captions.id).toBe("en");
    expect(result.chapters).toEqual([{ time: 1_450, title: "Ending" }]);
    // The plan itself stays on the narration clock.
    expect(plan.narration.captions.cues[0]?.start).toBe(0);
  });
});
