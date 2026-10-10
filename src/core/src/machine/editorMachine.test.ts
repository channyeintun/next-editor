import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { assign, createActor, fromPromise, waitFor } from "xstate";
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
import type {
  CameraRecordingEmit,
  CameraRecordingEvent,
  CameraRecordingInput,
} from "./cameraActor";
import { getPlaybackAudioState } from "./playbackActors";
import { fromTypedCallback } from "./fromTypedCallback";
import type { CaptionTrack, EditorFrame, Recording, RecordingStreamDelta } from "../types";
import type { ChatCheckpoint } from "../chat";
import type { PreviewEvent } from "../preview";
import type { WhiteboardSceneState } from "../whiteboard";
import {
  ContentEditBaseMismatchError,
  createContentDelta,
  createContentEditDelta,
} from "../utils/contentDelta";
import { reconstructFrameAtIndex } from "../utils/frameDelta";
import { compressFrames } from "../utils/frameStreamEncoder";
import {
  DmpBaseMismatchError,
  getDmpCodec,
  installDmpCodec,
  type DmpCodec,
} from "../../dmp/dmpCodec";
import type { WorkspaceRecordingSnapshot } from "../workspace";
import {
  createRecording,
  createWorkspaceSnapshot,
  pinPerformanceClock,
  selection,
} from "./testing/takeFixtures";

function createTwoFileWorkspaceSnapshot(
  activeFilePath: "a.ts" | "b.ts",
  aContent: string,
  bContent: string,
): WorkspaceRecordingSnapshot {
  return {
    activeFilePath,
    collapsedFolders: [],
    project: {
      id: "project-1",
      name: "Project",
      lessonType: "html-css",
      entryFilePath: "a.ts",
      folders: [],
      files: {
        "a.ts": {
          path: "a.ts",
          name: "a.ts",
          language: "typescript",
          content: aContent,
        },
        "b.ts": {
          path: "b.ts",
          name: "b.ts",
          language: "typescript",
          content: bContent,
        },
      },
    },
  };
}

class MockTextModel {
  private content: string;

  constructor(content: string) {
    this.content = content;
  }

  getValue() {
    return this.content;
  }

  getLineCount() {
    return this.content.split("\n").length;
  }

  getValueLength() {
    return this.content.length;
  }

  getLineLength(lineNumber: number) {
    return this.content.split("\n")[lineNumber - 1]?.length ?? 0;
  }

  setValue(content: string) {
    this.content = content;
  }

  getPositionAt(offset: number) {
    return { lineNumber: 1, column: offset + 1 };
  }

  canUndo() {
    return false;
  }

  applyEdits(edits: readonly monaco.editor.IIdentifiedSingleEditOperation[]) {
    const edit = edits[0];

    if (!edit) {
      return;
    }

    const startOffset = edit.range.startColumn - 1;
    const endOffset = edit.range.endColumn - 1;
    this.content =
      this.content.slice(0, startOffset) + (edit.text ?? "") + this.content.slice(endOffset);
  }
}

class MockEditor {
  private position: monaco.IPosition = { lineNumber: 1, column: 1 };
  private editorSelection: monaco.Selection = selection as monaco.Selection;
  private model: MockTextModel;

  constructor(model: MockTextModel) {
    this.model = model;
  }

  getModel() {
    return this.model as unknown as monaco.editor.ITextModel;
  }

  setModel(model: monaco.editor.ITextModel | null) {
    if (model) {
      this.model = model as unknown as MockTextModel;
    }
  }

  getValue() {
    return this.model.getValue();
  }

  saveViewState() {
    return null;
  }

  restoredViewStates: unknown[] = [];

  restoreViewState(viewState: unknown) {
    this.restoredViewStates.push(viewState);
    return undefined;
  }

  getPosition() {
    return this.position;
  }

  setPosition(position: monaco.IPosition) {
    this.position = position;
  }

  getSelection() {
    return this.editorSelection;
  }

  setSelection(nextSelection: monaco.Selection) {
    this.editorSelection = nextSelection;
  }

  hasTextFocus() {
    return true;
  }
}

