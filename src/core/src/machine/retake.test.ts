import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, fromCallback } from "xstate";
import type * as monaco from "monaco-editor";
import { editorMachine } from "./editorMachine";
import type {
  AudioPlaybackEmit,
  AudioPlaybackEvent,
  AudioPlaybackInput,
  AudioRecordingEmit,
  AudioRecordingEvent,
  AudioRecordingInput,
} from "./audioActor";
import { fromTypedCallback } from "./fromTypedCallback";
import type { EditorMachineInput } from "./types";
import type { PreviewState } from "../slides";
import { getRecordingTimestamp } from "./recordingSession";
import { selectNextEditorMetadata } from "../useNextEditor";
import { reconstructFrameAtIndex } from "../utils/frameDelta";
import type { WorkspaceRecordingSnapshot } from "../../../types/workspace";
import type { RuntimeRecordingSnapshot } from "../../../types/runtime";

const audioEdit = vi.hoisted(() => ({
  editRecordedAudio: vi.fn<(blob: Blob, edit: unknown) => Promise<Blob>>(),
}));
vi.mock("../utils/audioEdit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/audioEdit")>()),
  editRecordedAudio: audioEdit.editRecordedAudio,
}));
vi.mock("../utils/audioDuration", () => ({
  measureAudioDurationSeconds: vi.fn<(blob: Blob) => Promise<number>>(async () => 1),
}));

const selection = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 1,
  endColumn: 1,
  selectionStartLineNumber: 1,
  selectionStartColumn: 1,
  positionLineNumber: 1,
  positionColumn: 1,
};

class RecordingEditor {
  content = "const a = 1;";
  versionId = 1;
  readonly model = {
    uri: { toString: () => "file:///main.ts" },
    getVersionId: () => this.versionId,
    getValue: () => this.content,
  };
  getModel = () => this.model as unknown as monaco.editor.ITextModel;
  getValue = () => this.content;
  getPosition = () => ({ lineNumber: 1, column: 1 });
  getSelection = () => selection as monaco.Selection;
  getScrollTop = () => 0;
  getScrollLeft = () => 0;
  saveViewState = () => null;
  setContent(text: string) {
    this.content = text;
    this.versionId += 1;
  }
}

function pinClocks() {
  const clock = { perf: 1_000, wall: 50_000 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.perf);
  vi.spyOn(Date, "now").mockImplementation(() => clock.wall);
  return (ms: number) => {
    clock.perf += ms;
    clock.wall += ms;
  };
}

const takeMachine = editorMachine.provide({
  actors: { mouseTracking: fromCallback(() => {}) },
});

function startTake(
  editor: RecordingEditor = new RecordingEditor(),
  input: Partial<EditorMachineInput> = {},
  machine = takeMachine,
) {
  const actor = createActor(machine, {
    input: {
      editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
      ...input,
    },
  }).start();
  actor.send({ type: "START_RECORDING" });
  return actor;
}

const sessionOf = (actor: ReturnType<typeof startTake>) => actor.getSnapshot().context.session!;

afterEach(() => {
  vi.restoreAllMocks();
  audioEdit.editRecordedAudio.mockReset();
});

