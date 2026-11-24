import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { workspacePathFromMonacoModelUri } from "../monaco";
import { waitUntil } from "./async";
import { sha256HexOfJson } from "./hash";
import type { StudioPlan } from "./plan";
import {
  narrationTimelineOnRecordingClock,
  renderClockFor,
  runStudioRender,
  WAITING_FOR_VISIBLE_TAB_PHASE,
  type StudioRunDeps,
} from "./runStudioRender";
import { encodeWavPcm16 } from "./tts/wav";

// waitUntil runs as written; the tests read the options each wait was given.
vi.mock("./async", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./async")>();
  return { ...actual, waitUntil: vi.fn<typeof actual.waitUntil>(actual.waitUntil) };
});

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
    // A Node.js runtime render asked to replay a fixture fails at preflight,
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
      'Studio renders of a Node.js lesson require runtime mode "live"',
    ]);
    expect(result.report.startedAtIso).toBe(startedAt.iso);
    expect(result.report.wallDurationMs).toBeGreaterThanOrEqual(5_000);
    // The narration is not taken up before preflight passes.
    expect(result.manifest.planHash).toBe(await sha256HexOfJson(failingPlan));
    expect(result.manifest.narrationAudioHash).toBe("unfetched");
    // Nothing was performed, so the render names no clock, though full speed was not
    // even asked for.
    expect(result.report.clock).toBeNull();
    expect(result.manifest.environment.clock).toBeNull();
  });
});

