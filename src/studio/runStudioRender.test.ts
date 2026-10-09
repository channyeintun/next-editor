import { describe, expect, it, vi } from "vite-plus/test";
import { sha256HexOfJson } from "./hash";
import type { StudioPlan } from "./plan";
import {
  narrationTimelineOnRecordingClock,
  runStudioRender,
  type StudioRunDeps,
} from "./runStudioRender";

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

describe("runStudioRender report timing", () => {
  it("times the report from the caller's start, so it covers synthesis", async () => {
    const startedAt = {
      iso: "2026-10-01T00:00:00.000Z",
      performanceNowMs: performance.now() - 5_000,
    };
    // A WebContainer render asked to replay a fixture fails at preflight,
    // before any dependency is touched.
    const failingPlan = {
      ...plan,
      lesson: { slug: "react-counter", title: "Counter", locale: "en" },
      seed: 1,
      workspace: { files: {} },
      runtime: { kind: "webcontainer" },
      dependencies: {},
    } as unknown as StudioPlan;
    const result = await runStudioRender(
      failingPlan,
      "fixture",
      {} as StudioRunDeps,
      // Preflight fails before the narration is read.
      {
        startedAt,
        narration: { blob: new Blob(), bytes: new Uint8Array(), audioSha256: "0".repeat(64) },
      },
    );

    expect(result.report.outcome).toBe("failed");
    expect(result.report.errors).toEqual([
      'WebContainer Studio renders require runtime mode "live"',
    ]);
    expect(result.report.startedAtIso).toBe(startedAt.iso);
    expect(result.report.wallDurationMs).toBeGreaterThanOrEqual(5_000);
    // The narration is not taken up before preflight passes.
    expect(result.manifest.planHash).toBe(await sha256HexOfJson(failingPlan));
    expect(result.manifest.narrationAudioHash).toBe("unfetched");
  });
});
