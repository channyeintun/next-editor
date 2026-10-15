import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { workspacePathFromMonacoModelUri } from "../monaco";
import { sha256HexOfJson } from "./hash";
import type { StudioPlan } from "./plan";
import {
  narrationTimelineOnRecordingClock,
  runStudioRender,
  WAITING_FOR_VISIBLE_TAB_PHASE,
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
    dependencies: {},
  } as unknown as StudioPlan;

  /**
   * Deps that carry a render through workspace pinning to startRecording, where
   * the recorder reports an error so the render ends without performing.
   */
  function depsUpToRecording() {
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
        getSnapshot: () => ({ context: { error: "stopped by the test" }, matches: () => false }),
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
});