describe("runStudioRender visible-tab gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const entryFilePath = "src/main.rs";
  const gatedPlan = {
    ...plan,
    lesson: { slug: "gate", title: "Gate", locale: "en" },
    seed: 1,
    workspace: { name: "Gate", lessonType: "rust", entryFilePath, files: { [entryFilePath]: "" } },
    runtime: { kind: "none" },
    actions: [],
    slides: [],
    whiteboardAssets: [],
    dependencies: {},
  } as unknown as StudioPlan;

  /**
   * Deps that carry a render through workspace pinning to startRecording, where
   * the recorder reports an error so the render ends without performing.
   */
  function depsUpToRecording({ cameraOn = false } = {}) {
    const phases: string[] = [];
    let projectId = "";
    vi.mocked(workspacePathFromMonacoModelUri).mockReturnValue(entryFilePath);
    const startRecording = vi.fn<() => void>(() => {
      phases.push("startRecording called");
    });
    const setPreviewState = vi.fn<() => void>();
    const startSidebarCollapsed = vi.fn<() => void>();
    const deps = {
      actor: {
        getSnapshot: () => ({
          context: { error: "stopped by the test", defaultEnableCameraRecording: cameraOn },
          matches: () => false,
        }),
      },
      nextEditor: { clearRecording: vi.fn<() => void>(), startRecording },
      getEditor: () => ({ getModel: () => ({ uri: {} }) }),
      workspace: {
        loadProject: (project: { id: string }) => {
          projectId = project.id;
        },
        getProject: () => ({ id: projectId }),
        startSidebarCollapsed,
      },
      runtimePanelStore: { trigger: { setIsCollapsed: vi.fn<() => void>() } },
      slidesStore: { trigger: { setSlides: vi.fn<() => void>(), setPreviewState } },
      whiteboardStore: { trigger: { setScene: vi.fn<() => void>() } },
      preview: { close: vi.fn<() => void>(), getState: () => null },
      onPhase: (name: string) => phases.push(name),
    } as unknown as StudioRunDeps;
    return { deps, phases, startRecording, setPreviewState, startSidebarCollapsed };
  }

  const narration = {
    narration: { blob: new Blob(), bytes: new Uint8Array(), audioSha256: "0".repeat(64) },
  };

  it("holds a hidden tab before preparing, so the slide warm-up paints", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const { deps, phases, startRecording, setPreviewState } = depsUpToRecording();
    const deckPlan = {
      ...gatedPlan,
      slides: [{ id: "s1", content: "<svg/>", contentType: "google-svg", name: "One" }],
    } as unknown as StudioPlan;

    const render = runStudioRender(deckPlan, "fixture", deps, narration);
    await vi.waitFor(() => expect(phases).toContain(WAITING_FOR_VISIBLE_TAB_PHASE));
    // Held: nothing is prepared, recorded or timed while the tab is in the
    // background — the warm-up would paint nothing there.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(setPreviewState).not.toHaveBeenCalled();
    expect(startRecording).not.toHaveBeenCalled();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    const result = await render;

    expect(setPreviewState).toHaveBeenCalled();
    expect(phases).toEqual([
      "preflight",
      WAITING_FOR_VISIBLE_TAB_PHASE,
      "prepare-workspace",
      "start-recording",
      "startRecording called",
    ]);
    expect(result.report.errors[0]).toContain("Recording did not start: stopped by the test");
  });

  it("holds again before recording when the tab is hidden during preparation", async () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const { deps, phases, startRecording, startSidebarCollapsed } = depsUpToRecording();
    startSidebarCollapsed.mockImplementation(() => {
      visibility = "hidden";
    });

    const render = runStudioRender(gatedPlan, "fixture", deps, narration);
    await vi.waitFor(() => expect(phases).toContain(WAITING_FOR_VISIBLE_TAB_PHASE));
    expect(startRecording).not.toHaveBeenCalled();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await render;

    expect(phases).toEqual([
      "preflight",
      "prepare-workspace",
      WAITING_FOR_VISIBLE_TAB_PHASE,
      "start-recording",
      "startRecording called",
    ]);
  });

  it("goes straight to recording in a visible tab", async () => {
    const { deps, phases } = depsUpToRecording();
    await runStudioRender(gatedPlan, "fixture", deps, narration);

    expect(phases).toEqual([
      "preflight",
      "prepare-workspace",
      "start-recording",
      "startRecording called",
    ]);
  });

  describe("the render's clock", () => {
    // One second of silence at 24 kHz: the narration a virtual take keeps.
    const wav = encodeWavPcm16(new Int16Array(24_000), 24_000);
    const wavNarration = {
      narration: { blob: new Blob([wav.slice()]), bytes: wav, audioSha256: "0".repeat(64) },
    };

    it("records on a virtual clock only at full speed, without a screen stream or camera", async () => {
      const full = depsUpToRecording();
      const virtual = await runStudioRender(gatedPlan, "fixture", full.deps, {
        ...wavNarration,
        speed: "full",
      });
      expect(full.startRecording).toHaveBeenCalledTimes(1);
      const event = (full.startRecording.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(event.audioBlob).toBe(wavNarration.narration.blob);
      // The narration's length is read from the WAV, not from the plan.
      expect(event.externalAudioDurationMs).toBe(1_000);
      expect((event.timeSource as { kind: string }).kind).toBe("virtual");
      expect(event).not.toHaveProperty("screenStream");
      // The recorder refused the take, so nothing was performed on that clock.
      expect(virtual.report.clock).toBeNull();
      expect(virtual.manifest.environment.clock).toBeNull();

      for (const [options, cameraOn] of [
        [{ ...wavNarration }, false],
        [{ ...wavNarration, speed: "real" as const }, false],
        [{ ...wavNarration, speed: "full" as const, screenStream: { getTracks: () => [] } }, false],
        [{ ...wavNarration, speed: "full" as const }, true],
      ] as const) {
        const real = depsUpToRecording({ cameraOn });
        const result = await runStudioRender(
          gatedPlan,
          "fixture",
          real.deps,
          options as Parameters<typeof runStudioRender>[3],
        );
        const realEvent = (real.startRecording.mock.calls[0] as unknown[])[0] as Record<
          string,
          unknown
        >;
        expect(realEvent).not.toHaveProperty("timeSource");
        expect(realEvent).not.toHaveProperty("externalAudioDurationMs");
        expect(result.report.clock).toBeNull();
        expect(result.manifest.environment.clock).toBeNull();
      }
    });

    it("fails a full-speed render whose narration is not a readable WAV, before recording", async () => {
      const { deps, startRecording } = depsUpToRecording();
      const result = await runStudioRender(gatedPlan, "fixture", deps, {
        ...narration,
        speed: "full",
      });
      expect(startRecording).not.toHaveBeenCalled();
      expect(result.report.errors[0]).toMatch(
        /^The narration could not be read for a full-speed render: /,
      );
      expect(result.report.clock).toBeNull();
      expect(result.manifest.environment.clock).toBeNull();
    });

    /**
     * A recorder that starts a take on the event's time source and finalizes it when
     * stopped. Adding the caption track drops the recording, so the render ends right
     * after finalize, before encoding, without needing an encoder.
     */
    function virtualTake(stop: (elapsedMs: number) => Promise<void> = async () => {}) {
      const base = depsUpToRecording();
      let source: { perfNow(): number } | null = null;
      let session: { startedAtPerf: number } | null = null;
      let externalDurationMs: number | null = null;
      let recording: { id: string; duration: number; audioStartOffsetMs: number } | null = null;
      const stoppedAt: number[] = [];
      const startRecording = vi.fn<(event: Record<string, unknown>) => void>((event) => {
        source = event.timeSource as { perfNow(): number };
        session = { startedAtPerf: source.perfNow() };
        externalDurationMs = event.externalAudioDurationMs as number;
      });
      const stopRecording = vi.fn<() => Promise<void>>(async () => {
        const elapsedMs = source!.perfNow() - session!.startedAtPerf;
        stoppedAt.push(elapsedMs);
        await stop(elapsedMs);
        session = null;
        recording = { id: "take", duration: elapsedMs, audioStartOffsetMs: 0 };
      });
      const deps = {
        ...base.deps,
        actor: {
          getSnapshot: () => ({
            context: {
              error: null,
              defaultEnableCameraRecording: false,
              session,
              audio: { externalDurationMs },
              recording,
            },
            matches: (state: string) => state === "recording" && session !== null,
          }),
        },
        nextEditor: {
          ...(base.deps.nextEditor as object),
          startRecording,
          stopRecording,
          addCaptionTrack: vi.fn<() => void>(() => {
            recording = null;
          }),
          setChapters: vi.fn<() => void>(),
        },
      } as unknown as StudioRunDeps;
      return { deps, startRecording, stopRecording, stoppedAt };
    }

    // The narration in wavNarration plays for one second; the plan pins that length.
    const oneSecondPlan = {
      ...gatedPlan,
      narration: { ...gatedPlan.narration, expectedDurationMs: 1_000 },
    } as unknown as StudioPlan;

    const finalizeWait = () =>
      vi
        .mocked(waitUntil)
        .mock.calls.find(([, options]) => options.description === "the recording to finalize");

    it("runs a virtual take on to the narration's end, stops it there and finalizes", async () => {
      vi.mocked(waitUntil).mockClear();
      const { deps, startRecording, stopRecording, stoppedAt } = virtualTake();
      const result = await runStudioRender(oneSecondPlan, "fixture", deps, {
        ...wavNarration,
        speed: "full",
      });

      expect(startRecording).toHaveBeenCalledTimes(1);
      // Nothing played to end the take: the render slept on its own clock to the
      // narration's end and stopped the take there, once.
      expect(stopRecording).toHaveBeenCalledTimes(1);
      expect(stoppedAt).toEqual([1_000]);
      // The take was stopped already, so finalize waits only its grace, not the
      // rest of a narration read off the virtual clock.
      expect(finalizeWait()?.[1].timeoutMs).toBe(10_000);
      expect(result.report.errors).toEqual(["The finalized recording disappeared before encoding"]);
      expect(result.report.clock).toBe("virtual");
      expect(result.manifest.environment.clock).toBe("virtual");
    });

    it("reports a virtual take whose stop fails as one that never finalized", async () => {
      vi.mocked(waitUntil).mockClear();
      const realNow = performance.now.bind(performance);
      let skipMs = 0;
      const { deps, stopRecording, stoppedAt } = virtualTake(async () => {
        // The finalize grace passes in a few polls rather than ten real seconds.
        vi.spyOn(performance, "now").mockImplementation(() => realNow() + (skipMs += 5_000));
        throw new Error("the recorder is gone");
      });
      const result = await runStudioRender(oneSecondPlan, "fixture", deps, {
        ...wavNarration,
        speed: "full",
      });

      expect(stopRecording).toHaveBeenCalledTimes(1);
      expect(stoppedAt).toEqual([1_000]);
      expect(finalizeWait()?.[1].timeoutMs).toBe(10_000);
      expect(result.report.outcome).toBe("failed");
      expect(result.report.errors).toEqual([
        "Timed out after 10000ms waiting for the recording to finalize",
      ]);
      expect(result.report.clock).toBe("virtual");
    });
  });
});

describe("renderClockFor", () => {
  const base = {
    plan: { actions: [{ id: "a", type: "editor.type" }] } as unknown as StudioPlan,
    runtimeMode: "fixture" as const,
    speed: "full" as const,
    recordsScreen: false,
    cameraOn: false,
  };

  it("is virtual only when every condition holds", () => {
    expect(renderClockFor(base)).toBe("virtual");
    expect(renderClockFor({ ...base, speed: "real" })).toBe("real");
    expect(renderClockFor({ ...base, recordsScreen: true })).toBe("real");
    expect(renderClockFor({ ...base, cameraOn: true })).toBe("real");
    const live = {
      ...base,
      plan: { actions: [{ id: "r", type: "runtime.run" }] } as unknown as StudioPlan,
    };
    expect(renderClockFor(live)).toBe("virtual");
    expect(renderClockFor({ ...live, runtimeMode: "live" })).toBe("real");
    const preview = {
      ...base,
      plan: { actions: [{ id: "p", type: "preview.open" }] } as unknown as StudioPlan,
    };
    expect(renderClockFor(preview)).toBe("real");
  });
});