describe("retaking", () => {
  it("rewinds a running take to its start and holds it paused there", () => {
    const advance = pinClocks();
    const editor = new RecordingEditor();
    const actor = startTake(editor);

    advance(1_000);
    editor.setContent("const a = 1; // oops");
    actor.send({ type: "CAPTURE_FRAME" });
    advance(1_000);
    actor.send({ type: "RETAKE_RECORDING" });

    const session = sessionOf(actor);
    expect(actor.getSnapshot().matches("recording")).toBe(true);
    expect(selectNextEditorMetadata(actor.getSnapshot()).isRecordingPaused).toBe(true);
    expect(getRecordingTimestamp(session)).toBe(0);
    expect(session.frames).toHaveLength(1);
    expect(session.mediaCuts).toEqual([{ start: 0, end: 2_000 }]);
    expect(session.safePoints.map((point) => point.recordingTime)).toEqual([0]);
    actor.stop();
  });

  it("carries on from the safe point, diffing the next frame against it", () => {
    const advance = pinClocks();
    const editor = new RecordingEditor();
    const actor = startTake(editor);

    advance(1_000);
    editor.setContent("const a = 1; // oops");
    actor.send({ type: "CAPTURE_FRAME" });
    actor.send({ type: "RETAKE_RECORDING" });
    // The app puts the editor back the way it was at the safe point.
    editor.setContent("const a = 1;");
    actor.send({ type: "RESUME_RECORDING" });

    advance(500);
    editor.setContent("const a = 2;");
    actor.send({ type: "CAPTURE_FRAME" });

    const { frames } = sessionOf(actor);
    expect(frames.at(-1)?.timestamp).toBe(500);
    expect(reconstructFrameAtIndex(frames, frames.length - 1)?.state.content).toBe("const a = 2;");
    actor.stop();
  });

  it("rewinds to the last resume, and one safe point further on each retake", () => {
    const advance = pinClocks();
    const editor = new RecordingEditor();
    const actor = startTake(editor);

    advance(1_000);
    actor.send({ type: "PAUSE_RECORDING" });
    advance(500);
    actor.send({ type: "RESUME_RECORDING" });
    advance(1_000);
    editor.setContent("changed");
    actor.send({ type: "CAPTURE_FRAME" });

    actor.send({ type: "RETAKE_RECORDING" });
    expect(getRecordingTimestamp(sessionOf(actor))).toBe(1_000);
    expect(sessionOf(actor).mediaCuts).toEqual([{ start: 1_000, end: 2_000 }]);

    actor.send({ type: "RETAKE_RECORDING" });
    expect(getRecordingTimestamp(sessionOf(actor))).toBe(0);
    expect(sessionOf(actor).mediaCuts).toEqual([{ start: 0, end: 2_000 }]);
    expect(sessionOf(actor).safePoints.map((point) => point.recordingTime)).toEqual([0]);
    actor.stop();
  });

  it("has nothing to rewind to at the very start", () => {
    pinClocks();
    const actor = startTake();
    const session = sessionOf(actor);
    const frames = session.frames;
    actor.send({ type: "RETAKE_RECORDING" });
    expect(sessionOf(actor).frames).toBe(frames);
    expect(sessionOf(actor).mediaCuts).toEqual([]);
    actor.stop();
  });

  it("puts the workspace back, undoing the panel moves it discards", () => {
    const advance = pinClocks();
    const project = (content: string): WorkspaceRecordingSnapshot => ({
      activeFilePath: "index.html",
      project: {
        id: "p",
        name: "P",
        lessonType: "html-css",
        entryFilePath: "index.html",
        folders: [],
        files: {
          "index.html": { path: "index.html", name: "index.html", language: "html", content },
        },
      },
    });
    let live = project("<p>kept</p>");
    const applyWorkspaceSnapshot = vi.fn<(snapshot: WorkspaceRecordingSnapshot) => void>();
    const actor = startTake(new RecordingEditor(), {
      getWorkspaceSnapshot: () => live,
      applyWorkspaceSnapshot,
    });

    advance(1_000);
    live = project("<p>discarded</p>");
    actor.send({ type: "WORKSPACE_EVENT", sidebarWidthDelta: 40 });
    advance(1_000);
    actor.send({ type: "RETAKE_RECORDING" });

    expect(applyWorkspaceSnapshot).toHaveBeenCalledTimes(1);
    const restored = applyWorkspaceSnapshot.mock.calls[0][0];
    expect(restored.project.files["index.html"].content).toBe("<p>kept</p>");
    expect(restored.sidebarWidthDelta).toBe(-40);
    expect(sessionOf(actor).workspaceEvents).toHaveLength(1);
    actor.stop();
  });

  it("records the live terminal whole at the safe point", () => {
    const advance = pinClocks();
    let live: RuntimeRecordingSnapshot = {
      mode: "webcontainer",
      status: "running",
      terminalSessions: [{ id: "t", title: "t", output: "$ npm start\n" }],
    } as RuntimeRecordingSnapshot;
    const actor = startTake(new RecordingEditor(), { getRuntimeSnapshot: () => live });

    advance(1_000);
    live = {
      ...live,
      terminalSessions: [{ id: "t", title: "t", output: "$ npm start\nserver up\n" }],
    } as RuntimeRecordingSnapshot;
    actor.send({ type: "RUNTIME_EVENT" });
    advance(1_000);
    actor.send({ type: "RETAKE_RECORDING" });

    const { runtimeEvents } = sessionOf(actor);
    expect(runtimeEvents).toHaveLength(2);
    expect(runtimeEvents[1]).toMatchObject({ timestamp: 0, snapshot: live });
    actor.stop();
  });

  // The rebuilt safe-point frame used to keep the preview open: closing it went out as a
  // delta with no previewState, which reads as unchanged.
  it("leaves a preview closed before the safe point closed", () => {
    const advance = pinClocks();
    let preview: PreviewState | null = { size: "medium", isOpen: true, content: "<p>hi</p>" };
    const applyPreviewState = vi.fn<(previewState: PreviewState) => void>();
    const editor = new RecordingEditor();
    const actor = startTake(editor, { getPreviewState: () => preview, applyPreviewState });

    advance(1_000);
    preview = null;
    actor.send({ type: "CAPTURE_FRAME" });
    actor.send({ type: "PAUSE_RECORDING" });
    actor.send({ type: "RESUME_RECORDING" });
    advance(1_000);
    editor.setContent("const a = 2;");
    actor.send({ type: "CAPTURE_FRAME" });
    actor.send({ type: "RETAKE_RECORDING" });

    expect(getRecordingTimestamp(sessionOf(actor))).toBe(1_000);
    expect(actor.getSnapshot().context.currentFrame?.state.previewState).toBeUndefined();
    expect(applyPreviewState).not.toHaveBeenCalled();
    actor.stop();
  });

  describe("the live preview stream", () => {
    const document = (timestamp: number) => ({
      version: 2,
      time: 0,
      documentId: "doc",
      events: [
        { type: 4, data: {}, timestamp },
        { type: 2, data: {}, timestamp },
      ],
    });
    const batch = (...timestamps: number[]) => ({
      version: 2,
      time: 0,
      source: "runtime-preview" as const,
      documentId: "doc",
      events: timestamps.map((timestamp) => ({ type: 3, data: {}, timestamp })),
    });

    it("drops patches until the preview answers with a fresh snapshot, and older ones after", () => {
      const advance = pinClocks();
      const requestPreviewCheckpoint = vi.fn<() => void>();
      const actor = startTake(new RecordingEditor(), { requestPreviewCheckpoint });
      actor.send({ type: "PREVIEW_INITIAL_DOCUMENT", document: document(50_000) });
      advance(1_000);
      actor.send({ type: "PREVIEW_PATCH_BATCH", batch: batch(51_000) });

      actor.send({ type: "RETAKE_RECORDING" });
      expect(requestPreviewCheckpoint).toHaveBeenCalledTimes(1);
      expect(sessionOf(actor).previewPatchBatches).toEqual([]);

      advance(100); // wall 51_100
      actor.send({ type: "PREVIEW_PATCH_BATCH", batch: batch(51_050) });
      expect(sessionOf(actor).previewPatchBatches).toEqual([]);

      actor.send({ type: "PREVIEW_INITIAL_DOCUMENT", document: document(51_080) });
      actor.send({ type: "PREVIEW_PATCH_BATCH", batch: batch(51_070, 51_090) });

      const { previewInitialDocuments, previewPatchBatches } = sessionOf(actor);
      expect(previewInitialDocuments).toHaveLength(2);
      expect(previewPatchBatches).toHaveLength(1);
      expect(previewPatchBatches[0].events).toHaveLength(1);
      actor.stop();
    });

    // The frames of a take whose preview shows `page`, and what they store of it.
    function startPreviewTake() {
      const editor = new RecordingEditor();
      const preview = { page: "<p>start</p>" };
      const actor = startTake(editor, {
        getPreviewState: () => ({ size: "medium", isOpen: true, content: preview.page }),
        requestPreviewCheckpoint: vi.fn<() => void>(),
      });
      const capture = (page: string) => {
        preview.page = page;
        editor.setContent(`// ${page}`);
        actor.send({ type: "CAPTURE_FRAME" });
      };
      const storedPages = () => {
        const { frames } = sessionOf(actor);
        return frames.map(
          (_, index) => reconstructFrameAtIndex(frames, index)?.state.previewState?.content,
        );
      };
      return { actor, capture, storedPages };
    }

    it("stops storing the HTML fallback in frames once the take has an rrweb seed", () => {
      const advance = pinClocks();
      const { actor, capture, storedPages } = startPreviewTake();

      advance(100);
      capture("<p>one</p>");
      // A document without events is no seed: replay could not rebuild from it.
      actor.send({
        type: "PREVIEW_INITIAL_DOCUMENT",
        document: { ...document(50_100), events: [] },
      });
      advance(100);
      capture("<p>two</p>");
      actor.send({ type: "PREVIEW_INITIAL_DOCUMENT", document: document(50_200) });
      advance(100);
      capture("<p>three</p>");

      expect(storedPages()).toEqual(["<p>start</p>", "<p>one</p>", "<p>two</p>", undefined]);
      actor.stop();
    });

    it("stores the HTML fallback again once a retake discards the seed", () => {
      const advance = pinClocks();
      const { actor, capture, storedPages } = startPreviewTake();

      advance(100);
      actor.send({ type: "PREVIEW_INITIAL_DOCUMENT", document: document(50_100) });
      capture("<p>discarded</p>");
      actor.send({ type: "RETAKE_RECORDING" });
      actor.send({ type: "RESUME_RECORDING" });
      advance(100);
      capture("<p>kept</p>");

      expect(sessionOf(actor).previewInitialDocuments).toEqual([]);
      expect(storedPages()).toEqual(["<p>start</p>", "<p>kept</p>"]);
      actor.stop();
    });
  });
});