describe("editorMachine actor lifecycle", () => {
  it("plays and controls recordings without an audio actor", async () => {
    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording: createRecording() });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(actor.getSnapshot().children.audioPlayer).toBeUndefined();

    actor.send({ type: "PLAY" });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "playing" }));

    actor.send({ type: "SET_SPEED", speed: 2 });
    actor.send({ type: "SEEK", time: 500 });
    actor.send({ type: "PAUSE" });

    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "paused" }));
    expect(actor.getSnapshot().status).toBe("active");
    expect(actor.getSnapshot().children.audioPlayer).toBeUndefined();

    actor.stop();
  });

  // `stoppingRecording` finalizes 2s after STOP whether or not the recorder has
  // reported. A slower MediaRecorder.stop() then delivers the whole narration to a
  // machine that has already reached playback, where it used to be dropped — the
  // lesson came out silently silent.
  it("attaches a microphone blob that arrives after the finalize watchdog", async () => {
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null } },
    }).start();

    const recording = createRecording();
    delete recording.audioBlob;
    delete recording.audioSource;
    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    expect(actor.getSnapshot().context.recording!.audioBlob).toBeUndefined();

    const blob = new Blob(["late narration"], { type: "audio/webm" });
    actor.send({ type: "AUDIO_RECORDING_STOPPED", blob });

    const loaded = actor.getSnapshot().context.recording!;
    expect(loaded.audioBlob).toBe(blob);
    expect(loaded.audioSource).toBe("microphone");
    expect(getPlaybackAudioState(loaded)).not.toBeNull();

    actor.stop();
  });

  it("replaces the loaded recording when LOAD_RECORDING arrives during playback", async () => {
    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
      },
    }).start();

    const firstRecording = createRecording();
    actor.send({ type: "LOAD_RECORDING", recording: firstRecording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(actor.getSnapshot().context.recording!.id).toBe("recording-1");

    const secondRecording = createRecording();
    secondRecording.id = "recording-2";
    secondRecording.duration = 2000;

    actor.send({ type: "LOAD_RECORDING", recording: secondRecording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(actor.getSnapshot().context.recording!.id).toBe("recording-2");
    expect(actor.getSnapshot().context.recording!.duration).toBe(2000);

    actor.stop();
  });

  it("appends streamed recording deltas once without rebuilding prior arrays", async () => {
    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording: createRecording() });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    const initialRecording = actor.getSnapshot().context.recording!;
    const initialFrames = initialRecording.frames;
    const firstFrame = initialFrames[0];
    if (!firstFrame?.isKeyframe) throw new Error("Expected an initial keyframe");
    const nextFrame = {
      ...firstFrame,
      timestamp: 500,
      state: { ...firstFrame.state, content: "hello world" },
    };
    const delta: RecordingStreamDelta = {
      cursor: 1,
      recordingId: "recording-1",
      duration: 2000,
      streamFinalized: false,
      newFrames: [nextFrame],
      newSlideEvents: [],
      newPreviewEvents: [],
      newPreviewInitialDocuments: [],
      newPreviewPatchBatches: [],
      newWorkspaceEvents: [],
      newRuntimeEvents: [],
      newCursorEvents: [{ timestamp: 500, x: 10, y: 20, visible: true }],
      newWhiteboardEvents: [],
      newChatEvents: [],
    };

    actor.send({ type: "APPEND_RECORDING_DELTA", delta });

    const appended = actor.getSnapshot().context;
    expect(appended.recording).not.toBe(initialRecording);
    expect(appended.recording!.frames).toBe(initialFrames);
    expect(appended.recording!.frames).toHaveLength(2);
    expect(appended.recording!.cursorEvents).toEqual(delta.newCursorEvents);
    expect(appended.recording!.duration).toBe(2000);
    expect(appended.recordingStreamCursor).toBe(1);

    actor.send({ type: "APPEND_RECORDING_DELTA", delta });
    expect(actor.getSnapshot().context.recording!.frames).toHaveLength(2);

    actor.stop();
  });

  it("extends the loaded recording with a longer prefix of its own stream", async () => {
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null } },
    }).start();

    const recording = createRecording();
    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    actor.send({
      type: "EXTEND_RECORDING",
      recording: { ...recording, duration: 3000, cameraUrl: "https://example.com/camera.webm" },
    });

    const { context } = actor.getSnapshot();
    expect(context.recording!.cameraUrl).toBe("https://example.com/camera.webm");
    expect(context.timeline.duration).toBe(3000);

    actor.stop();
  });

  // useUrlLoader guards staleness only against its own loads. A lesson opened through the
  // header import leaves the previous lesson's audio download and stream running, and their
  // late extends used to swap that lesson back in.
  it("ignores stream growth and late media from a lesson that is no longer open", async () => {
    const audioPlayerEvents: AudioPlaybackEvent["type"][] = [];
    const machine = editorMachine.provide({
      actors: {
        audioPlayback: fromTypedCallback<AudioPlaybackEvent, AudioPlaybackInput, AudioPlaybackEmit>(
          ({ receive }) => {
            receive((event) => {
              audioPlayerEvents.push(event.type);
            });
          },
        ),
      },
    });
    const actor = createActor(machine, {
      input: { editorRef: { current: null } },
    }).start();

    const lessonA: Recording = { ...createRecording(), id: "lesson-A", duration: 90_000 };
    actor.send({ type: "LOAD_RECORDING", recording: lessonA });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    const lessonB: Recording = {
      ...createRecording(),
      id: "lesson-B",
      duration: 2_000,
      audioBlob: new Blob(["lesson B narration"], { type: "audio/webm" }),
      audioSource: "external",
    };
    actor.send({ type: "LOAD_RECORDING", recording: lessonB });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    const lessonBFrames = actor.getSnapshot().context.recording!.frames;
    expect(actor.getSnapshot().children.audioPlayer).toBeDefined();
    audioPlayerEvents.length = 0;

    actor.send({
      type: "EXTEND_RECORDING",
      recording: {
        ...lessonA,
        audioBlob: new Blob(["lesson A narration"], { type: "audio/webm" }),
        audioSource: "external",
      },
    });
    actor.send({
      type: "APPEND_RECORDING_DELTA",
      delta: {
        cursor: 1,
        recordingId: "lesson-A",
        duration: 90_000,
        streamFinalized: false,
        newFrames: [{ ...lessonA.frames[0]!, timestamp: 500 }],
        newSlideEvents: [],
        newPreviewEvents: [],
        newPreviewInitialDocuments: [],
        newPreviewPatchBatches: [],
        newWorkspaceEvents: [],
        newRuntimeEvents: [],
        newCursorEvents: [],
        newWhiteboardEvents: [],
        newChatEvents: [],
      },
    });

    const { context } = actor.getSnapshot();
    expect(context.recording!.id).toBe("lesson-B");
    expect(context.recording!.frames).toBe(lessonBFrames);
    expect(context.recording!.frames).toHaveLength(1);
    expect(context.timeline.duration).toBe(2_000);
    // Lesson A's growth must not seek, retune or restart lesson B's narration either.
    expect(audioPlayerEvents).toEqual([]);

    actor.stop();
  });

  // Published lessons keep their captions as sibling .vtt files that useUrlLoader adds
  // through ADD_CAPTION_TRACK. That small fetch usually beats the sibling audio download,
  // whose EXTEND_RECORDING carries only the stream's own captions and used to drop the rest.
  describe("caption tracks across EXTEND_RECORDING", () => {
    const captionTrack = (id: string): CaptionTrack => ({
      id,
      language: "en",
      cues: [{ start: 0, end: 1000, text: id }],
    });

    const captionIds = (actor: ReturnType<typeof createActor<typeof editorMachine>>) =>
      actor.getSnapshot().context.recording!.captions?.map((track) => track.id);

    const loadAndExtend = async (embedded: CaptionTrack[] | undefined, added: CaptionTrack[]) => {
      const actor = createActor(editorMachine, {
        input: { editorRef: { current: null } },
      }).start();
      const recording: Recording = { ...createRecording(), captions: embedded };
      actor.send({ type: "LOAD_RECORDING", recording });
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
      for (const track of added) {
        actor.send({ type: "ADD_CAPTION_TRACK", recordingId: recording.id, track });
      }

      actor.send({
        type: "EXTEND_RECORDING",
        recording: { ...recording, cameraUrl: "https://example.com/camera.webm" },
      });
      expect(actor.getSnapshot().context.recording!.cameraUrl).toBe(
        "https://example.com/camera.webm",
      );
      return actor;
    };

    it("keeps a sibling track added after load", async () => {
      const actor = await loadAndExtend(undefined, [captionTrack("en-sibling")]);
      expect(captionIds(actor)).toEqual(["en-sibling"]);
      actor.stop();
    });

    it("keeps the stream's own captions when nothing was added", async () => {
      const actor = await loadAndExtend([captionTrack("emb")], []);
      expect(captionIds(actor)).toEqual(["emb"]);
      actor.stop();
    });

    it("keeps both the stream's captions and an added sibling track", async () => {
      const actor = await loadAndExtend([captionTrack("emb")], [captionTrack("en-sibling")]);
      expect(captionIds(actor)).toEqual(["emb", "en-sibling"]);
      actor.stop();
    });
  });

  // useUrlLoader drops a late sibling .vtt only when one of its own loads supersedes it. A
  // lesson opened through the header import (or a new take) leaves the previous lesson's
  // caption fetch running, and its tracks used to land on whichever recording was loaded.
  describe("caption tracks sent after another lesson opened", () => {
    const lessonATrack: CaptionTrack = {
      id: "sibling:/lesson-a.en.vtt",
      language: "en",
      cues: [{ start: 0, end: 1000, text: "lesson A" }],
    };

    const openLessonBAfterLessonA = async () => {
      const actor = createActor(editorMachine, {
        input: { editorRef: { current: null } },
      }).start();
      actor.send({ type: "LOAD_RECORDING", recording: { ...createRecording(), id: "lesson-A" } });
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
      actor.send({ type: "LOAD_RECORDING", recording: { ...createRecording(), id: "lesson-B" } });
      await waitFor(
        actor,
        (snapshot) =>
          snapshot.matches({ playback: "ready" }) && snapshot.context.recording?.id === "lesson-B",
      );
      return actor;
    };

    it("drops a caption track sent for a recording that is no longer loaded", async () => {
      const actor = await openLessonBAfterLessonA();

      actor.send({ type: "ADD_CAPTION_TRACK", recordingId: "lesson-A", track: lessonATrack });

      expect(actor.getSnapshot().context.recording!.captions).toBeUndefined();
      actor.stop();
    });

    it("adds a caption track sent for the loaded recording", async () => {
      const actor = await openLessonBAfterLessonA();
      const lessonBTrack: CaptionTrack = { ...lessonATrack, id: "sibling:/lesson-b.en.vtt" };

      actor.send({ type: "ADD_CAPTION_TRACK", recordingId: "lesson-B", track: lessonBTrack });

      expect(actor.getSnapshot().context.recording!.captions).toEqual([lessonBTrack]);
      actor.stop();
    });
  });

  // useUrlLoader keeps appending decoded chunks, and extends the recording once the sibling
  // audio lands, often after the viewer has paused and started editing. Detaching resets the
  // replay cursors, so that growth used to rebuild every track on top of the viewer's work.
  describe("stream growth after the viewer takes over the workspace", () => {
    const withFrame = (recording: Recording, timestamp: number, content: string) => {
      const first = recording.frames[0];
      if (!first?.isKeyframe) throw new Error("Expected an initial keyframe");
      return { ...first, timestamp, state: { ...first.state, content } };
    };

    const growthDelta = (
      cursor: number,
      duration: number,
      newFrames: Recording["frames"] = [],
    ): RecordingStreamDelta => ({
      cursor,
      recordingId: "recording-1",
      duration,
      streamFinalized: false,
      newFrames,
      newSlideEvents: [],
      newPreviewEvents: [],
      newPreviewInitialDocuments: [],
      newPreviewPatchBatches: [],
      newWorkspaceEvents: [],
      newRuntimeEvents: [],
      newCursorEvents: [],
      newWhiteboardEvents: [],
      newChatEvents: [],
    });

    const recordedLesson = (): Recording => {
      const recording = createRecording();
      return {
        ...recording,
        frames: [recording.frames[0]!, withFrame(recording, 100, "recorded")],
        whiteboardEvents: [
          {
            timestamp: 0,
            upserts: [{ id: "a", version: 1, versionNonce: 1, isDeleted: false }],
            isOpen: true,
          },
        ],
      };
    };

    const start = async (recording: Recording) => {
      const model = new MockTextModel("hello");
      const editor = new MockEditor(model);
      const applyWhiteboardState = vi.fn<(state: WhiteboardSceneState) => void>();
      const actor = createActor(editorMachine, {
        input: {
          editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
          applyWhiteboardState,
        },
      }).start();
      actor.send({ type: "LOAD_RECORDING", recording });
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
      return { actor, model, applyWhiteboardState };
    };

    const growStream = (actor: Awaited<ReturnType<typeof start>>["actor"]) => {
      actor.send({ type: "APPEND_RECORDING_DELTA", delta: growthDelta(1, 2000) });
      actor.send({
        type: "EXTEND_RECORDING",
        recording: { ...actor.getSnapshot().context.recording!, duration: 2500 },
      });
    };

    it("leaves a paused viewer's edits alone and catches up on PLAY", async () => {
      const { actor, model, applyWhiteboardState } = await start(recordedLesson());
      actor.send({ type: "SEEK", time: 150 });
      actor.send({ type: "PLAY" });
      actor.send({ type: "PAUSE" });
      expect(model.getValue()).toBe("recorded");

      model.setValue("my own edit");
      actor.send({ type: "WORKSPACE_EVENT" });
      applyWhiteboardState.mockClear();

      growStream(actor);

      expect(model.getValue()).toBe("my own edit");
      expect(applyWhiteboardState).not.toHaveBeenCalled();
      // The growth itself is kept: the timeline knows the longer lesson.
      expect(actor.getSnapshot().context.timeline.duration).toBe(2500);

      actor.send({ type: "PLAY" });
      expect(actor.getSnapshot().context.pendingPlaybackEditorSync).toBe(true);
      expect(applyWhiteboardState).toHaveBeenCalled();

      actor.stop();
    });

    it("leaves a workspace the viewer changed before playing alone", async () => {
      const { actor, model, applyWhiteboardState } = await start(recordedLesson());
      model.setValue("my own edit");
      actor.send({ type: "WORKSPACE_EVENT" });
      applyWhiteboardState.mockClear();

      growStream(actor);

      expect(actor.getSnapshot().matches({ playback: "ready" })).toBe(true);
      expect(model.getValue()).toBe("my own edit");
      expect(applyWhiteboardState).not.toHaveBeenCalled();

      actor.stop();
    });

    it("still applies newly streamed frames while the replay owns the workspace", async () => {
      const recording = createRecording();
      const { actor, model } = await start(recording);
      actor.send({ type: "SEEK", time: 150 });
      expect(model.getValue()).toBe("hello");

      actor.send({
        type: "APPEND_RECORDING_DELTA",
        delta: growthDelta(1, 2000, [withFrame(recording, 100, "streamed")]),
      });

      expect(model.getValue()).toBe("streamed");

      actor.stop();
    });
  });

  // Loading a finalized microphone take decodes its whole narration first, which can take
  // seconds. A discard or another import sent in that window used to be dropped: the
  // discarded take opened anyway, and the newer import was lost.
  describe("events sent while a recording loads", () => {
    const startWithDeferredLoads = () => {
      const pendingLoads = new Map<string, () => void>();
      const machine = editorMachine.provide({
        actors: {
          loadRecording: fromPromise<
            { recording: Recording; duration: number },
            { recording: Recording | null }
          >(
            ({ input }) =>
              new Promise((resolve) => {
                const recording = input.recording!;
                pendingLoads.set(recording.id, () =>
                  resolve({ recording, duration: recording.duration }),
                );
              }),
          ),
        },
      });
      const actor = createActor(machine, {
        input: { editorRef: { current: null } },
      }).start();
      const finishLoad = async (id: string) => {
        pendingLoads.get(id)!();
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
      return { actor, finishLoad };
    };

    const lesson = (id: string): Recording => ({ ...createRecording(), id });

    it.each([
      ["in order", ["lesson-A", "lesson-B"]],
      ["out of order", ["lesson-B", "lesson-A"]],
    ])("opens the newer import when both loads finish %s", async (_order, finishOrder) => {
      const { actor, finishLoad } = startWithDeferredLoads();
      actor.send({ type: "LOAD_RECORDING", recording: lesson("lesson-A") });
      actor.send({ type: "LOAD_RECORDING", recording: lesson("lesson-B") });

      for (const id of finishOrder) await finishLoad(id);

      expect(actor.getSnapshot().matches({ playback: "ready" })).toBe(true);
      expect(actor.getSnapshot().context.recording!.id).toBe("lesson-B");

      actor.stop();
    });

    it("discards a recording unloaded before it finished loading", async () => {
      const { actor, finishLoad } = startWithDeferredLoads();
      actor.send({ type: "LOAD_RECORDING", recording: lesson("lesson-A") });
      actor.send({ type: "UNLOAD" });

      expect(actor.getSnapshot().value).toBe("idle");
      expect(actor.getSnapshot().context.recording).toBeNull();

      await finishLoad("lesson-A");

      expect(actor.getSnapshot().value).toBe("idle");
      expect(actor.getSnapshot().context.recording).toBeNull();

      actor.stop();
    });
  });

  // Building a content delta calls getDmpCodec(), which throws when the WASM has
  // not loaded — inside an xstate `assign` on the capture hot path. xstate treats
  // that as fatal: the actor stops mid-recording, later sends are no-ops, and the
  // whole session is lost with only a console message. Refusing to start is the
  // honest outcome, since the take would not be encodable at save time either.
  it("refuses to start recording when the dmp codec is unavailable", async () => {
    const dmpCodec = await import("../../dmp/dmpCodec");
    const loadedSpy = vi.spyOn(dmpCodec, "isDmpCodecLoaded").mockReturnValue(false);
    const errors: Error[] = [];

    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        onError: (error: Error) => errors.push(error),
      },
    }).start();

    actor.send({ type: "START_RECORDING" });

    expect(actor.getSnapshot().value).toBe("idle");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/recording codec could not be loaded/i);
    expect(actor.getSnapshot().context.error).toMatch(/recording codec could not be loaded/i);

    // Once the codec is back, a retry must not still carry the refusal: the studio
    // reads `context.error` right after starting and would abort a live take.
    loadedSpy.mockRestore();
    actor.send({ type: "START_RECORDING" });

    expect(actor.getSnapshot().matches("recording")).toBe(true);
    expect(actor.getSnapshot().context.error).toBeNull();
    expect(errors).toHaveLength(1);
    actor.stop();
  });

  // The app's provider passes no onError, so a refused start used to leave no trace at all.
  it("logs a machine error to the console when the host supplies no onError", async () => {
    const dmpCodec = await import("../../dmp/dmpCodec");
    const loadedSpy = vi.spyOn(dmpCodec, "isDmpCodecLoaded").mockReturnValue(false);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null } },
    }).start();

    try {
      actor.send({ type: "START_RECORDING" });

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[editorMachine]",
        expect.objectContaining({ message: expect.stringMatching(/recording codec/i) }),
      );
    } finally {
      loadedSpy.mockRestore();
      consoleError.mockRestore();
      actor.stop();
    }
  });

  // xstate treats a throwing invoke `input` as fatal: the actor stops in place, onError
  // never runs, and every later send is a no-op. The load must fail through onError instead.
  it("reports a finalized take with nothing to load and keeps the actor alive", async () => {
    const onError = vi.fn<(error: Error) => void>();
    const machine = editorMachine.provide({
      actions: { finalizeRecording: assign({ recording: null }) },
    });
    const actor = createActor(machine, {
      input: { editorRef: { current: null }, onError },
    }).start();

    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));
    actor.send({ type: "STOP_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.value === "idle");

    expect(actor.getSnapshot().status).toBe("active");
    expect(actor.getSnapshot().context.error).toBe("No recording found to load");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No recording found to load" }),
    );

    actor.send({ type: "START_RECORDING" });
    expect(actor.getSnapshot().matches("recording")).toBe(true);
    actor.stop();
  });

  it("stops mouse tracking on the no-audio recording path and emits callbacks", async () => {
    const events: string[] = [];
    // Held in an object so the assignment inside the callback doesn't make
    // control-flow analysis narrow the variable to `never` at the read site.
    const stoppedRecording: { value: Recording | null } = { value: null };
    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        onRecordingStart: () => events.push("recording:start"),
        onRecordingStop: (recording) => {
          events.push("recording:stop");
          stoppedRecording.value = recording;
        },
      },
    }).start();

    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));

    expect(actor.getSnapshot().children.mouseTracker).toBeDefined();

    actor.send({ type: "STOP_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(actor.getSnapshot().children.mouseTracker).toBeUndefined();
    expect(events).toEqual(["recording:start", "recording:stop"]);
    expect(stoppedRecording.value?.frames.length).toBeGreaterThan(0);

    actor.stop();
  });

  it("stops and clears an active camera when selected-file audio aborts", async () => {
    let failAudio = () => {};
    const disposeCamera = vi.fn<() => void>();
    const machine = editorMachine.provide({
      actors: {
        audioPlayback: fromTypedCallback<AudioPlaybackEvent, AudioPlaybackInput, AudioPlaybackEmit>(
          ({ sendBack }) => {
            failAudio = () =>
              sendBack({ type: "AUDIO_PLAYBACK_ERROR", error: "selected audio failed" });
          },
        ),
        cameraRecording: fromTypedCallback<
          CameraRecordingEvent,
          CameraRecordingInput,
          CameraRecordingEmit
        >(({ receive, sendBack }) => {
          receive((event) => {
            if (event.type === "START") {
              sendBack({
                type: "CAMERA_STARTED",
                mimeType: "video/webm",
                startedAtPerf: performance.now(),
                mediaRecorder: {} as MediaRecorder,
              });
            }
          });
          return disposeCamera;
        }),
      },
    });
    const actor = createActor(machine, {
      input: { editorRef: { current: null } },
    }).start();

    actor.send({
      type: "START_RECORDING",
      audioBlob: new Blob(["audio"], { type: "audio/webm" }),
      enableCamera: true,
    });
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));
    expect(actor.getSnapshot().children.cameraRecorder).toBeDefined();

    failAudio();

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("idle");
    expect(snapshot.children.cameraRecorder).toBeUndefined();
    expect(snapshot.context.camera).toEqual({
      blob: null,
      isRecording: false,
      mimeType: "",
      mediaRecorder: null,
      source: null,
      startOffsetMs: 0,
    });
    expect(snapshot.context.audio.blob).toBeNull();
    expect(snapshot.context.audio.source).toBeNull();
    expect(snapshot.context.session).toBeNull();
    expect(snapshot.context.error).toBe("selected audio failed");
    expect(disposeCamera).toHaveBeenCalledTimes(1);

    // The next take starts clean rather than reporting the aborted one's failure.
    actor.send({
      type: "START_RECORDING",
      audioBlob: new Blob(["audio"], { type: "audio/webm" }),
    });
    expect(actor.getSnapshot().matches("recording")).toBe(true);
    expect(actor.getSnapshot().context.error).toBeNull();
    actor.stop();
  });

  it("records file sidebar resizes as per-event width deltas", async () => {
    let currentWorkspace = createWorkspaceSnapshot("same", 0);
    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        getWorkspaceSnapshot: () => currentWorkspace,
      },
    }).start();

    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));

    const initialWorkspaceEvent = actor.getSnapshot().context.session?.workspaceEvents[0];

    expect(initialWorkspaceEvent?.snapshot.sidebarWidthDelta).toBe(0);

    currentWorkspace = createWorkspaceSnapshot("same", 0);
    actor.send({ type: "WORKSPACE_EVENT", sidebarWidthDelta: 40 });

    currentWorkspace = createWorkspaceSnapshot("same", 0);
    actor.send({ type: "WORKSPACE_EVENT", sidebarWidthDelta: -15 });

    // Equal consecutive deltas are separate moves (keyboard steps, a steady drag):
    // replay sums them, so dropping one as a duplicate under-applies the resize.
    for (let step = 0; step < 3; step += 1) {
      currentWorkspace = createWorkspaceSnapshot("same", 0);
      actor.send({ type: "WORKSPACE_EVENT", sidebarWidthDelta: 16 });
    }

    const workspaceEvents = actor.getSnapshot().context.session?.workspaceEvents ?? [];

    expect(workspaceEvents.map((event) => event.snapshot.sidebarWidthDelta)).toEqual([
      0, 40, -15, 16, 16, 16,
    ]);

    actor.stop();
  });

  it("records repeated equal preview dock resizes but still dedupes delta-free repeats", async () => {
    const currentWorkspace = createWorkspaceSnapshot("same", 0);
    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        getWorkspaceSnapshot: () => currentWorkspace,
      },
    }).start();

    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));

    const workspaceEvents = () => actor.getSnapshot().context.session?.workspaceEvents ?? [];
    expect(workspaceEvents()).toHaveLength(1);

    // An unchanged workspace with a zero delta is a true duplicate.
    actor.send({ type: "WORKSPACE_EVENT" });
    actor.send({ type: "WORKSPACE_EVENT", sidebarWidthDelta: 0 });
    expect(workspaceEvents()).toHaveLength(1);

    actor.send({ type: "WORKSPACE_EVENT", previewDockWidthDelta: 50 });
    actor.send({ type: "WORKSPACE_EVENT", previewDockWidthDelta: 50 });

    expect(workspaceEvents().map((event) => event.snapshot.previewDockWidthDelta)).toEqual([
      undefined,
      50,
      50,
    ]);

    actor.stop();
  });

  it("captures whiteboard events during recording and finalizes them onto the recording", async () => {
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null } },
    }).start();

    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));

    actor.send({
      type: "WHITEBOARD_EVENT",
      event: {
        timestamp: 0,
        upserts: [{ id: "a", version: 1, versionNonce: 1, isDeleted: false }],
        isOpen: true,
      },
    });
    actor.send({
      type: "WHITEBOARD_EVENT",
      event: {
        timestamp: 0,
        upserts: [{ id: "a", version: 2, versionNonce: 2, isDeleted: false }],
      },
    });

    const sessionEvents = actor.getSnapshot().context.session?.whiteboardEvents ?? [];
    expect(sessionEvents.map((event) => event.upserts?.[0]?.version)).toEqual([1, 2]);

    actor.send({ type: "STOP_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    const recording = actor.getSnapshot().context.recording;
    expect(recording?.whiteboardEvents?.length).toBe(2);
    expect(recording?.tracks?.some((track) => track.kind === "whiteboard")).toBe(true);

    actor.stop();
  });

  it("applies reduced whiteboard scene state during replay sync and seeks", async () => {
    const applied: Array<{ elementIds: string[]; isOpen: boolean }> = [];

    const recording: Recording = {
      ...createRecording(),
      whiteboardEvents: [
        {
          timestamp: 0,
          upserts: [{ id: "a", version: 1, versionNonce: 1, isDeleted: false }],
          isOpen: true,
        },
        {
          timestamp: 100,
          upserts: [{ id: "b", version: 1, versionNonce: 2, isDeleted: false }],
          removedIds: ["a"],
        },
      ],
    };

    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        applyWhiteboardState: (state) => {
          applied.push({
            elementIds: state.elements.map((element) => element.id),
            isOpen: state.isOpen,
          });
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(applied).toEqual([{ elementIds: ["a"], isOpen: true }]);

    applied.length = 0;
    actor.send({ type: "SEEK", time: 100 });
    expect(applied).toEqual([{ elementIds: ["b"], isOpen: true }]);

    // Seeking backward to the start and forward again must reconstruct the same
    // state, not carry over any stale cached reduction.
    applied.length = 0;
    actor.send({ type: "SEEK", time: 0 });
    actor.send({ type: "SEEK", time: 100 });
    expect(applied).toEqual([
      { elementIds: ["a"], isOpen: true },
      { elementIds: ["b"], isOpen: true },
    ]);

    actor.stop();
  });

  it("clears the whiteboard when seeking to before its first event", async () => {
    const applied: Array<{ elementIds: string[]; isOpen: boolean }> = [];

    // First whiteboard event lands mid-recording — the board didn't exist
    // before it, so seeking back past it must clear the scene rather than
    // leave the previously applied drawing on screen.
    const recording: Recording = {
      ...createRecording(),
      whiteboardEvents: [
        {
          timestamp: 500,
          upserts: [{ id: "a", version: 1, versionNonce: 1, isDeleted: false }],
          isOpen: true,
        },
      ],
    };

    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        applyWhiteboardState: (state) => {
          applied.push({
            elementIds: state.elements.map((element) => element.id),
            isOpen: state.isOpen,
          });
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    applied.length = 0;
    actor.send({ type: "SEEK", time: 600 });
    expect(applied).toEqual([{ elementIds: ["a"], isOpen: true }]);

    applied.length = 0;
    actor.send({ type: "SEEK", time: 100 });
    expect(applied).toEqual([{ elementIds: [], isOpen: false }]);

    actor.stop();
  });

  // Same rule as the whiteboard above. The deck is recorded as open at t=0 only when it
  // was open when recording started, and the chat track starts at the panel's first use.
  it("closes the deck and empties the transcript before their first events", async () => {
    const deckOpen: boolean[] = [];
    const transcriptLengths: number[] = [];

    const recording: Recording = {
      ...createRecording(),
      slides: [{ id: "s1", order: 0, content: "one", contentType: "html" }],
      slideEvents: [{ type: "slide_open", timestamp: 500, slideId: "s1", indexv: 0 }],
      chatEvents: [
        {
          timestamp: 500,
          event: {
            k: "checkpoint",
            state: {
              items: [{ kind: "message", id: "msg-1", role: "user", text: "hi" }],
              status: "done",
            },
          },
        },
      ],
    };

    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        applySlideState: (state) => {
          deckOpen.push(state.isOpen);
        },
        applyChatSnapshot: (snapshot) => {
          transcriptLengths.push(snapshot.items.length);
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    const takeApplied = () => {
      const applied = { deckOpen: [...deckOpen], transcriptLengths: [...transcriptLengths] };
      deckOpen.length = 0;
      transcriptLengths.length = 0;
      return applied;
    };
    takeApplied();

    actor.send({ type: "SEEK", time: 600 });
    expect(takeApplied()).toEqual({ deckOpen: [true], transcriptLengths: [1] });

    actor.send({ type: "SEEK", time: 100 });
    expect(takeApplied()).toEqual({ deckOpen: [false], transcriptLengths: [0] });

    actor.send({ type: "SEEK", time: 600 });
    takeApplied();
    actor.send({ type: "STOP" });
    expect(takeApplied()).toEqual({ deckOpen: [false], transcriptLengths: [0] });

    // Ticks that have not reached the first events leave the stores alone.
    actor.send({ type: "TICK", currentTime: 50 });
    actor.send({ type: "TICK", currentTime: 80 });
    expect(takeApplied()).toEqual({ deckOpen: [], transcriptLengths: [] });

    actor.stop();
  });

  // A chat-less recording must not keep showing the previous replay's transcript, and the
  // chat replay rewinds to this same baseline, so seeking and playing agree.
  it("empties the chat transcript at load, even without a chat track", async () => {
    const applied: ChatCheckpoint[] = [];
    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        applyChatSnapshot: (snapshot) => {
          applied.push(snapshot);
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording: createRecording() });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(applied).toEqual([{ items: [], status: "idle" }]);
    actor.stop();
  });

  // Pausing and seeking invalidate the preview and slide cursors. The PLAY that follows
  // used to advance from index 0, so every recorded click, focus and slide hop up to the
  // playhead fired again before playback resumed.
  describe("resuming replay after the cursors were invalidated", () => {
    const click = (timestamp: number, xpath: string): PreviewEvent => ({
      type: "preview_interaction",
      timestamp,
      size: "small",
      interaction: { type: "click", timestamp, target: { tagName: "button", xpath } },
    });

    const startReplay = async () => {
      const previewClicks: Array<string | undefined> = [];
      const slideIds: Array<string | null | undefined> = [];
      const recording: Recording = {
        ...createRecording(),
        duration: 6000,
        previewEvents: [
          { type: "preview_open", timestamp: 0, size: "small", content: "<p>page</p>" },
          click(1000, "/a"),
          click(2000, "/b"),
          click(3000, "/c"),
        ],
        slides: [
          { id: "s1", order: 0, content: "one", contentType: "html" },
          { id: "s2", order: 1, content: "two", contentType: "html" },
        ],
        slideEvents: [
          { type: "slide_open", timestamp: 0, slideId: "s1", indexv: 0 },
          { type: "slide_change", timestamp: 1500, slideId: "s2", indexv: 0 },
        ],
      };

      const actor = createActor(editorMachine, {
        input: {
          editorRef: { current: null },
          applyPreviewState: (state) => {
            previewClicks.push(state.currentInteraction?.target.xpath);
          },
          applySlideState: (state) => {
            slideIds.push(state.currentSlideId);
          },
        },
      }).start();

      actor.send({ type: "LOAD_RECORDING", recording });
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

      const takeApplied = () => {
        const applied = { previewClicks: [...previewClicks], slideIds: [...slideIds] };
        previewClicks.length = 0;
        slideIds.length = 0;
        return applied;
      };
      takeApplied();

      return { actor, takeApplied };
    };

    it("replays crossed clicks during playback but not again on resume", async () => {
      const { actor, takeApplied } = await startReplay();

      actor.send({ type: "PLAY" });
      takeApplied();
      actor.send({ type: "TICK", currentTime: 5000 });
      expect(takeApplied()).toEqual({ previewClicks: ["/a", "/b", "/c"], slideIds: ["s2"] });

      actor.send({ type: "PAUSE" });
      actor.send({ type: "PLAY" });
      expect(takeApplied()).toEqual({ previewClicks: [undefined], slideIds: ["s2"] });

      actor.stop();
    });

    it("resumes from a paused seek with only the state at the target", async () => {
      const { actor, takeApplied } = await startReplay();

      actor.send({ type: "PLAY" });
      actor.send({ type: "PAUSE" });
      actor.send({ type: "SEEK", time: 2500 });
      takeApplied();

      actor.send({ type: "PLAY" });
      expect(takeApplied()).toEqual({ previewClicks: [undefined], slideIds: ["s2"] });

      actor.stop();
    });

    it("starts from a seek made before the first PLAY with only the state at the target", async () => {
      const { actor, takeApplied } = await startReplay();

      actor.send({ type: "SEEK", time: 3500 });
      takeApplied();

      actor.send({ type: "PLAY" });
      expect(takeApplied()).toEqual({ previewClicks: [undefined], slideIds: ["s2"] });

      actor.stop();
    });
  });

  // Every replayed workspace snapshot used to reset the slide cursor too, so the tick
  // that applied it re-applied every slide event from the start of the recording.
  it("applies each slide event once while workspace snapshots replay", async () => {
    const slideIds: Array<string | null | undefined> = [];
    let workspaceApplies = 0;
    let currentWorkspace = createTwoFileWorkspaceSnapshot("a.ts", "a", "b");

    const slideEvents = Array.from({ length: 20 }, (_, index) => ({
      type: "slide_change" as const,
      timestamp: 25 + index * 50,
      slideId: index % 2 === 0 ? "s1" : "s2",
      indexv: 0,
    }));
    const recording: Recording = {
      ...createRecording(),
      slides: [
        { id: "s1", order: 0, content: "one", contentType: "html" },
        { id: "s2", order: 1, content: "two", contentType: "html" },
      ],
      slideEvents,
      // A file switch every 100ms, so each one is a snapshot the replay must apply.
      workspaceEvents: Array.from({ length: 10 }, (_, index) => ({
        timestamp: index * 100,
        snapshot: createTwoFileWorkspaceSnapshot(index % 2 === 0 ? "a.ts" : "b.ts", "a", "b"),
      })),
    };

    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        getWorkspaceSnapshot: () => currentWorkspace,
        applyWorkspaceSnapshot: (snapshot) => {
          currentWorkspace = snapshot;
          workspaceApplies += 1;
        },
        applySlideState: (state) => {
          slideIds.push(state.currentSlideId);
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    actor.send({ type: "PLAY" });
    slideIds.length = 0;
    workspaceApplies = 0;

    for (let time = 16; time <= 1000; time += 16) {
      actor.send({ type: "TICK", currentTime: time });
    }

    expect(workspaceApplies).toBe(9);
    expect(slideIds).toEqual(slideEvents.map((event) => event.slideId));

    actor.stop();
  });

  it("replays from the end by applying each track once", async () => {
    const applied: string[] = [];

    const recording: Recording = {
      ...createRecording(),
      runtimeEvents: [
        {
          timestamp: 0,
          snapshot: { mode: "webcontainer", status: "starting", previewUrl: null },
        },
      ],
      whiteboardEvents: [
        {
          timestamp: 0,
          upserts: [{ id: "a", version: 1, versionNonce: 1, isDeleted: false }],
          isOpen: true,
        },
      ],
      chatEvents: [
        { timestamp: 0, event: { k: "checkpoint", state: { items: [], status: "idle" } } },
      ],
    };

    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        applyRuntimeSnapshot: () => {
          applied.push("runtime");
        },
        applyWhiteboardState: () => {
          applied.push("whiteboard");
        },
        applyChatSnapshot: () => {
          applied.push("chat");
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    actor.send({ type: "PLAY" });
    actor.send({ type: "FINISHED" });
    expect(actor.getSnapshot().matches({ playback: "ended" })).toBe(true);
    applied.length = 0;

    actor.send({ type: "PLAY" });

    expect(actor.getSnapshot().matches({ playback: "playing" })).toBe(true);
    expect(actor.getSnapshot().context.timeline.currentTime).toBe(0);
    expect(applied).toEqual(["runtime", "whiteboard", "chat"]);

    actor.stop();
  });

  it("applies workspace, runtime, then preview snapshots during replay sync", async () => {
    const calls: string[] = [];
    const firstWorkspace = createWorkspaceSnapshot("first", 0);
    const secondWorkspace = createWorkspaceSnapshot("second", 240);
    let currentWorkspace = createWorkspaceSnapshot("outside");

    const recording: Recording = {
      ...createRecording(),
      workspaceEvents: [
        {
          timestamp: 0,
          snapshot: firstWorkspace,
        },
        {
          timestamp: 100,
          snapshot: secondWorkspace,
        },
      ],
      runtimeEvents: [
        {
          timestamp: 0,
          snapshot: {
            mode: "webcontainer",
            status: "starting",
            previewUrl: null,
          },
        },
        {
          timestamp: 100,
          snapshot: {
            mode: "webcontainer",
            status: "ready",
            previewUrl: "http://localhost:4173",
          },
        },
      ],
      previewEvents: [
        {
          type: "preview_refresh",
          timestamp: 0,
          size: "small",
          content: "first-preview",
        },
        {
          type: "preview_refresh",
          timestamp: 100,
          size: "medium",
          content: "second-preview",
        },
      ],
    };

    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        getWorkspaceSnapshot: () => currentWorkspace,
        applyWorkspaceSnapshot: (snapshot) => {
          currentWorkspace = snapshot;
          calls.push(
            `workspace:${snapshot.project.files["index.html"].content}:${snapshot.sidebarScrollTop ?? 0}`,
          );
        },
        applyRuntimeSnapshot: (snapshot) => {
          calls.push(`runtime:${snapshot.status}`);
        },
        applyPreviewState: (snapshot) => {
          calls.push(`preview:${snapshot.content ?? ""}`);
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(calls).toEqual(["workspace:first:0", "runtime:starting", "preview:first-preview"]);

    calls.length = 0;
    actor.send({ type: "SEEK", time: 100 });

    expect(calls).toEqual(["workspace:second:240", "runtime:ready", "preview:second-preview"]);

    actor.stop();
  });

  it("does not accumulate panel width deltas when seeking repeatedly", async () => {
    // Panel widths replay as relative deltas folded into the live width, so the
    // replay must apply only the *net* delta between the last-applied event and
    // the seek target. A regression here re-summed every delta from the start on
    // each seek, so the sidebar grew without bound as the user scrubbed.
    let liveWidth = 200;
    // Mirror NextEditorProvider: the live snapshot getter never carries width deltas.
    let currentWorkspace: WorkspaceRecordingSnapshot = createWorkspaceSnapshot("outside");

    const recording: Recording = {
      ...createRecording(),
      workspaceEvents: [
        { timestamp: 0, snapshot: { ...createWorkspaceSnapshot("w0"), sidebarWidthDelta: 0 } },
        { timestamp: 100, snapshot: { ...createWorkspaceSnapshot("w1"), sidebarWidthDelta: 40 } },
        { timestamp: 200, snapshot: { ...createWorkspaceSnapshot("w2"), sidebarWidthDelta: 30 } },
      ],
    };

    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        getWorkspaceSnapshot: () => currentWorkspace,
        applyWorkspaceSnapshot: (snapshot) => {
          if (typeof snapshot.sidebarWidthDelta === "number") {
            liveWidth += snapshot.sidebarWidthDelta;
          }
          currentWorkspace = {
            activeFilePath: snapshot.activeFilePath,
            collapsedFolders: snapshot.collapsedFolders,
            sidebarScrollTop: snapshot.sidebarScrollTop,
            project: snapshot.project,
          };
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    // Loading applies the initial event (delta 0), leaving the base width.
    expect(liveWidth).toBe(200);

    actor.send({ type: "SEEK", time: 200 });
    expect(liveWidth).toBe(270); // 200 + 40 + 30

    // Seeking to the same time again must be a no-op, not re-add the deltas.
    actor.send({ type: "SEEK", time: 200 });
    actor.send({ type: "SEEK", time: 200 });
    expect(liveWidth).toBe(270);

    // Seeking backward rewinds the exact net delta...
    actor.send({ type: "SEEK", time: 100 });
    expect(liveWidth).toBe(240); // 270 - 30

    actor.send({ type: "SEEK", time: 0 });
    expect(liveWidth).toBe(200); // back to the base width

    // ...and seeking forward again lands on the same absolute width, not a drift.
    actor.send({ type: "SEEK", time: 200 });
    expect(liveWidth).toBe(270);

    actor.stop();
  });

  // Same invariant as the seek test above, on the pause/resume path.
  // `detachPlaybackWorkspace` runs on every entry into `playback.paused` and used
  // to reset `lastAppliedWorkspaceEventIndex` to -1, so the next PLAY re-summed
  // every width delta from the start on top of the width already applied.
  it("does not accumulate panel width deltas across pause and resume", async () => {
    let liveWidth = 200;
    let currentWorkspace: WorkspaceRecordingSnapshot = createWorkspaceSnapshot("outside");

    const recording: Recording = {
      ...createRecording(),
      workspaceEvents: [
        { timestamp: 0, snapshot: { ...createWorkspaceSnapshot("w0"), sidebarWidthDelta: 0 } },
        { timestamp: 100, snapshot: { ...createWorkspaceSnapshot("w1"), sidebarWidthDelta: 80 } },
      ],
    };

    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        getWorkspaceSnapshot: () => currentWorkspace,
        applyWorkspaceSnapshot: (snapshot) => {
          if (typeof snapshot.sidebarWidthDelta === "number") {
            liveWidth += snapshot.sidebarWidthDelta;
          }
          currentWorkspace = {
            activeFilePath: snapshot.activeFilePath,
            collapsedFolders: snapshot.collapsedFolders,
            sidebarScrollTop: snapshot.sidebarScrollTop,
            project: snapshot.project,
          };
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    expect(liveWidth).toBe(200);

    actor.send({ type: "SEEK", time: 150 });
    expect(liveWidth).toBe(280); // 200 + 80

    // Pause and resume repeatedly: the drag must not be re-applied each time.
    for (let i = 0; i < 3; i += 1) {
      actor.send({ type: "PLAY" });
      actor.send({ type: "PAUSE" });
      actor.send({ type: "SEEK", time: 150 });
    }

    expect(liveWidth).toBe(280);

    actor.stop();
  });

  // Only resize events carry a width field. Seeking back across events that do not
  // (a folder toggle, a file switch) lands on a resize event whose own delta was
  // applied when playback first passed it; handing that event back unchanged
  // re-applied it on every backward crossing.
  it("does not re-apply a resize when seeking back across events without one", async () => {
    let liveWidth = 200;
    let currentWorkspace: WorkspaceRecordingSnapshot = createWorkspaceSnapshot("outside");
    const folderToggle = { ...createWorkspaceSnapshot("w1"), collapsedFolders: ["src"] };

    const recording: Recording = {
      ...createRecording(),
      workspaceEvents: [
        { timestamp: 0, snapshot: { ...createWorkspaceSnapshot("w1"), sidebarWidthDelta: 0 } },
        { timestamp: 100, snapshot: { ...createWorkspaceSnapshot("w1"), sidebarWidthDelta: 40 } },
        { timestamp: 200, snapshot: folderToggle },
      ],
    };

    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        getWorkspaceSnapshot: () => currentWorkspace,
        applyWorkspaceSnapshot: (snapshot) => {
          if (typeof snapshot.sidebarWidthDelta === "number") {
            liveWidth += snapshot.sidebarWidthDelta;
          }
          currentWorkspace = {
            activeFilePath: snapshot.activeFilePath,
            collapsedFolders: snapshot.collapsedFolders,
            sidebarScrollTop: snapshot.sidebarScrollTop,
            project: snapshot.project,
          };
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    const widths: number[] = [];
    for (const time of [250, 150, 250, 150]) {
      actor.send({ type: "SEEK", time });
      widths.push(liveWidth);
    }

    // The recorded width after the drag is 240 at both times.
    expect(widths).toEqual([240, 240, 240, 240]);

    actor.stop();
  });

  it("keeps typed editor content visible when a same-file workspace snapshot follows it", async () => {
    const editor = new MockEditor(new MockTextModel("outside"));
    const initialWorkspace = createWorkspaceSnapshot("before");
    const typedWorkspace = createWorkspaceSnapshot("after");
    let currentWorkspace = createWorkspaceSnapshot("outside");

    const recording: Recording = {
      ...createRecording(),
      duration: 300,
      frames: [
        {
          timestamp: 0,
          isKeyframe: true,
          state: {
            content: "before",
            selection,
            position: { lineNumber: 1, column: 1 },
            viewState: null,
            mouseCursor: { x: 0, y: 0, visible: false },
          },
        },
        {
          timestamp: 100,
          isKeyframe: true,
          state: {
            content: "after",
            selection,
            position: { lineNumber: 1, column: 1 },
            viewState: null,
            mouseCursor: { x: 0, y: 0, visible: false },
          },
        },
      ],
      workspaceEvents: [
        {
          timestamp: 0,
          snapshot: initialWorkspace,
        },
        {
          // Studio captures this after the editor-content frame so the
          // runnable workspace has the typed code during and after replay.
          timestamp: 101,
          snapshot: typedWorkspace,
        },
      ],
    };

    const actor = createActor(editorMachine, {
      input: {
        editorRef: {
          current: editor as unknown as monaco.editor.IStandaloneCodeEditor,
        },
        getWorkspaceSnapshot: () => currentWorkspace,
        applyWorkspaceSnapshot: (snapshot) => {
          currentWorkspace = snapshot;
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(editor.getValue()).toBe("before");

    actor.send({ type: "TICK", currentTime: 150 });

    expect(currentWorkspace.project.files["index.html"].content).toBe("after");
    expect(editor.getValue()).toBe("after");

    actor.stop();
  });

  // A replayed sidebar scroll changes nothing the editor shows, so the frame applied on
  // it stands. Re-deriving it from the nearest keyframe for every scroll event of a
  // burst only applied the same frame again.
  it("keeps the applied frame across a replayed sidebar scroll", async () => {
    const editor = new MockEditor(new MockTextModel("outside"));
    let currentWorkspace = createWorkspaceSnapshot("outside");
    const recording: Recording = {
      ...createRecording(),
      frames: [
        {
          timestamp: 0,
          isKeyframe: true,
          state: {
            content: "hello",
            selection,
            position: { lineNumber: 1, column: 1 },
            viewState: {
              cursorState: [],
              viewState: { scrollLeft: 0, firstPosition: { lineNumber: 1, column: 1 } },
              contributionsState: {},
            } as unknown as monaco.editor.ICodeEditorViewState,
            mouseCursor: { x: 0, y: 0, visible: false },
          },
        },
      ],
      workspaceEvents: [
        { timestamp: 0, snapshot: createWorkspaceSnapshot("hello") },
        { timestamp: 100, snapshot: createWorkspaceSnapshot("hello", 40) },
      ],
    };
    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
        getWorkspaceSnapshot: () => currentWorkspace,
        applyWorkspaceSnapshot: (snapshot) => {
          currentWorkspace = snapshot;
        },
      },
    }).start();
    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    actor.send({ type: "PLAY" });
    actor.send({ type: "TICK", currentTime: 50 });
    const appliedFrame = actor.getSnapshot().context.currentFrame;
    const restoredViewStates = editor.restoredViewStates.length;

    actor.send({ type: "TICK", currentTime: 150 });

    expect(currentWorkspace.sidebarScrollTop).toBe(40);
    expect(actor.getSnapshot().context.currentFrame).toBe(appliedFrame);
    expect(editor.restoredViewStates).toHaveLength(restoredViewStates);
    expect(editor.getValue()).toBe("hello");
    actor.stop();
  });

  describe("a damaged frame skipped during replay", () => {
    // An edit recorded against other base text: replaying it on "hello" is a base mismatch.
    const createDamagedRecording = (): Recording => {
      const edit = createContentEditDelta("HELLO", {
        fileId: "recording",
        path: "recording",
        beforeVersion: 0,
        afterVersion: 1,
        beforeLength: 5,
        afterLength: 6,
        changes: [{ offset: 5, deleteLength: 0, text: "!" }],
      });
      if (!edit) throw new Error("Expected an exact content edit delta");
      const recording = createRecording();
      recording.frames.push({ timestamp: 500, isKeyframe: false, contentEditDelta: edit.delta });
      return recording;
    };

    const seekIntoDamage = async (onError?: (error: Error) => void) => {
      const editor = new MockEditor(new MockTextModel(""));
      const actor = createActor(editorMachine, {
        input: {
          editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
          onError,
        },
      }).start();
      actor.send({ type: "LOAD_RECORDING", recording: createDamagedRecording() });
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
      expect(editor.getValue()).toBe("hello");

      actor.send({ type: "SEEK", time: 600 });

      expect(actor.getSnapshot().status).toBe("active");
      expect(actor.getSnapshot().context.lastAppliedFrameIndex).toBe(1);
      actor.stop();
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // The app's provider passes no onError, so the skip used to leave no trace at all.
    it("logs the error when the host supplies no onError", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      await seekIntoDamage();

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[editorMachine]",
        expect.any(ContentEditBaseMismatchError),
      );
    });

    it("reports only to the host's onError when one is supplied", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const onError = vi.fn<(error: Error) => void>();

      await seekIntoDamage(onError);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.any(ContentEditBaseMismatchError));
      expect(consoleError).not.toHaveBeenCalled();
    });

    // Skipping is only useful if replay carries on: the next keyframe re-bases the editor.
    it("still applies the keyframe after the damaged frame", async () => {
      const onError = vi.fn<(error: Error) => void>();
      const recording = createDamagedRecording();
      recording.frames.push({
        timestamp: 700,
        isKeyframe: true,
        state: {
          content: "recovered",
          selection,
          position: { lineNumber: 1, column: 1 },
          viewState: null,
          mouseCursor: { x: 0, y: 0, visible: false },
        },
      });
      const editor = new MockEditor(new MockTextModel(""));
      const actor = createActor(editorMachine, {
        input: {
          editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
          onError,
        },
      }).start();
      actor.send({ type: "LOAD_RECORDING", recording });
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

      actor.send({ type: "SEEK", time: 600 });
      actor.send({ type: "SEEK", time: 800 });

      expect(actor.getSnapshot().status).toBe("active");
      expect(actor.getSnapshot().context.lastAppliedFrameIndex).toBe(2);
      expect(editor.getValue()).toBe("recovered");
      expect(onError).toHaveBeenCalledTimes(1);
      actor.stop();
    });

    // A skipped frame leaves no fold at lastAppliedFrameIndex to build on. The frame after
    // it used to be folded onto whatever was applied before, so a relative caret delta
    // landed on the wrong base and the caret drifted until the next keyframe. A seek keeps
    // currentFrame as Monaco's diff base, so after a seek into the damage that base was
    // the frame shown before the seek.
    it.each([
      { into: "a tick crossed", event: { type: "TICK", currentTime: 550 } },
      { into: "a seek landed on", event: { type: "SEEK", time: 550 } },
    ] as const)("skips the next frame too when $into the damage", async ({ event }) => {
      const onError = vi.fn<(error: Error) => void>();
      const recording = createDamagedRecording();
      recording.frames.push({
        timestamp: 600,
        isKeyframe: false,
        positionDelta: { lineDelta: 0, columnDelta: 3 },
        selectionDelta: {
          startColumnDelta: 3,
          endColumnDelta: 3,
          selectionStartColumnDelta: 3,
          positionColumnDelta: 3,
        },
      });
      const editor = new MockEditor(new MockTextModel(""));
      const actor = createActor(editorMachine, {
        input: {
          editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
          onError,
        },
      }).start();
      actor.send({ type: "LOAD_RECORDING", recording });
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
      actor.send({ type: "PLAY" });
      actor.send(event);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(actor.getSnapshot().context.lastAppliedFrameIndex).toBe(1);

      actor.send({ type: "TICK", currentTime: 650 });

      const { context, status } = actor.getSnapshot();
      expect(status).toBe("active");
      expect(context.lastAppliedFrameIndex).toBe(2);
      expect(context.currentFrame).toBeNull();
      expect(editor.getSelection()).toEqual(selection);
      expect(onError).toHaveBeenCalledTimes(2);
      actor.stop();
    });
  });

  // A tick often crosses more than one frame: a mouse frame and a content frame are
  // recorded a few ms apart, and 2x playback halves the gap. Such a tick used to rebuild
  // its target from the keyframe, re-applying every content delta since it.
  describe("a tick that crosses several frames", () => {
    const typedFrame = (timestamp: number, content: string): EditorFrame => {
      const column = content.length + 1;
      return {
        timestamp,
        state: {
          content,
          selection: {
            ...selection,
            startColumn: column,
            endColumn: column,
            selectionStartColumn: column,
            positionColumn: column,
          },
          position: { lineNumber: 1, column },
          viewState: null,
          mouseCursor: { x: 0, y: 0, visible: false },
        },
      };
    };

    let realCodec: DmpCodec;
    let contentDeltaApplies = 0;

    beforeEach(() => {
      realCodec = getDmpCodec();
      contentDeltaApplies = 0;
      installDmpCodec({
        diffDelta: (a, b) => realCodec.diffDelta(a, b),
        applyDelta: (a, delta) => {
          contentDeltaApplies += 1;
          return realCodec.applyDelta(a, delta);
        },
      });
    });

    afterEach(() => {
      installDmpCodec(realCodec);
    });

    it("applies only the crossed deltas and lands on the reconstructed frame", async () => {
      const frames = compressFrames(
        ["c", "co", "con", "cons", "const", "const ", "const x"].map((content, index) =>
          typedFrame(index * 5, content),
        ),
      );
      const editor = new MockEditor(new MockTextModel(""));
      const actor = createActor(editorMachine, {
        input: { editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor } },
      }).start();
      actor.send({ type: "LOAD_RECORDING", recording: { ...createRecording(), frames } });
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

      actor.send({ type: "TICK", currentTime: 12 });
      expect(actor.getSnapshot().context.lastAppliedFrameIndex).toBe(2);

      contentDeltaApplies = 0;
      actor.send({ type: "TICK", currentTime: 30 });

      expect(actor.getSnapshot().context.lastAppliedFrameIndex).toBe(6);
      expect(contentDeltaApplies).toBe(4);
      const expected = reconstructFrameAtIndex(frames, 6);
      expect(editor.getValue()).toBe("const x");
      expect(editor.getValue()).toBe(expected?.state.content);
      expect(editor.getSelection()).toEqual(expected?.state.selection);
      expect(actor.getSnapshot().context.currentFrame).toEqual(expected);
      actor.stop();
    });
  });

  // Replay frames arrive normalized, so applying one no longer deep-copies it first. A
  // keyframe is the recording's own object, and Monaco must not hold its view state.
  it("hands Monaco a copy of a keyframe's view state", async () => {
    const viewState = {
      cursorState: [],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 1, column: 1 },
        firstPositionDeltaTop: 40,
      },
      contributionsState: {},
    } as unknown as monaco.editor.ICodeEditorViewState;
    const recording = createRecording();
    const [keyframe] = recording.frames as EditorFrame[];
    keyframe.state.viewState = viewState;
    const editor = new MockEditor(new MockTextModel(""));
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor } },
    }).start();
    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    const [loadedKeyframe] = (actor.getSnapshot().context.recording?.frames ?? []) as EditorFrame[];
    expect(editor.restoredViewStates).toHaveLength(1);
    expect(editor.restoredViewStates[0]).toEqual(loadedKeyframe.state.viewState);
    expect(editor.restoredViewStates[0]).not.toBe(loadedKeyframe.state.viewState);
    actor.stop();
  });

  // The chat fold applies content deltas too, and throws on a damaged track just like
  // frame reconstruction. The throw runs inside the same `assign`, so it would stop the
  // actor for good if it escaped.
  describe("a damaged chat delta skipped during replay", () => {
    // The content delta was recorded against "hello", but the message it lands on is empty.
    const createDamagedChatRecording = (): Recording => {
      const delta = createContentDelta("hello", "hello world");
      if (!delta) throw new Error("Expected a content delta");
      return {
        ...createRecording(),
        chatEvents: [
          { timestamp: 100, event: { k: "message_start", id: "msg-1", role: "assistant" } },
          { timestamp: 200, event: { k: "content", delta } },
          { timestamp: 300, event: { k: "status", status: "done" } },
        ],
      };
    };

    it("reports the error and keeps the actor running", async () => {
      const onError = vi.fn<(error: Error) => void>();
      const applied: number[] = [];
      const recording = createDamagedChatRecording();
      const actor = createActor(editorMachine, {
        input: {
          editorRef: { current: null },
          onError,
          applyChatSnapshot: (snapshot) => {
            applied.push(snapshot.items.length);
          },
        },
      }).start();
      actor.send({ type: "LOAD_RECORDING", recording });
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
      applied.length = 0;

      actor.send({ type: "SEEK", time: 400 });

      expect(actor.getSnapshot().status).toBe("active");
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.any(DmpBaseMismatchError));
      expect(actor.getSnapshot().context.lastAppliedChatEventIndex).toBe(
        (recording.chatEvents?.length ?? 0) - 1,
      );
      expect(applied).toEqual([]);

      // A later seek to before the damage folds the transcript again.
      actor.send({ type: "SEEK", time: 150 });

      expect(applied).toEqual([1]);
      expect(onError).toHaveBeenCalledTimes(1);
      actor.stop();
    });
  });

  it("waits for Monaco model sync before applying frames after replayed file switches", async () => {
    const editor = new MockEditor(new MockTextModel("outside"));
    const firstWorkspace = createTwoFileWorkspaceSnapshot("a.ts", "a-snapshot", "b-before-open");
    const secondWorkspace = createTwoFileWorkspaceSnapshot("b.ts", "a-snapshot", "b-snapshot");
    let currentWorkspace = createTwoFileWorkspaceSnapshot("a.ts", "outside-a", "outside-b");

    const recording: Recording = {
      ...createRecording(),
      frames: [
        {
          timestamp: 0,
          isKeyframe: true,
          state: {
            content: "a-frame",
            selection,
            position: { lineNumber: 1, column: 1 },
            viewState: null,
            mouseCursor: { x: 0, y: 0, visible: false },
          },
        },
        {
          timestamp: 100,
          isKeyframe: true,
          state: {
            content: "b-frame",
            selection,
            position: { lineNumber: 1, column: 1 },
            viewState: null,
            mouseCursor: { x: 0, y: 0, visible: false },
          },
        },
      ],
      workspaceEvents: [
        {
          timestamp: 0,
          snapshot: firstWorkspace,
        },
        {
          timestamp: 100,
          snapshot: secondWorkspace,
        },
      ],
    };

    const actor = createActor(editorMachine, {
      input: {
        editorRef: {
          current: editor as unknown as monaco.editor.IStandaloneCodeEditor,
        },
        getWorkspaceSnapshot: () => currentWorkspace,
        applyWorkspaceSnapshot: (snapshot) => {
          currentWorkspace = snapshot;
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(editor.getValue()).toBe("a-frame");

    actor.send({ type: "SEEK", time: 100 });

    expect(currentWorkspace.activeFilePath).toBe("b.ts");
    expect(actor.getSnapshot().context.pendingPlaybackEditorSync).toBe(true);
    expect(editor.getValue()).toBe("a-frame");

    actor.send({
      type: "SET_EDITOR_REF",
      editor: editor as unknown as monaco.editor.IStandaloneCodeEditor,
    });

    expect(actor.getSnapshot().context.pendingPlaybackEditorSync).toBe(false);
    expect(editor.getValue()).toBe("b-frame");

    actor.stop();
  });

  // A paused SEEK reattaches the recorded workspace for that one transition and detaches
  // again, so no model swap (and no SET_EDITOR_REF) ever follows it. The pending editor
  // sync that reattaching sets used to make every paused scrub skip its target frame.
  describe("seeking while paused", () => {
    const keyframe = (timestamp: number, content: string): Recording["frames"][number] => ({
      timestamp,
      isKeyframe: true,
      state: {
        content,
        selection,
        position: { lineNumber: 1, column: 1 },
        viewState: null,
        mouseCursor: { x: 0, y: 0, visible: false },
      },
    });

    const startPausedAt50 = async (recording: Recording) => {
      const editor = new MockEditor(new MockTextModel("outside"));
      const workspace = {
        current: createTwoFileWorkspaceSnapshot("a.ts", "outside-a", "outside-b"),
      };
      const actor = createActor(editorMachine, {
        input: {
          editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
          getWorkspaceSnapshot: () => workspace.current,
          applyWorkspaceSnapshot: (snapshot) => {
            workspace.current = snapshot;
          },
        },
      }).start();

      actor.send({ type: "LOAD_RECORDING", recording });
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
      actor.send({ type: "PLAY" });
      actor.send({ type: "TICK", currentTime: 50 });
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().matches({ playback: "paused" })).toBe(true);

      return { actor, editor, workspace };
    };

    const recordingOnOneFile = (): Recording => ({
      ...createRecording(),
      frames: [keyframe(0, "a"), keyframe(100, "ab"), keyframe(200, "abc")],
      workspaceEvents: [
        { timestamp: 0, snapshot: createTwoFileWorkspaceSnapshot("a.ts", "a", "b") },
      ],
    });

    it("applies the target frame to the editor and adopts it into the workspace", async () => {
      const { actor, editor, workspace } = await startPausedAt50(recordingOnOneFile());
      expect(editor.getValue()).toBe("a");

      actor.send({ type: "SEEK", time: 250 });
      expect(editor.getValue()).toBe("abc");
      expect(workspace.current.project.files["a.ts"].content).toBe("abc");

      actor.send({ type: "SEEK", time: 150 });
      expect(editor.getValue()).toBe("ab");
      expect(workspace.current.project.files["a.ts"].content).toBe("ab");

      // Still paused and detached: the viewer can keep editing what they scrubbed to.
      const { context } = actor.getSnapshot();
      expect(actor.getSnapshot().matches({ playback: "paused" })).toBe(true);
      expect(context.hasManualWorkspaceOverride).toBe(true);
      expect(context.pendingPlaybackEditorSync).toBe(false);

      actor.stop();
    });

    it("still waits for the model swap when the seek replays a file switch", async () => {
      const { actor, editor, workspace } = await startPausedAt50({
        ...createRecording(),
        frames: [keyframe(0, "a-frame"), keyframe(100, "b-frame")],
        workspaceEvents: [
          {
            timestamp: 0,
            snapshot: createTwoFileWorkspaceSnapshot("a.ts", "a-snapshot", "b-before-open"),
          },
          {
            timestamp: 100,
            snapshot: createTwoFileWorkspaceSnapshot("b.ts", "a-snapshot", "b-snapshot"),
          },
        ],
      });

      actor.send({ type: "SEEK", time: 150 });

      // b.ts's frame must not land in the a.ts model that is still bound.
      expect(workspace.current.activeFilePath).toBe("b.ts");
      expect(editor.getValue()).toBe("a-frame");
      expect(workspace.current.project.files["b.ts"].content).toBe("b-snapshot");

      actor.stop();
    });

    it("keeps what the replay showed in a file the viewer leaves after pausing", async () => {
      const editor = new MockEditor(new MockTextModel("outside"));
      const workspace = {
        current: createTwoFileWorkspaceSnapshot("a.ts", "outside-a", "outside-b"),
      };
      const actor = createActor(editorMachine, {
        input: {
          editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
          getWorkspaceSnapshot: () => workspace.current,
          applyWorkspaceSnapshot: (snapshot) => {
            workspace.current = snapshot;
          },
        },
      }).start();
      actor.send({ type: "LOAD_RECORDING", recording: recordingOnOneFile() });
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
      actor.send({ type: "PLAY" });
      actor.send({ type: "TICK", currentTime: 150 });

      // Opening another file pauses first (useOpenWorkspaceFile): the pause copies the
      // frame on screen into a.ts while it is still the active file. A WORKSPACE_EVENT
      // straight from `playing` detaches before that copy, and a.ts would keep "a".
      actor.send({ type: "PAUSE" });
      workspace.current = { ...workspace.current, activeFilePath: "b.ts" };
      actor.send({ type: "WORKSPACE_EVENT" });

      expect(workspace.current.project.files["a.ts"].content).toBe("ab");
      expect(workspace.current.activeFilePath).toBe("b.ts");
      expect(actor.getSnapshot().matches({ playback: "paused" })).toBe(true);
      expect(actor.getSnapshot().context.hasManualWorkspaceOverride).toBe(true);

      actor.stop();
    });

    it("leaves a file the viewer opened while paused untouched", async () => {
      const { actor, editor, workspace } = await startPausedAt50(recordingOnOneFile());

      const viewerModel = new MockTextModel("b-user");
      editor.setModel(viewerModel as unknown as monaco.editor.ITextModel);
      workspace.current = createTwoFileWorkspaceSnapshot("b.ts", "a", "b-user");
      actor.send({ type: "WORKSPACE_EVENT" });
      actor.send({
        type: "SET_EDITOR_REF",
        editor: editor as unknown as monaco.editor.IStandaloneCodeEditor,
      });

      // Same workspace interval as the pause, so no recorded snapshot re-opens a.ts.
      actor.send({ type: "SEEK", time: 250 });

      expect(viewerModel.getValue()).toBe("b-user");
      expect(workspace.current.activeFilePath).toBe("b.ts");
      expect(workspace.current.project.files["b.ts"].content).toBe("b-user");

      actor.stop();
    });
  });
});

// Playback driven by the real timeline child: its ticker runs one frame per advance(),
// against the pinned clock, so positions come out exact.
describe("editorMachine playback lifecycle", () => {
  let clock: { now: number };
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    clock = pinPerformanceClock();
    frames = new Map();
    let nextFrameId = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn<(callback: FrameRequestCallback) => number>((callback) => {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn<(id: number) => void>((id) => {
        frames.delete(id);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const advance = (ms: number) => {
    clock.now += ms;
    const [frameId, callback] = [...frames.entries()][0]!;
    frames.delete(frameId);
    callback(clock.now);
  };

  const startPlayback = async (options: { pauseOnUserInteraction?: boolean } = {}) => {
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null }, ...options },
    }).start();
    actor.send({ type: "LOAD_RECORDING", recording: createRecording() });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    actor.send({ type: "PLAY" });
    expect(actor.getSnapshot().matches({ playback: "playing" })).toBe(true);
    return actor;
  };

  const currentTime = (actor: Awaited<ReturnType<typeof startPlayback>>) =>
    actor.getSnapshot().context.timeline.currentTime;

  it("continues from a seek made while playing", async () => {
    const actor = await startPlayback();

    advance(100);
    expect(currentTime(actor)).toBe(100);

    actor.send({ type: "SEEK", time: 600 });
    advance(50);
    expect(currentTime(actor)).toBe(650);

    actor.stop();
  });

  it("ends at the duration and restarts from the start on PLAY", async () => {
    const actor = await startPlayback();

    advance(1_200);
    expect(actor.getSnapshot().matches({ playback: "ended" })).toBe(true);
    expect(currentTime(actor)).toBe(1_000);

    actor.send({ type: "PLAY" });
    expect(actor.getSnapshot().matches({ playback: "playing" })).toBe(true);
    expect(currentTime(actor)).toBe(0);

    advance(50);
    expect(currentTime(actor)).toBe(50);

    actor.stop();
  });

  it("resumes from a seek made after the end instead of restarting", async () => {
    const actor = await startPlayback();
    advance(1_200);

    actor.send({ type: "SEEK", time: 300 });
    actor.send({ type: "PLAY" });
    expect(actor.getSnapshot().matches({ playback: "playing" })).toBe(true);
    expect(currentTime(actor)).toBe(300);

    advance(100);
    expect(currentTime(actor)).toBe(400);

    actor.stop();
  });

  it("pauses when the viewer interacts", async () => {
    const actor = await startPlayback();

    actor.send({ type: "USER_INTERACTION" });

    expect(actor.getSnapshot().matches({ playback: "paused" })).toBe(true);
    expect(frames.size).toBe(0);
    actor.stop();
  });

  it("keeps playing through interaction when the host opts out of pausing", async () => {
    const actor = await startPlayback({ pauseOnUserInteraction: false });

    actor.send({ type: "USER_INTERACTION" });
    advance(100);

    expect(actor.getSnapshot().matches({ playback: "playing" })).toBe(true);
    expect(currentTime(actor)).toBe(100);
    actor.stop();
  });

  it("pauses and hands the workspace to the viewer when they change it", async () => {
    const actor = await startPlayback();
    advance(100);

    actor.send({ type: "WORKSPACE_EVENT" });

    expect(actor.getSnapshot().matches({ playback: "paused" })).toBe(true);
    expect(actor.getSnapshot().context.hasManualWorkspaceOverride).toBe(true);
    expect(currentTime(actor)).toBe(100);
    expect(frames.size).toBe(0);
    actor.stop();
  });

  it("stops back to the start", async () => {
    const actor = await startPlayback();
    advance(400);

    actor.send({ type: "STOP" });
    expect(actor.getSnapshot().matches({ playback: "ready" })).toBe(true);
    expect(currentTime(actor)).toBe(0);
    expect(frames.size).toBe(0);

    actor.send({ type: "PLAY" });
    advance(50);
    expect(currentTime(actor)).toBe(50);

    actor.stop();
  });
});

// ===========================================================================
// stoppingRecording: the finalize join between the microphone and camera
// ===========================================================================

interface FakeRecorderControls {
  stopRequests: number;
  disposals: number;
  emitStopped: (blob: Blob) => void;
  emitError: (error: string) => void;
}

const createFakeRecorderControls = (): FakeRecorderControls => ({
  stopRequests: 0,
  disposals: 0,
  emitStopped: () => {},
  emitError: () => {},
});

describe("editorMachine stoppingRecording join", () => {
  // Empty, so `loading` does not try to decode it for an exact duration (jsdom has no
  // AudioContext). The join only cares which blob ends up where.
  const micBlob = new Blob([], { type: "audio/webm" });
  const cameraBlob = new Blob(["video"], { type: "video/webm" });

  let mic = createFakeRecorderControls();
  let camera = createFakeRecorderControls();
  let actors: Array<ReturnType<typeof startTake>> = [];

  // Each fake reports STARTED on START and otherwise does only what the test tells it
  // to, so every test picks the order in which the recorders report.
  const machine = editorMachine.provide({
    actors: {
      audioRecording: fromTypedCallback<
        AudioRecordingEvent,
        AudioRecordingInput,
        AudioRecordingEmit
      >(({ receive, sendBack }) => {
        mic.emitStopped = (blob) => sendBack({ type: "AUDIO_RECORDING_STOPPED", blob });
        mic.emitError = (error) => sendBack({ type: "AUDIO_RECORDING_ERROR", error });
        receive((event) => {
          if (event.type === "STOP") {
            mic.stopRequests += 1;
            return;
          }
          sendBack({
            type: "AUDIO_RECORDING_STARTED",
            mediaRecorder: {} as MediaRecorder,
            mimeType: "audio/webm",
            startedAtMs: Date.now(),
            startedAtPerf: performance.now(),
          });
        });
        return () => {
          mic.disposals += 1;
        };
      }),
      cameraRecording: fromTypedCallback<
        CameraRecordingEvent,
        CameraRecordingInput,
        CameraRecordingEmit
      >(({ receive, sendBack }) => {
        camera.emitStopped = (blob) => sendBack({ type: "CAMERA_STOPPED", blob });
        camera.emitError = (error) => sendBack({ type: "CAMERA_ERROR", error });
        receive((event) => {
          if (event.type === "STOP") {
            camera.stopRequests += 1;
            return;
          }
          sendBack({
            type: "CAMERA_STARTED",
            mimeType: "video/webm",
            startedAtPerf: performance.now(),
            mediaRecorder: {} as MediaRecorder,
          });
        });
        return () => {
          camera.disposals += 1;
        };
      }),
      // Selected-file audio, and playback of a take that has it, spawn an HTMLAudioElement.
      audioPlayback: fromTypedCallback<AudioPlaybackEvent, AudioPlaybackInput, AudioPlaybackEmit>(
        () => {},
      ),
    },
  });

  function startTake({
    takeMachine = machine,
    enableCameraRecording,
  }: { takeMachine?: typeof machine; enableCameraRecording?: boolean } = {}) {
    const onRecordingStop = vi.fn<(recording: Recording) => void>();
    const onError = vi.fn<(error: Error) => void>();
    const actor = createActor(takeMachine, {
      input: {
        editorRef: { current: null },
        enableAudioRecording: true,
        enableCameraRecording,
        onRecordingStop,
        onError,
      },
    }).start();
    return { actor, onRecordingStop, onError };
  }

  // Records a take and stops it, leaving the machine in `stoppingRecording`.
  const recordAndStop = async (
    event: { audioBlob?: Blob; enableCamera?: boolean } = {},
  ): Promise<ReturnType<typeof startTake>> => {
    const take = startTake();
    actors.push(take);
    take.actor.send({ type: "START_RECORDING", enableCamera: true, ...event });
    await waitFor(take.actor, (snapshot) => snapshot.matches("recording"));
    take.actor.send({ type: "STOP_RECORDING" });
    expect(take.actor.getSnapshot().value).toBe("stoppingRecording");
    return take;
  };

  const expectFinalizedOnce = async ({ actor, onRecordingStop }: ReturnType<typeof startTake>) => {
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    expect(onRecordingStop).toHaveBeenCalledTimes(1);
    return actor.getSnapshot().context.recording!;
  };

  beforeEach(() => {
    mic = createFakeRecorderControls();
    camera = createFakeRecorderControls();
  });

  afterEach(() => {
    for (const { actor } of actors) actor.stop();
    actors = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("finalizes a microphone-only take when its blob arrives", async () => {
    const take = await recordAndStop({ enableCamera: false });
    expect(mic.stopRequests).toBe(1);

    mic.emitStopped(micBlob);
    expect(take.actor.getSnapshot().value).toBe("loading");

    const recording = await expectFinalizedOnce(take);
    expect(recording.audioBlob).toBe(micBlob);
    expect(recording.audioSource).toBe("microphone");
    expect(recording.cameraBlob).toBeUndefined();
    expect(take.actor.getSnapshot().children.audioRecorder).toBeUndefined();
    expect(mic.disposals).toBe(1);
  });

  it("waits for the camera when the microphone stops first", async () => {
    const take = await recordAndStop();
    expect(mic.stopRequests).toBe(1);
    expect(camera.stopRequests).toBe(1);

    mic.emitStopped(micBlob);
    expect(take.actor.getSnapshot().value).toBe("stoppingRecording");
    expect(take.actor.getSnapshot().children.audioRecorder).toBeUndefined();
    expect(take.onRecordingStop).not.toHaveBeenCalled();

    camera.emitStopped(cameraBlob);
    expect(take.actor.getSnapshot().value).toBe("loading");

    const recording = await expectFinalizedOnce(take);
    expect(recording.audioBlob).toBe(micBlob);
    expect(recording.audioSource).toBe("microphone");
    expect(recording.cameraBlob).toBe(cameraBlob);
    expect(take.actor.getSnapshot().children.cameraRecorder).toBeUndefined();
    expect(mic.disposals).toBe(1);
    expect(camera.disposals).toBe(1);
  });

  it("waits for the microphone when the camera stops first", async () => {
    const take = await recordAndStop();

    camera.emitStopped(cameraBlob);
    expect(take.actor.getSnapshot().value).toBe("stoppingRecording");
    expect(take.actor.getSnapshot().children.cameraRecorder).toBeUndefined();
    expect(take.onRecordingStop).not.toHaveBeenCalled();

    mic.emitStopped(micBlob);
    expect(take.actor.getSnapshot().value).toBe("loading");

    const recording = await expectFinalizedOnce(take);
    expect(recording.audioBlob).toBe(micBlob);
    expect(recording.cameraBlob).toBe(cameraBlob);
    expect(take.actor.getSnapshot().children.audioRecorder).toBeUndefined();
    expect(mic.disposals).toBe(1);
    expect(camera.disposals).toBe(1);
  });

  it("finalizes selected-file audio once the camera stops", async () => {
    const selectedAudio = new Blob(["audio"], { type: "audio/webm" });
    const take = await recordAndStop({ audioBlob: selectedAudio });
    expect(mic.stopRequests).toBe(0);
    expect(camera.stopRequests).toBe(1);

    camera.emitStopped(cameraBlob);
    expect(take.actor.getSnapshot().value).toBe("loading");

    const recording = await expectFinalizedOnce(take);
    expect(recording.audioBlob).toBe(selectedAudio);
    expect(recording.audioSource).toBe("external");
    expect(recording.cameraBlob).toBe(cameraBlob);
    expect(take.actor.getSnapshot().children.cameraRecorder).toBeUndefined();
  });

  // Records a selected-file take whose 5s narration ends after 5150ms of wall time, the
  // extra 150ms being play()'s startup latency. `advance` moves the finalize clock and the
  // watchdog's timer together.
  const recordNarration = (enableCamera: boolean) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock = pinPerformanceClock();
    const advance = (ms: number) => {
      clock.now += ms;
      vi.advanceTimersByTime(ms);
    };
    let endNarration = () => {};
    const take = startTake({
      takeMachine: machine.provide({
        actors: {
          audioPlayback: fromTypedCallback<
            AudioPlaybackEvent,
            AudioPlaybackInput,
            AudioPlaybackEmit
          >(({ receive, sendBack }) => {
            endNarration = () => sendBack({ type: "AUDIO_PLAYBACK_FINISHED" });
            receive((event) => {
              if (event.type === "PLAY") {
                sendBack({ type: "AUDIO_PLAYBACK_READY", durationMs: 5000 });
              }
            });
          }),
        },
      }),
    });
    actors.push(take);

    take.actor.send({
      type: "START_RECORDING",
      audioBlob: new Blob(["audio"], { type: "audio/webm" }),
      enableCamera,
    });
    expect(take.actor.getSnapshot().context.audio.externalDurationMs).toBe(5000);
    advance(5150);
    endNarration();
    return { take, advance };
  };

  // With the camera on, the narration's end goes through stoppingRecording, and the take
  // was measured when the camera answered. Its stop latency, or the whole 2s watchdog,
  // became a silent tail that loading never trims for selected-file audio.
  it("measures selected-file audio by its narration when it ends the take", async () => {
    const { take } = recordNarration(false);

    const recording = await expectFinalizedOnce(take);
    expect(recording.duration).toBe(5000);
  });

  it("measures selected-file audio by its narration when the camera stops later", async () => {
    const { take, advance } = recordNarration(true);
    expect(take.actor.getSnapshot().value).toBe("stoppingRecording");

    advance(300);
    camera.emitStopped(cameraBlob);

    const recording = await expectFinalizedOnce(take);
    expect(recording.cameraBlob).toBe(cameraBlob);
    expect(recording.duration).toBe(5000);
  });

  it("measures selected-file audio by its narration when the watchdog finalizes", async () => {
    const { take, advance } = recordNarration(true);
    expect(take.actor.getSnapshot().value).toBe("stoppingRecording");

    advance(2000);

    const recording = await expectFinalizedOnce(take);
    expect(recording.duration).toBe(5000);
  });

  // A take's camera choice used to become the default for the next one, so a single
  // manual camera take turned the camera on for a later start that makes no choice,
  // such as a studio render on the same page.
  it("does not carry a take's camera choice into a start that makes none", async () => {
    const take = await recordAndStop({ enableCamera: true });
    mic.emitStopped(micBlob);
    camera.emitStopped(cameraBlob);
    await expectFinalizedOnce(take);
    take.actor.send({ type: "UNLOAD" });

    take.actor.send({ type: "START_RECORDING" });
    await waitFor(take.actor, (snapshot) => snapshot.matches("recording"));

    expect(take.actor.getSnapshot().context.enableCameraRecording).toBe(false);
    expect(take.actor.getSnapshot().children.cameraRecorder).toBeUndefined();
  });

  it("starts the camera from the configured default when a start makes no choice", async () => {
    const take = startTake({ enableCameraRecording: true });
    actors.push(take);

    take.actor.send({ type: "START_RECORDING" });
    await waitFor(take.actor, (snapshot) => snapshot.matches("recording"));

    expect(take.actor.getSnapshot().context.enableCameraRecording).toBe(true);
    expect(take.actor.getSnapshot().children.cameraRecorder).toBeDefined();
  });

  it("finalizes on the microphone after the camera fails while stopping", async () => {
    const take = await recordAndStop();

    camera.emitError("camera failed");
    expect(take.actor.getSnapshot().value).toBe("stoppingRecording");
    expect(take.actor.getSnapshot().children.cameraRecorder).toBeUndefined();

    mic.emitStopped(micBlob);
    expect(take.actor.getSnapshot().value).toBe("loading");

    const recording = await expectFinalizedOnce(take);
    expect(recording.audioBlob).toBe(micBlob);
    expect(recording.cameraBlob).toBeUndefined();
    expect(take.actor.getSnapshot().children.audioRecorder).toBeUndefined();
  });

  it("finalizes on a camera failure once the microphone has stopped", async () => {
    const take = await recordAndStop();

    mic.emitStopped(micBlob);
    camera.emitError("camera failed");
    expect(take.actor.getSnapshot().value).toBe("loading");

    const recording = await expectFinalizedOnce(take);
    expect(recording.audioBlob).toBe(micBlob);
    expect(recording.cameraBlob).toBeUndefined();
    expect(take.actor.getSnapshot().children.audioRecorder).toBeUndefined();
    expect(take.actor.getSnapshot().children.cameraRecorder).toBeUndefined();
  });

  it("finalizes through the watchdog when the camera never reports", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const take = await recordAndStop();

    mic.emitStopped(micBlob);
    vi.advanceTimersByTime(1999);
    expect(take.actor.getSnapshot().value).toBe("stoppingRecording");
    vi.advanceTimersByTime(1);
    expect(take.actor.getSnapshot().value).toBe("loading");

    const recording = await expectFinalizedOnce(take);
    expect(recording.audioBlob).toBe(micBlob);
    expect(recording.cameraBlob).toBeUndefined();
    expect(take.actor.getSnapshot().children.audioRecorder).toBeUndefined();
    expect(take.actor.getSnapshot().children.cameraRecorder).toBeUndefined();
    expect(camera.disposals).toBe(1);
  });

  // With no loaded take to splice a late blob into, it would sit in idle's audio slice and
  // ride into the next take.
  it("stops a recorder the watchdog overtook when its take fails to load", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onError = vi.fn<(error: Error) => void>();
    const actor = createActor(
      machine.provide({ actions: { finalizeRecording: assign({ recording: null }) } }),
      { input: { editorRef: { current: null }, enableAudioRecording: true, onError } },
    ).start();

    try {
      actor.send({ type: "START_RECORDING" });
      await waitFor(actor, (snapshot) => snapshot.matches("recording"));
      actor.send({ type: "STOP_RECORDING" });
      vi.advanceTimersByTime(2000);
      await waitFor(actor, (snapshot) => snapshot.value === "idle");

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "No recording found to load" }),
      );
      expect(actor.getSnapshot().children.audioRecorder).toBeUndefined();
      expect(mic.disposals).toBe(1);
    } finally {
      actor.stop();
    }
  });

  // Moves a take into `loading` with the finalize watchdog having overtaken a recorder that
  // has not delivered its blob yet. A take without its blob loads within a few microtasks,
  // so the caller must send its event before awaiting anything.
  const finalizeThroughWatchdog = ({ actor }: ReturnType<typeof startTake>) => {
    vi.advanceTimersByTime(2000);
    expect(actor.getSnapshot().value).toBe("loading");
    expect(actor.getSnapshot().children.audioRecorder).toBeDefined();
  };

  it("stops a recorder the watchdog overtook when its take is discarded while loading", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const take = await recordAndStop({ enableCamera: false });
    finalizeThroughWatchdog(take);

    take.actor.send({ type: "UNLOAD" });

    expect(take.actor.getSnapshot().value).toBe("idle");
    expect(take.actor.getSnapshot().context.recording).toBeNull();
    expect(take.actor.getSnapshot().children.audioRecorder).toBeUndefined();
    expect(mic.disposals).toBe(1);
  });

  it("does not splice a take's late narration into a recording imported while it loads", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const take = await recordAndStop({ enableCamera: false });
    const imported: Recording = { ...createRecording(), id: "imported" };
    finalizeThroughWatchdog(take);

    take.actor.send({ type: "LOAD_RECORDING", recording: imported });
    await waitFor(take.actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    mic.emitStopped(new Blob(["late narration"], { type: "audio/webm" }));

    const recording = take.actor.getSnapshot().context.recording!;
    expect(recording.id).toBe("imported");
    expect(recording.audioBlob).toBeUndefined();
    expect(mic.disposals).toBe(1);
  });

  it("finalizes through the watchdog after the microphone fails while stopping", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const take = await recordAndStop();

    mic.emitError("microphone failed");
    expect(take.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "microphone failed" }),
    );
    // The failed recorder never cleared `audio.isRecording`, so the camera cannot finalize.
    camera.emitStopped(cameraBlob);
    expect(take.actor.getSnapshot().value).toBe("stoppingRecording");
    expect(take.onRecordingStop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(take.actor.getSnapshot().value).toBe("loading");

    const recording = await expectFinalizedOnce(take);
    expect(recording.audioBlob).toBeUndefined();
    expect(recording.cameraBlob).toBe(cameraBlob);
    expect(take.actor.getSnapshot().children.cameraRecorder).toBeUndefined();

    // Like any recorder the watchdog overtook, it may still flush a blob, so it stays
    // until its take is left.
    expect(take.actor.getSnapshot().children.audioRecorder).toBeDefined();
    take.actor.send({ type: "UNLOAD" });
    expect(take.actor.getSnapshot().children.audioRecorder).toBeUndefined();
    expect(mic.disposals).toBe(1);
  });

  // A microphone that fails mid-take still counts as recording, so the take waits for the
  // file it may still send instead of finalizing as it enters stoppingRecording.
  it("drains a take whose microphone fails mid-take", async () => {
    const take = startTake();
    actors.push(take);
    take.actor.send({ type: "START_RECORDING", enableCamera: false });
    await waitFor(take.actor, (snapshot) => snapshot.matches("recording"));

    mic.emitError("microphone failed");
    expect(take.actor.getSnapshot().value).toBe("stoppingRecording");
    expect(mic.stopRequests).toBe(1);
    expect(take.onRecordingStop).not.toHaveBeenCalled();

    mic.emitStopped(micBlob);
    expect(take.actor.getSnapshot().value).toBe("loading");

    const recording = await expectFinalizedOnce(take);
    expect(recording.audioBlob).toBe(micBlob);
    expect(take.actor.getSnapshot().children.audioRecorder).toBeUndefined();
  });
});
