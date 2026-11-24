import { describe, expect, it, vi } from "vite-plus/test";
import { createRuntimePanelStore } from "../stores/runtimePanelStore";
import { createSlidesStore } from "../stores/slidesStore";
import { createWhiteboardStore } from "../stores/whiteboardStore";
import type { StudioPlan } from "./plan";
import { runArtifactChecks } from "./qa";
import type { StudioCheckResult } from "./report";
import { runStudioRender, type StudioRunDeps } from "./runStudioRender";
import { encodeWavPcm16 } from "./tts/wav";

vi.mock("../monaco", () => ({
  monaco: {},
  workspacePathFromMonacoModelUri: () => "src/main.rs",
}));

// The render's own steps after the take, stubbed so a take can be carried to
// its outcome here: the audio encoder, the bundle writer, the semantics and
// the gates, whose results each test chooses.
vi.mock("./tts/opus", () => ({
  encodeWavToOggOpus: vi.fn<() => Promise<Uint8Array>>(async () => new Uint8Array([1])),
}));
vi.mock("../storage/recordingExport", () => ({
  buildRecordingFiles: vi.fn<() => Promise<unknown>>(async () => ({
    ne: new Blob([new Uint8Array([2])]),
    audio: { name: "lesson-advisory.ogg" },
  })),
}));
vi.mock("./compare", () => ({
  extractRenderSemantics: vi.fn<() => Promise<unknown>>(async () => ({ finalWorkspaceHash: "h" })),
}));
vi.mock("./qa", () => ({ runArtifactChecks: vi.fn<typeof runArtifactChecks>() }));

const entryFilePath = "src/main.rs";
// The narration lasts one second; the plan pins that length.
const plan = {
  lesson: { slug: "advisory", title: "Advisory", locale: "en" },
  seed: 1,
  workspace: { name: "A", lessonType: "rust", entryFilePath, files: { [entryFilePath]: "" } },
  narration: {
    audioPath: "narration.wav",
    mimeType: "audio/wav",
    expectedDurationMs: 1_000,
    captions: { id: "en", language: "en", cues: [{ start: 0, end: 500, text: "Hi" }] },
  },
  chapters: [],
  runtime: { kind: "none" },
  actions: [],
  slides: [],
  whiteboardAssets: [],
  dependencies: {},
} as unknown as StudioPlan;

const wav = encodeWavPcm16(new Int16Array(24_000), 24_000);
const options = {
  narration: { blob: new Blob([wav.slice()]), bytes: wav, audioSha256: "0".repeat(64) },
  speed: "full" as const,
};

/** A recorder that runs a take on the render's clock and keeps the recording it finalizes. */
function takeDeps(): StudioRunDeps {
  let projectId = "";
  let source: { perfNow(): number } | null = null;
  let session: { startedAtPerf: number } | null = null;
  let externalDurationMs: number | null = null;
  let recording: { id: string; duration: number; audioStartOffsetMs: number } | null = null;
  const model = { uri: {}, getValue: () => "" };
  return {
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
      clearRecording: () => {},
      startRecording: (event: Record<string, unknown>) => {
        source = event.timeSource as { perfNow(): number };
        session = { startedAtPerf: source.perfNow() };
        externalDurationMs = event.externalAudioDurationMs as number;
      },
      stopRecording: async () => {
        recording = {
          id: "take",
          duration: source!.perfNow() - session!.startedAtPerf,
          audioStartOffsetMs: 0,
        };
        session = null;
      },
      addCaptionTrack: () => {},
      setChapters: () => {},
    },
    getEditor: () => ({ getModel: () => model, getSelection: () => null }),
    workspace: {
      loadProject: (project: { id: string }) => {
        projectId = project.id;
      },
      getProject: () => ({ id: projectId, files: {} }),
      startSidebarCollapsed: () => {},
    },
    runtimePanelStore: createRuntimePanelStore(),
    slidesStore: createSlidesStore(),
    whiteboardStore: createWhiteboardStore(),
    preview: { close: () => {}, getState: () => null },
  } as unknown as StudioRunDeps;
}

function gatesReturn(checks: StudioCheckResult[]) {
  vi.mocked(runArtifactChecks).mockImplementation(async ({ recording }) => ({
    checks: checks.map((check) => ({ ...check })),
    artifactRecording: recording,
  }));
}

describe("runStudioRender with advisory checks", () => {
  it("passes a render whose only failed check is advisory, and keeps its files", async () => {
    gatesReturn([
      { id: "recording.decodes", ok: true, detail: "decodes" },
      { id: "capture.end.editor", ok: false, advisory: true, detail: "the editor differs" },
    ]);
    const result = await runStudioRender(plan, "fixture", takeDeps(), options);

    expect(result.report.outcome).toBe("passed");
    expect(result.report.errors).toEqual([]);
    expect(result.artifacts?.audioFileName).toBe("lesson-advisory.ogg");
    expect(result.artifacts?.neBlob).toBeInstanceOf(Blob);
    // The warning stays in the report for the results panel and the driver.
    expect(result.report.checks.map((check) => [check.id, check.ok])).toEqual([
      ["recording.decodes", true],
      ["capture.end.editor", false],
    ]);
  });

  it("still fails a render, and keeps no files, on a failed check that is not advisory", async () => {
    gatesReturn([
      { id: "recording.decodes", ok: false, detail: "does not decode" },
      { id: "capture.end.editor", ok: false, advisory: true, detail: "the editor differs" },
    ]);
    const result = await runStudioRender(plan, "fixture", takeDeps(), options);

    expect(result.report.outcome).toBe("failed");
    expect(result.artifacts).toBeNull();
  });

  it("hands the gates what the render observed: its clock, its sends and the page at the end", async () => {
    gatesReturn([]);
    await runStudioRender(plan, "fixture", takeDeps(), options);

    const capture = vi.mocked(runArtifactChecks).mock.calls.at(-1)?.[0].capture;
    expect(capture?.clock).toBe("virtual");
    expect(capture?.actionEnds).toEqual([]);
    expect(capture?.stageSends).toEqual({ slideEvents: [], whiteboardEvents: [] });
    expect(capture?.endOfTake).toMatchObject({
      editor: { path: entryFilePath, text: "", selection: null },
      consoleLines: [],
      slidePanel: { isOpen: false },
      whiteboard: { isOpen: false, elements: [] },
    });
  });
});