describe("retaking with recorders", () => {
  it("pauses the microphone, and cuts the discarded narration when the take loads", async () => {
    const advance = pinClocks();
    const received: AudioRecordingEvent["type"][] = [];
    const edited = new Blob(["edited"], { type: "audio/ogg" });
    audioEdit.editRecordedAudio.mockResolvedValue(edited);
    const machine = takeMachine.provide({
      actors: {
        audioRecording: fromTypedCallback<
          AudioRecordingEvent,
          AudioRecordingInput,
          AudioRecordingEmit
        >(({ receive, sendBack }) => {
          receive((event) => {
            received.push(event.type);
            if (event.type === "START") {
              sendBack({
                type: "AUDIO_RECORDING_STARTED",
                mediaRecorder: {} as MediaRecorder,
                mimeType: "audio/webm",
                startedAtMs: Date.now(),
                startedAtPerf: performance.now(),
              });
            }
            if (event.type === "STOP") {
              sendBack({
                type: "AUDIO_RECORDING_STOPPED",
                blob: new Blob(["raw"], { type: "audio/webm" }),
              });
            }
          });
        }),
      },
    });
    const actor = startTake(new RecordingEditor(), { enableAudioRecording: true }, machine);

    advance(2_000);
    actor.send({ type: "RETAKE_RECORDING" });
    expect(received).toEqual(["START", "PAUSE"]);
    actor.send({ type: "STOP_RECORDING" });

    await vi.waitFor(() => expect(actor.getSnapshot().matches("playback")).toBe(true));
    const recording = actor.getSnapshot().context.recording!;
    expect(audioEdit.editRecordedAudio).toHaveBeenCalledWith(expect.any(Blob), {
      cuts: [{ start: 0, end: 2_000 }],
    });
    expect(recording.audioBlob).toBe(edited);
    expect(recording.pendingAudioEdit).toBeUndefined();
    expect(recording.tracks?.find((track) => track.kind === "audio")?.mimeType).toBe("audio/ogg");
    actor.stop();
  });

  it("rewinds a selected narration file to the safe point instead of cutting it", () => {
    const advance = pinClocks();
    const received: AudioPlaybackEvent[] = [];
    const machine = takeMachine.provide({
      actors: {
        audioPlayback: fromTypedCallback<AudioPlaybackEvent, AudioPlaybackInput, AudioPlaybackEmit>(
          ({ receive }) => {
            receive((event) => received.push(event));
          },
        ),
      },
    });
    const actor = createActor(machine, { input: { editorRef: { current: null } } }).start();
    actor.send({ type: "START_RECORDING", audioBlob: new Blob(["narration"]) });

    advance(1_000);
    actor.send({ type: "PAUSE_RECORDING" });
    actor.send({ type: "RESUME_RECORDING" });
    advance(3_000);
    actor.send({ type: "RETAKE_RECORDING" });

    expect(received.slice(-2)).toEqual([{ type: "PAUSE" }, { type: "SEEK", timeMs: 1_000 }]);
    actor.stop();
  });
});
