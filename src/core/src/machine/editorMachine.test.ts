import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { assign, createActor, fromCallback, setup, waitFor } from "xstate";
import type * as monaco from "monaco-editor";
import { editorMachine } from "./editorMachine";
import {
  audioPlaybackActor,
  type AudioPlaybackEmit,
  type AudioPlaybackEvent,
  type AudioPlaybackInput,
  type AudioRecordingEmit,
  type AudioRecordingEvent,
  type AudioRecordingInput,
} from "./audioActor";
import type {
  CameraRecordingEmit,
  CameraRecordingEvent,
  CameraRecordingInput,
} from "./cameraActor";
import { getPlaybackAudioState } from "./editorMachineHelpers";
import type { Recording, RecordingStreamDelta } from "../types";
import type { PreviewEvent } from "../slides";
import { ContentEditBaseMismatchError, createContentEditDelta } from "../utils/frameDelta";
import type { WorkspaceRecordingSnapshot } from "../../../types/workspace";

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

function createRecording(audioBlob?: Blob): Recording {
  return {
    version: 4,
    id: "recording-1",
    name: "Recording 1",
    createdAt: 1,
    duration: 1000,
    keyframeInterval: 120,
    audioBlob,
    frames: [
      {
        timestamp: 0,
        isKeyframe: true,
        state: {
          content: "hello",
          selection,
          position: { lineNumber: 1, column: 1 },
          viewState: null,
          mouseCursor: { x: 0, y: 0, visible: false },
        },
      },
    ],
  };
}

function createWorkspaceSnapshot(
  content: string,
  sidebarScrollTop = 0,
): WorkspaceRecordingSnapshot {
  return {
    activeFilePath: "index.html",
    collapsedFolders: [],
    sidebarScrollTop,
    project: {
      id: "project-1",
      name: "Project",
      lessonType: "html-css",
      entryFilePath: "index.html",
      folders: [],
      files: {
        "index.html": {
          path: "index.html",
          name: "index.html",
          language: "html",
          content,
        },
      },
    },
  };
}

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

  setValue(content: string) {
    this.content = content;
  }

  getPositionAt(offset: number) {
    return { lineNumber: 1, column: offset + 1 };
  }

  pushEditOperations(
    _selections: unknown[],
    edits: monaco.editor.IIdentifiedSingleEditOperation[],
  ) {
    const edit = edits[0];

    if (!edit) {
      return null;
    }

    const startOffset = edit.range.startColumn - 1;
    const endOffset = edit.range.endColumn - 1;
    this.content =
      this.content.slice(0, startOffset) + (edit.text ?? "") + this.content.slice(endOffset);
    return null;
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

  restoreViewState() {
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

  // Each useUrlLoader instance guards staleness only against its own fetches. A lesson opened
  // through the header import or drag-and-drop leaves the previous lesson's audio download
  // and stream running, and their late extends used to swap that lesson back in.
  it("ignores stream growth and late media from a lesson that is no longer open", async () => {
    const audioPlayerEvents: AudioPlaybackEvent["type"][] = [];
    const machine = editorMachine.provide({
      actors: {
        audioPlayback: fromCallback<AudioPlaybackEvent, AudioPlaybackInput, AudioPlaybackEmit>(
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

  // Building a content delta calls getDmpCodec(), which throws when the WASM has
  // not loaded — inside an xstate `assign` on the capture hot path. xstate treats
  // that as fatal: the actor stops mid-recording, later sends are no-ops, and the
  // whole session is lost with only a console message. Refusing to start is the
  // honest outcome, since the take would not be encodable at save time either.
  it("refuses to start recording when the dmp codec is unavailable", async () => {
    const dmpCodec = await import("../../../storage/dmpCodec/dmpCodec");
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
    const dmpCodec = await import("../../../storage/dmpCodec/dmpCodec");
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
    await waitFor(actor, (snapshot) => snapshot.value === "recording");
    actor.send({ type: "STOP_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.value === "idle");

    expect(actor.getSnapshot().status).toBe("active");
    expect(actor.getSnapshot().context.error).toBe("No recording found to load");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No recording found to load" }),
    );

    actor.send({ type: "START_RECORDING" });
    expect(actor.getSnapshot().value).toBe("recording");
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
    await waitFor(actor, (snapshot) => snapshot.value === "recording");

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
        audioPlayback: fromCallback<AudioPlaybackEvent, AudioPlaybackInput, AudioPlaybackEmit>(
          ({ sendBack }) => {
            failAudio = () =>
              sendBack({ type: "AUDIO_PLAYBACK_ERROR", error: "selected audio failed" });
          },
        ),
        cameraRecording: fromCallback<
          CameraRecordingEvent,
          CameraRecordingInput,
          CameraRecordingEmit
        >(({ receive, sendBack }) => {
          receive((event) => {
            if (event.type === "START") {
              sendBack({
                type: "CAMERA_STARTED",
                mimeType: "video/webm",
                startedAtMs: Date.now(),
                startedAtPerf: performance.now(),
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
    await waitFor(actor, (snapshot) => snapshot.value === "recording");
    expect(actor.getSnapshot().children.cameraRecorder).toBeDefined();

    failAudio();

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("idle");
    expect(snapshot.children.cameraRecorder).toBeUndefined();
    expect(snapshot.context.camera).toEqual({
      blob: null,
      isRecording: false,
      mimeType: "",
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
    expect(actor.getSnapshot().value).toBe("recording");
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
    await waitFor(actor, (snapshot) => snapshot.value === "recording");

    const initialWorkspaceEvent = actor.getSnapshot().context.session?.workspaceEvents[0];

    expect(initialWorkspaceEvent?.snapshot.sidebarWidthDelta).toBe(0);

    currentWorkspace = createWorkspaceSnapshot("same", 0);
    actor.send({ type: "WORKSPACE_EVENT", sidebarWidthDelta: 40 });

    currentWorkspace = createWorkspaceSnapshot("same", 0);
    actor.send({ type: "WORKSPACE_EVENT", sidebarWidthDelta: -15 });

    const workspaceEvents = actor.getSnapshot().context.session?.workspaceEvents ?? [];

    expect(workspaceEvents.map((event) => event.snapshot.sidebarWidthDelta)).toEqual([0, 40, -15]);

    actor.stop();
  });

  it("captures whiteboard events during recording and finalizes them onto the recording", async () => {
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null } },
    }).start();

    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.value === "recording");

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
    actor.send({ type: "TICK", timestamp: 50, currentTime: 50 });
    actor.send({ type: "TICK", timestamp: 80, currentTime: 80 });
    expect(takeApplied()).toEqual({ deckOpen: [], transcriptLengths: [] });

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
      actor.send({ type: "TICK", timestamp: 5000, currentTime: 5000 });
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
      actor.send({ type: "TICK", timestamp: time, currentTime: time });
    }

    expect(workspaceApplies).toBe(9);
    expect(slideIds).toEqual(slideEvents.map((event) => event.slideId));

    actor.stop();
  });

  it("replays from the end by applying each track once", async () => {
    const applied: string[] = [];
    const playbackUpdates: number[] = [];

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
        onPlaybackUpdate: (currentTime) => {
          playbackUpdates.push(currentTime);
        },
      },
    }).start();

    actor.send({ type: "LOAD_RECORDING", recording });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    actor.send({ type: "PLAY" });
    actor.send({ type: "FINISHED" });
    expect(actor.getSnapshot().matches({ playback: "ended" })).toBe(true);
    applied.length = 0;
    playbackUpdates.length = 0;

    actor.send({ type: "PLAY" });

    expect(actor.getSnapshot().matches({ playback: "playing" })).toBe(true);
    expect(actor.getSnapshot().context.timeline.currentTime).toBe(0);
    expect(applied).toEqual(["runtime", "whiteboard", "chat"]);
    expect(playbackUpdates).toEqual([0]);

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

    actor.send({ type: "TICK", timestamp: 150, currentTime: 150 });

    expect(currentWorkspace.project.files["index.html"].content).toBe("after");
    expect(editor.getValue()).toBe("after");

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
      actor.send({ type: "TICK", timestamp: 50, currentTime: 50 });
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

// Finalize measures a take on performance.now(). Pinning it lets a test assert a take's
// length exactly; vi.restoreAllMocks() in afterEach releases it.
function pinPerformanceClock() {
  const clock = { now: 1_000 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  return clock;
}

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

describe("audioPlaybackActor", () => {
  // Mock HTMLAudioElement — jsdom provides a stub but play()/pause() are not
  // fully functional. We replace it with a minimal manual mock that tracks
  // calls and lets tests trigger events imperatively.
  class MockAudio {
    static instances: MockAudio[] = [];
    /** When set, `play()` rejects with it and the element stays paused, like a blocked play. */
    static playRejection: unknown = null;
    src = "";
    volume = 1;
    playbackRate = 1;
    // Starts false, unlike a real element, so the spawn test sees the actor set it.
    preservesPitch = false;
    crossOrigin: string | null = null;
    currentTime = 0;
    /** Seconds; NaN until metadata, Infinity for a MediaRecorder WebM whose end is not yet read. */
    duration = Number.NaN;
    paused = true;
    oncanplay: (() => void) | null = null;
    ondurationchange: (() => void) | null = null;
    onplaying: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    playCalls = 0;
    pauseCalls = 0;

    constructor() {
      MockAudio.instances.push(this);
    }

    get ended() {
      return Number.isFinite(this.duration) && this.currentTime >= this.duration;
    }

    play() {
      this.playCalls++;
      if (MockAudio.playRejection) return Promise.reject(MockAudio.playRejection);
      // Like a real element, play() on an ended one starts over from 0.
      if (this.ended) this.currentTime = 0;
      this.paused = false;
      return Promise.resolve();
    }

    pause() {
      this.pauseCalls++;
      this.paused = true;
    }

    removeAttribute(_name: string) {}
    load() {}
  }

  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  let spawnedActors: Array<ReturnType<typeof createActor>> = [];

  beforeEach(() => {
    MockAudio.instances = [];
    MockAudio.playRejection = null;
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: MockAudio });
    URL.createObjectURL = () => "blob:mock";
    URL.revokeObjectURL = () => {};
  });

  afterEach(() => {
    for (const actor of spawnedActors) {
      actor.stop();
    }
    spawnedActors = [];
    vi.restoreAllMocks();
    if (originalAudio) {
      Object.defineProperty(globalThis, "Audio", originalAudio);
    } else {
      delete (globalThis as Record<string, unknown>).Audio;
    }
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  const createPlayback = (playbackRate: number, startPositionMs = 0) => {
    const actor = createActor(audioPlaybackActor, {
      input: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        audioUrl: "https://cdn.example.com/audio.weba",
        volume: 0.5,
        playbackRate,
        startPositionMs,
      },
    }).start();
    spawnedActors.push(actor);
    return actor;
  };

  // The actor reports through sendBack, so it needs a parent to report to.
  const observePlayback = () => {
    const reported: AudioPlaybackEmit[] = [];
    const parent = createActor(
      setup({
        types: { events: {} as AudioPlaybackEmit },
        actors: { player: audioPlaybackActor },
      }).createMachine({
        invoke: {
          id: "player",
          src: "player",
          input: {
            blob: new Blob(["audio"], { type: "audio/webm" }),
            volume: 1,
            playbackRate: 1,
            startPositionMs: 0,
          },
        },
        on: {
          AUDIO_PLAYBACK_READY: { actions: ({ event }) => reported.push(event) },
          AUDIO_PLAYBACK_ERROR: { actions: ({ event }) => reported.push(event) },
        },
      }),
    ).start();
    spawnedActors.push(parent);
    return { player: parent.getSnapshot().children.player!, reported };
  };

  // A rejected play() settles in a microtask; let every pending one run.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("creates an HTMLAudioElement with preservesPitch=true on spawn", () => {
    createPlayback(1);
    const audio = MockAudio.instances[0];
    expect(audio).toBeDefined();
    expect(audio?.preservesPitch).toBe(true);
    expect(audio?.src).toBe("https://cdn.example.com/audio.weba");
    expect(audio?.volume).toBe(0.5);
    expect(audio?.playbackRate).toBe(1);
  });

  it("plays and pauses via PLAY/PAUSE events", async () => {
    const actor = createPlayback(1);
    const audio = MockAudio.instances[0]!;

    actor.send({ type: "PLAY" });
    expect(audio.playCalls).toBe(1);
    expect(audio.paused).toBe(false);

    actor.send({ type: "PAUSE" });
    expect(audio.pauseCalls).toBe(1);
    expect(audio.paused).toBe(true);
  });

  it("seeks by setting currentTime on SEEK", () => {
    const actor = createPlayback(1, 0);
    const audio = MockAudio.instances[0]!;

    // 12_500ms with no startOffset → currentTime = 12.5s
    actor.send({ type: "SEEK", timeMs: 12_500 });
    expect(audio.currentTime).toBe(12.5);
  });

  it("ignores sub-threshold drift on SYNC and re-seeks on over-threshold drift", () => {
    const actor = createPlayback(1, 0);
    const audio = MockAudio.instances[0]!;

    actor.send({ type: "SEEK", timeMs: 12_500 });
    const timeAfterSeek = audio.currentTime;

    // 200ms drift is below AUDIO_SYNC_DRIFT_THRESHOLD_MS (500ms) → no change.
    actor.send({ type: "SYNC", timeMs: 12_700 });
    expect(audio.currentTime).toBe(timeAfterSeek);

    // 600ms drift exceeds threshold → seek applied.
    actor.send({ type: "SYNC", timeMs: 13_100 });
    expect(audio.currentTime).toBe(13.1);
  });

  // play() starts some time after the timeline does. Re-anchoring to where the timeline
  // was when the PLAY or SYNC arrived would leave that startup lag in place for good.
  it("re-anchors to the extrapolated timeline once sound starts flowing", () => {
    const clock = pinPerformanceClock();
    const actor = createPlayback(2);
    const audio = MockAudio.instances[0]!;
    actor.send({ type: "PLAY" });
    actor.send({ type: "SYNC", timeMs: 0 });

    clock.now += 1000;
    audio.onplaying?.();

    // One second of wall time at 2x.
    expect(audio.currentTime).toBe(2);
  });

  it("updates volume and playback rate", () => {
    const actor = createPlayback(1);
    const audio = MockAudio.instances[0]!;

    actor.send({ type: "SET_VOLUME", volume: 0.3 });
    expect(audio.volume).toBe(0.3);

    actor.send({ type: "SET_PLAYBACK_RATE", rate: 2 });
    expect(audio.playbackRate).toBe(2);
  });

  it("uses audioUrl directly when provided, ignoring blob", () => {
    const actor = createActor(audioPlaybackActor, {
      input: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        audioUrl: "https://cdn.example.com/lesson.weba",
        volume: 1,
        playbackRate: 1,
        startPositionMs: 0,
      },
    }).start();
    spawnedActors.push(actor);

    const audio = MockAudio.instances[0]!;
    expect(audio.src).toBe("https://cdn.example.com/lesson.weba");
  });

  it("falls back to a blob URL when no audioUrl is provided", () => {
    const actor = createActor(audioPlaybackActor, {
      input: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        volume: 1,
        playbackRate: 1,
        startPositionMs: 0,
      },
    }).start();
    spawnedActors.push(actor);

    const audio = MockAudio.instances[0]!;
    // URL.createObjectURL is mocked to return "blob:mock" in beforeEach
    expect(audio.src).toBe("blob:mock");
  });

  // The audioUrl comes out of the .ne header without runtime validation.
  it("falls back to the blob URL when the audioUrl has a rejected scheme", () => {
    const actor = createActor(audioPlaybackActor, {
      input: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        audioUrl: "javascript:alert(1)",
        volume: 1,
        playbackRate: 1,
        startPositionMs: 0,
      },
    }).start();
    spawnedActors.push(actor);

    expect(MockAudio.instances[0]!.src).toBe("blob:mock");
  });

  // The audio can end a moment before the timeline does, and a resume then restarted it
  // from 0: a blip of the lesson's opening on every SYNC until the timeline finished.
  it("does not restart narration that ended just before the timeline", () => {
    const actor = createPlayback(1, 59_000);
    const audio = MockAudio.instances[0]!;
    audio.duration = 60;
    actor.send({ type: "PLAY" });
    expect(audio.playCalls).toBe(1);

    audio.currentTime = 60;
    audio.paused = true;
    actor.send({ type: "SYNC", timeMs: 59_800 });
    expect(audio.playCalls).toBe(1);
    expect(audio.currentTime).toBe(60);

    // Seeking back clears `ended`, so the next SYNC resumes there.
    actor.send({ type: "SEEK", timeMs: 10_000 });
    actor.send({ type: "SYNC", timeMs: 10_000 });
    expect(audio.playCalls).toBe(2);
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBeCloseTo(10, 1);
  });

  it("does not restart narration that has ended when PLAY lands on its end", () => {
    const actor = createPlayback(1);
    const audio = MockAudio.instances[0]!;
    audio.duration = 60;
    actor.send({ type: "SEEK", timeMs: 60_000 });

    actor.send({ type: "PLAY" });

    expect(audio.playCalls).toBe(0);
    expect(audio.currentTime).toBe(60);
  });

  it("emits its namespaced completion event when the audio element ends", () => {
    const actor = createPlayback(1);
    const audio = MockAudio.instances[0]!;

    actor.send({ type: "PLAY" });

    // The actor wires onended to send AUDIO_PLAYBACK_FINISHED back to the parent. Trigger it
    // and confirm the element actually had a handler registered.
    expect(audio.onended).toBeTypeOf("function");
    audio.onended!();

    // After onended fires the actor should still be alive (it's fromCallback —
    // only the parent machine acts on AUDIO_PLAYBACK_FINISHED). Just confirm no throw occurred.
    expect(actor.getSnapshot().status).toBe("active");
  });

  it("reports the narration length once it is known, and again only when it changes", () => {
    const { reported } = observePlayback();
    const audio = MockAudio.instances[0]!;

    // MediaRecorder WebM does not know its length until the demuxer reaches the end.
    audio.duration = Number.POSITIVE_INFINITY;
    audio.oncanplay?.();
    expect(reported).toEqual([]);

    audio.duration = 12.5;
    audio.ondurationchange?.();
    expect(reported).toEqual([{ type: "AUDIO_PLAYBACK_READY", duration: 12_500 }]);

    // canplay fires again after every stall or seek.
    audio.oncanplay?.();
    expect(reported).toHaveLength(1);
  });

  it("reports an autoplay block once while SYNC keeps retrying play()", async () => {
    MockAudio.playRejection = new DOMException("play() not allowed", "NotAllowedError");
    const { player, reported } = observePlayback();

    player.send({ type: "PLAY" });
    player.send({ type: "SYNC", timeMs: 250 });
    await settle();
    player.send({ type: "SYNC", timeMs: 500 });
    await settle();

    expect(MockAudio.instances[0]!.playCalls).toBe(3);
    expect(reported).toEqual([
      {
        type: "AUDIO_PLAYBACK_ERROR",
        error: "Audio playback was blocked by the browser's autoplay policy",
      },
    ]);
  });

  it("ignores a play() that a pause interrupts", async () => {
    MockAudio.playRejection = new DOMException("interrupted by pause()", "AbortError");
    const { player, reported } = observePlayback();

    player.send({ type: "PLAY" });
    player.send({ type: "SYNC", timeMs: 250 });
    await settle();

    expect(MockAudio.instances[0]!.playCalls).toBe(2);
    expect(reported).toEqual([]);
  });

  // Recording against a blocked narration used to run silently to the finalize timeout:
  // the element never plays, so it never ends.
  it("aborts a selected-file take whose narration the browser blocks", async () => {
    MockAudio.playRejection = new DOMException("play() not allowed", "NotAllowedError");
    const onError = vi.fn<(error: Error) => void>();
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null }, onError },
    }).start();
    spawnedActors.push(actor);

    actor.send({
      type: "START_RECORDING",
      audioBlob: new Blob(["audio"], { type: "audio/webm" }),
    });
    expect(actor.getSnapshot().value).toBe("recording");
    await settle();

    const aborted = actor.getSnapshot();
    expect(aborted.value).toBe("idle");
    expect(aborted.context.error).toMatch(/autoplay policy/);
    expect(aborted.context.session).toBeNull();
    expect(aborted.children.recordingAudioPlayer).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);

    // Started again from a click, the take records and no longer reports the block.
    MockAudio.playRejection = null;
    actor.send({
      type: "START_RECORDING",
      audioBlob: new Blob(["audio"], { type: "audio/webm" }),
    });
    await settle();

    expect(actor.getSnapshot().value).toBe("recording");
    expect(actor.getSnapshot().context.error).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not let an early audio end finish timeline-controlled lesson playback", async () => {
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null } },
    }).start();
    spawnedActors.push(actor);
    const audioBlob = new Blob(["audio"], { type: "audio/webm" });

    actor.send({
      type: "LOAD_RECORDING",
      recording: { ...createRecording(audioBlob), audioSource: "external" },
    });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    actor.send({ type: "PLAY" });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "playing" }));

    MockAudio.instances[0]!.onended?.();

    expect(actor.getSnapshot().matches({ playback: "playing" })).toBe(true);
    expect(actor.getSnapshot().context.timeline.currentTime).toBeLessThan(1000);
  });

  it("uses audio completion to finalize selected-file recording", async () => {
    const clock = pinPerformanceClock();
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null } },
    }).start();
    spawnedActors.push(actor);

    actor.send({
      type: "START_RECORDING",
      audioBlob: new Blob(["audio"], { type: "audio/webm" }),
    });
    await waitFor(actor, (snapshot) => snapshot.value === "recording");
    const audio = MockAudio.instances[0]!;
    audio.duration = 3.2;
    audio.oncanplay?.();

    // The studio reads this length to reject stale narration.
    const recordingContext = actor.getSnapshot().context;
    expect(recordingContext.audio.externalDurationMs).toBe(3200);
    expect(recordingContext.session!.audioFragments[0]!.endTimeMs).toBe(3200);

    // The element ends after its length plus the time play() took to start.
    clock.now += 3250;
    audio.onended?.();
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    const recording = actor.getSnapshot().context.recording!;
    expect(recording.duration).toBe(3200);
    expect(recording.mediaFragments).toEqual([
      expect.objectContaining({ trackId: "audio", startTimeMs: 0, endTimeMs: 3200 }),
    ]);
  });

  // Chrome reports Infinity for a MediaRecorder WebM, our own .weba narration included.
  // That went out as a 0ms length, and the take finalized at 1ms.
  it("measures a selected-file take by the wall clock while its length is unknown", async () => {
    const clock = pinPerformanceClock();
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null } },
    }).start();
    spawnedActors.push(actor);

    actor.send({
      type: "START_RECORDING",
      audioBlob: new Blob(["audio"], { type: "audio/webm" }),
    });
    await waitFor(actor, (snapshot) => snapshot.value === "recording");
    const audio = MockAudio.instances[0]!;
    const sessionRevision = actor.getSnapshot().context.sessionRevision;
    audio.duration = Number.POSITIVE_INFINITY;
    audio.oncanplay?.();
    audio.oncanplay?.();

    expect(actor.getSnapshot().context.audio.externalDurationMs).toBeNull();
    expect(actor.getSnapshot().context.sessionRevision).toBe(sessionRevision);

    clock.now += 300;
    audio.onended?.();
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(actor.getSnapshot().context.recording!.duration).toBe(300);
    expect(actor.getSnapshot().context.timeline.duration).toBe(300);
  });

  // finalizeRecording used to keep the audio slice's blob. It stayed pinned after UNLOAD,
  // and the next take recorded without audio finalized with it as its narration.
  it("does not carry a finalized take's narration into the next silent take", async () => {
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null } },
    }).start();
    spawnedActors.push(actor);
    const narration = new Blob(["audio"], { type: "audio/webm" });

    actor.send({ type: "START_RECORDING", audioBlob: narration });
    await waitFor(actor, (snapshot) => snapshot.value === "recording");
    actor.send({ type: "STOP_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    expect(actor.getSnapshot().context.recording!.audioBlob).toBe(narration);

    actor.send({ type: "UNLOAD" });
    expect(actor.getSnapshot().context.audio.blob).toBeNull();

    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.value === "recording");
    actor.send({ type: "STOP_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    const silentTake = actor.getSnapshot().context.recording!;
    expect(silentTake.audioBlob).toBeUndefined();
    expect(silentTake.tracks?.some((track) => track.kind === "audio")).toBe(false);
  });

  it("normalizes playback controls before storing, forwarding, and notifying", async () => {
    const onSeek = vi.fn<(time: number) => void>();
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null }, onSeek },
    }).start();
    spawnedActors.push(actor);
    const audioBlob = new Blob(["audio"], { type: "audio/webm" });

    actor.send({
      type: "LOAD_RECORDING",
      recording: { ...createRecording(audioBlob), audioSource: "external" },
    });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    const audio = MockAudio.instances[0]!;

    actor.send({ type: "SET_VOLUME", volume: 4 });
    actor.send({ type: "SET_SPEED", speed: -2 });
    actor.send({ type: "SEEK", time: 400 });
    onSeek.mockClear();
    actor.send({ type: "SEEK", time: Number.NaN });

    expect(actor.getSnapshot().context.timeline.volume).toBe(1);
    expect(actor.getSnapshot().context.timeline.speed).toBe(0.5);
    expect(actor.getSnapshot().context.timeline.currentTime).toBe(400);
    expect(audio.volume).toBe(1);
    expect(audio.playbackRate).toBe(0.5);
    expect(onSeek).toHaveBeenCalledWith(400);
  });
});

describe("getPlaybackAudioState", () => {
  const audioBlob = new Blob(["audio"], { type: "audio/webm" });

  function makeRecording(overrides: Partial<Recording> = {}): Recording {
    return {
      version: 4,
      id: "rec-1",
      name: "Test",
      createdAt: 0,
      duration: 5000,
      keyframeInterval: 120,
      frames: [],
      audioBlob,
      ...overrides,
    };
  }

  it("returns null when recording is null", () => {
    expect(getPlaybackAudioState(null)).toBeNull();
  });

  it("returns null when audioBlob is missing", () => {
    expect(getPlaybackAudioState(makeRecording({ audioBlob: undefined }))).toBeNull();
  });

  it("returns null when audioBlob is empty", () => {
    expect(getPlaybackAudioState(makeRecording({ audioBlob: new Blob([]) }))).toBeNull();
  });

  it("returns state with blob when only audioBlob is present (no audioUrl)", () => {
    const state = getPlaybackAudioState(makeRecording({ audioUrl: undefined }));
    // Must not return null — newly recorded audio has a blob but no URL yet
    expect(state).not.toBeNull();
    expect(state!.blob).toBe(audioBlob);
    expect(state!.audioUrl).toBeUndefined();
  });

  it("returns state with both blob and audioUrl when recording is fully uploaded", () => {
    const state = getPlaybackAudioState(
      makeRecording({ audioUrl: "https://cdn.example.com/audio.weba" }),
    );
    expect(state).not.toBeNull();
    expect(state!.blob).toBe(audioBlob);
    expect(state!.audioUrl).toBe("https://cdn.example.com/audio.weba");
  });

  it("includes startOffsetMs from recording", () => {
    const state = getPlaybackAudioState(makeRecording({ audioStartOffsetMs: 500 }));
    expect(state!.startOffsetMs).toBe(500);
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
      audioRecording: fromCallback<AudioRecordingEvent, AudioRecordingInput, AudioRecordingEmit>(
        ({ receive, sendBack }) => {
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
        },
      ),
      cameraRecording: fromCallback<
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
            startedAtMs: Date.now(),
            startedAtPerf: performance.now(),
          });
        });
        return () => {
          camera.disposals += 1;
        };
      }),
      // Selected-file audio, and playback of a take that has it, spawn an HTMLAudioElement.
      audioPlayback: fromCallback<AudioPlaybackEvent, AudioPlaybackInput, AudioPlaybackEmit>(
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
    await waitFor(take.actor, (snapshot) => snapshot.value === "recording");
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
          audioPlayback: fromCallback<AudioPlaybackEvent, AudioPlaybackInput, AudioPlaybackEmit>(
            ({ receive, sendBack }) => {
              endNarration = () => sendBack({ type: "AUDIO_PLAYBACK_FINISHED" });
              receive((event) => {
                if (event.type === "PLAY") {
                  sendBack({ type: "AUDIO_PLAYBACK_READY", duration: 5000 });
                }
              });
            },
          ),
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
    await waitFor(take.actor, (snapshot) => snapshot.value === "recording");

    expect(take.actor.getSnapshot().context.enableCameraRecording).toBe(false);
    expect(take.actor.getSnapshot().children.cameraRecorder).toBeUndefined();
  });

  it("starts the camera from the configured default when a start makes no choice", async () => {
    const take = startTake({ enableCameraRecording: true });
    actors.push(take);

    take.actor.send({ type: "START_RECORDING" });
    await waitFor(take.actor, (snapshot) => snapshot.value === "recording");

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
      await waitFor(actor, (snapshot) => snapshot.value === "recording");
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
});

// ===========================================================================
// Local screen recording (opt-in, saved locally only)
// ===========================================================================

class FakeScreenTrack {
  kind: "video" | "audio";
  stopped = false;
  private listeners: Record<string, Array<() => void>> = {};

  constructor(kind: "video" | "audio") {
    this.kind = kind;
  }

  stop() {
    this.stopped = true;
  }

  clone() {
    return new FakeScreenTrack(this.kind);
  }

  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }

  removeEventListener(type: string, cb: () => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb);
  }

  dispatch(type: string) {
    (this.listeners[type] ?? []).forEach((cb) => cb());
  }
}

class FakeScreenStream {
  private tracks: FakeScreenTrack[];

  constructor(tracks: FakeScreenTrack[] = []) {
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }

  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }

  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}

class FakeScreenMediaRecorder {
  static supported = true;
  static deferStops = false;
  static instances: FakeScreenMediaRecorder[] = [];

  static isTypeSupported() {
    return FakeScreenMediaRecorder.supported;
  }

  state: "inactive" | "recording" = "inactive";
  stream: FakeScreenStream;
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private stopPending = false;

  constructor(stream: FakeScreenStream, options?: { mimeType?: string }) {
    this.stream = stream;
    this.mimeType = options?.mimeType ?? "";
    FakeScreenMediaRecorder.instances.push(this);
  }

  start(_timeslice?: number) {
    this.state = "recording";
    this.onstart?.();
  }

  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    if (FakeScreenMediaRecorder.deferStops) {
      this.stopPending = true;
      return;
    }
    this.finishStop();
  }

  finishStop() {
    if (!this.stopPending && this.state !== "inactive") return;
    this.stopPending = false;
    this.ondataavailable?.({ data: new Blob(["v"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

// Mixes the microphone into the screen recording; jsdom has no Web Audio.
class FakeScreenAudioContext {
  state: "running" | "closed" = "running";

  createMediaStreamDestination() {
    return { stream: new FakeScreenStream([new FakeScreenTrack("audio")]) };
  }

  createMediaStreamSource(_stream: unknown) {
    return { connect() {} };
  }

  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

describe("editorMachine local screen recording", () => {
  const originalMediaStream = Object.getOwnPropertyDescriptor(globalThis, "MediaStream");
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  let actors: Array<ReturnType<typeof createActor>> = [];

  beforeEach(() => {
    FakeScreenMediaRecorder.instances = [];
    FakeScreenMediaRecorder.supported = true;
    FakeScreenMediaRecorder.deferStops = false;
    Object.defineProperty(globalThis, "MediaStream", {
      configurable: true,
      value: FakeScreenStream,
    });
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: FakeScreenMediaRecorder,
    });
    // Deterministic microphone-denied path for the arming-abort test.
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new Error("denied")) },
    });
  });

  afterEach(() => {
    for (const actor of actors) actor.stop();
    actors = [];
    vi.unstubAllGlobals();
    if (originalMediaStream) {
      Object.defineProperty(globalThis, "MediaStream", originalMediaStream);
    } else {
      delete (globalThis as Record<string, unknown>).MediaStream;
    }
    if (originalMediaRecorder) {
      Object.defineProperty(globalThis, "MediaRecorder", originalMediaRecorder);
    } else {
      delete (globalThis as Record<string, unknown>).MediaRecorder;
    }
    if (originalMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    } else {
      delete (navigator as unknown as Record<string, unknown>).mediaDevices;
    }
  });

  const makeDisplayStream = () =>
    new FakeScreenStream([new FakeScreenTrack("video")]) as unknown as MediaStream;

  const start = (
    overrides: Parameters<typeof createActor<typeof editorMachine>>[1] extends { input: infer I }
      ? Partial<I>
      : never = {},
  ) => {
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null }, ...overrides },
    }).start();
    actors.push(actor);
    return actor;
  };

  it("does not spawn a screen actor when no screenStream is provided", async () => {
    const actor = start();
    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (s) => s.value === "recording");

    expect(
      Object.keys(actor.getSnapshot().children).some((id) => id.startsWith("screenRecorder-")),
    ).toBe(false);
    expect(actor.getSnapshot().context.screen.isRecording).toBe(false);
  });

  it("spawns the screen actor and records the start offset on SCREEN_STARTED", async () => {
    const actor = start();
    actor.send({ type: "START_RECORDING", screenStream: makeDisplayStream() });
    await waitFor(actor, (s) => s.value === "recording");

    const screen = actor.getSnapshot().context.screen;
    expect(screen.actorId).toMatch(/^screenRecorder-/);
    expect(actor.getSnapshot().children[screen.actorId!]).toBeDefined();
    expect(screen.isRecording).toBe(true);
    expect(screen.mimeType).toBe("video/webm;codecs=vp9,opus");
    expect(screen.hasAudio).toBe(false);
    expect(screen.startOffsetMs).toBeGreaterThanOrEqual(0);
  });

  it("saves the screen blob after stop — even once the machine reaches playback — and clears context", async () => {
    const ready: Array<{
      blob: Blob;
      mimeType: string;
      hasAudio: boolean;
      startOffsetMs: number;
    }> = [];
    const actor = start({ onScreenRecordingReady: (payload) => ready.push(payload) });

    actor.send({ type: "START_RECORDING", screenStream: makeDisplayStream() });
    await waitFor(actor, (s) => s.value === "recording");
    const screenActorId = actor.getSnapshot().context.screen.actorId!;

    actor.send({ type: "STOP_RECORDING" });
    await waitFor(actor, (s) => s.matches({ playback: "ready" }));
    // The blob is patched (WebM duration) asynchronously in the actor's onstop, so SCREEN_STOPPED
    // lands after the machine already reached playback — exactly the root-handler-any-state case.
    await waitFor(actor, (s) => s.context.screen.isRecording === false);

    expect(ready).toHaveLength(1);
    expect(ready[0]?.blob).toBeInstanceOf(Blob);
    expect(ready[0]?.mimeType).toBe("video/webm;codecs=vp9,opus");
    expect(ready[0]?.hasAudio).toBe(false);
    expect(actor.getSnapshot().context.screenStream).toBeNull();
    expect(actor.getSnapshot().children[screenActorId]).toBeUndefined();
  });

  it("delivers a partial blob when the share ends early and keeps the session recording", async () => {
    const ready: Blob[] = [];
    const display = new FakeScreenStream([new FakeScreenTrack("video")]);
    const videoTrack = display.getVideoTracks()[0] as unknown as FakeScreenTrack;
    const actor = start({ onScreenRecordingReady: (payload) => ready.push(payload.blob) });

    actor.send({ type: "START_RECORDING", screenStream: display as unknown as MediaStream });
    await waitFor(actor, (s) => s.value === "recording");
    const screenActorId = actor.getSnapshot().context.screen.actorId!;

    // User clicks the browser's native "Stop sharing".
    videoTrack.dispatch("ended");
    await waitFor(actor, (s) => s.context.screen.isRecording === false);

    expect(ready).toHaveLength(1);
    expect(actor.getSnapshot().value).toBe("recording"); // session unaffected
    expect(actor.getSnapshot().children[screenActorId]).toBeUndefined();
  });

  // The screen recorder stops the mic track it is given when it tears down. Handed the
  // session's own track instead of a clone, ending the share would cut off the narration.
  it("gives the screen recorder a clone of the microphone track", async () => {
    vi.stubGlobal("AudioContext", FakeScreenAudioContext);
    const micTrack = new FakeScreenTrack("audio");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          Promise.resolve(new FakeScreenStream([micTrack]) as unknown as MediaStream),
      },
    });
    const display = new FakeScreenStream([new FakeScreenTrack("video")]);
    const videoTrack = display.getVideoTracks()[0] as unknown as FakeScreenTrack;
    const actor = start({ enableAudioRecording: true });

    actor.send({ type: "START_RECORDING", screenStream: display as unknown as MediaStream });
    await waitFor(actor, (s) => s.value === "recording");
    // The microphone is the only audio source, so this shows it reached the mix.
    expect(actor.getSnapshot().context.screen.hasAudio).toBe(true);

    // The user ends the share early; the screen recorder tears down and stops its tracks.
    videoTrack.dispatch("ended");
    await waitFor(actor, (s) => s.context.screen.isRecording === false);

    expect(micTrack.stopped).toBe(false);
    expect(actor.getSnapshot().value).toBe("recording");
    expect(actor.getSnapshot().children.audioRecorder).toBeDefined();
  });

  it("releases a pending display stream when microphone arming fails", async () => {
    const display = new FakeScreenStream([new FakeScreenTrack("video")]);
    const videoTrack = display.getVideoTracks()[0] as unknown as FakeScreenTrack;
    const actor = start({ enableAudioRecording: true });

    actor.send({ type: "START_RECORDING", screenStream: display as unknown as MediaStream });
    // getUserMedia rejects → AUDIO_RECORDING_ERROR → startingRecording returns to idle.
    await waitFor(actor, (s) => s.value === "idle");

    expect(videoTrack.stopped).toBe(true);
    expect(actor.getSnapshot().context.screenStream).toBeNull();
  });

  // The host acquires the display stream at click time and hands it over with START_RECORDING.
  // A start the machine does not take must stop it, or the browser keeps sharing the tab.
  it("releases the display stream of a start refused for an unloaded codec", async () => {
    const dmpCodec = await import("../../../storage/dmpCodec/dmpCodec");
    const loadedSpy = vi.spyOn(dmpCodec, "isDmpCodecLoaded").mockReturnValue(false);
    const display = new FakeScreenStream([new FakeScreenTrack("video")]);
    const videoTrack = display.getVideoTracks()[0] as unknown as FakeScreenTrack;
    const actor = start();

    try {
      actor.send({ type: "START_RECORDING", screenStream: display as unknown as MediaStream });
    } finally {
      loadedSpy.mockRestore();
    }

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("idle");
    expect(snapshot.context.error).toMatch(/recording codec could not be loaded/i);
    expect(snapshot.context.screenStream).toBeNull();
    expect(videoTrack.stopped).toBe(true);
  });

  it("releases the display stream of a second start while the microphone is arming", () => {
    const machine = editorMachine.provide({
      actors: {
        // Never reports STARTED, so the machine stays in `startingRecording`.
        audioRecording: fromCallback<AudioRecordingEvent, AudioRecordingInput, AudioRecordingEmit>(
          () => () => {},
        ),
      },
    });
    const actor = createActor(machine, {
      input: { editorRef: { current: null }, enableAudioRecording: true },
    }).start();
    actors.push(actor);
    const first = new FakeScreenStream([new FakeScreenTrack("video")]);
    const firstTrack = first.getVideoTracks()[0] as unknown as FakeScreenTrack;
    const second = new FakeScreenStream([new FakeScreenTrack("video")]);
    const secondTrack = second.getVideoTracks()[0] as unknown as FakeScreenTrack;

    actor.send({ type: "START_RECORDING", screenStream: first as unknown as MediaStream });
    expect(actor.getSnapshot().value).toBe("startingRecording");
    actor.send({ type: "START_RECORDING", screenStream: second as unknown as MediaStream });
    // Re-sending the stream the pending take already owns must leave it alone.
    actor.send({ type: "START_RECORDING", screenStream: first as unknown as MediaStream });

    expect(actor.getSnapshot().value).toBe("startingRecording");
    expect(secondTrack.stopped).toBe(true);
    expect(firstTrack.stopped).toBe(false);
    expect(actor.getSnapshot().context.screenStream).toBe(first);
  });

  it("releases the display stream of a start sent during playback", async () => {
    const actor = start();
    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (s) => s.value === "recording");
    actor.send({ type: "STOP_RECORDING" });
    await waitFor(actor, (s) => s.matches({ playback: "ready" }));
    const display = new FakeScreenStream([new FakeScreenTrack("video")]);
    const videoTrack = display.getVideoTracks()[0] as unknown as FakeScreenTrack;

    actor.send({ type: "START_RECORDING", screenStream: display as unknown as MediaStream });

    expect(actor.getSnapshot().matches({ playback: "ready" })).toBe(true);
    expect(actor.getSnapshot().context.screenStream).toBeNull();
    expect(videoTrack.stopped).toBe(true);
  });

  it("aborts cleanly when stopped while the microphone is still arming", async () => {
    let grantMicrophone!: (stream: MediaStream) => void;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          new Promise<MediaStream>((resolve) => {
            grantMicrophone = resolve;
          }),
      },
    });
    const onRecordingStart = vi.fn<() => void>();
    const onRecordingStop = vi.fn<(recording: Recording) => void>();
    const display = new FakeScreenStream([new FakeScreenTrack("video")]);
    const videoTrack = display.getVideoTracks()[0] as unknown as FakeScreenTrack;
    const actor = start({ enableAudioRecording: true, onRecordingStart, onRecordingStop });

    actor.send({ type: "START_RECORDING", screenStream: display as unknown as MediaStream });
    expect(actor.getSnapshot().value).toBe("startingRecording");
    const armingRecorder = actor.getSnapshot().children.audioRecorder;
    expect(armingRecorder).toBeDefined();

    actor.send({ type: "STOP_RECORDING" });

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("idle");
    expect(snapshot.children.audioRecorder).toBeUndefined();
    expect(armingRecorder!.getSnapshot().status).toBe("stopped");
    expect(videoTrack.stopped).toBe(true);
    expect(snapshot.context.screenStream).toBeNull();
    expect(snapshot.context.audio.isRecording).toBe(false);
    expect(snapshot.context.session).toBeNull();

    // The permission prompt resolves after the user gave up: the mic is released unused.
    const micTrack = new FakeScreenTrack("audio");
    grantMicrophone(new FakeScreenStream([micTrack]) as unknown as MediaStream);
    await vi.waitFor(() => expect(micTrack.stopped).toBe(true));

    expect(FakeScreenMediaRecorder.instances).toHaveLength(0);
    expect(onRecordingStart).not.toHaveBeenCalled();
    expect(onRecordingStop).not.toHaveBeenCalled();
  });

  it("treats a screen MIME failure as non-fatal and keeps the session recording", async () => {
    FakeScreenMediaRecorder.supported = false;
    const ready: Blob[] = [];
    const actor = start({ onScreenRecordingReady: (payload) => ready.push(payload.blob) });

    actor.send({ type: "START_RECORDING", screenStream: makeDisplayStream() });
    await waitFor(actor, (s) => s.value === "recording");
    await waitFor(actor, (s) => s.context.screen.isRecording === false);

    expect(ready).toHaveLength(0);
    expect(actor.getSnapshot().value).toBe("recording");
    expect(actor.getSnapshot().context.screenStream).toBeNull();
    expect(
      Object.keys(actor.getSnapshot().children).some((id) => id.startsWith("screenRecorder-")),
    ).toBe(false);
  });

  it("keeps a new screen actor alive when an older capture finishes late", async () => {
    FakeScreenMediaRecorder.deferStops = true;
    const ready: Blob[] = [];
    const actor = start({ onScreenRecordingReady: (payload) => ready.push(payload.blob) });

    actor.send({ type: "START_RECORDING", screenStream: makeDisplayStream() });
    await waitFor(actor, (s) => s.value === "recording");
    const firstActorId = actor.getSnapshot().context.screen.actorId!;
    const firstRecorder = FakeScreenMediaRecorder.instances[0]!;

    actor.send({ type: "STOP_RECORDING" });
    await waitFor(actor, (s) => s.matches({ playback: "ready" }));
    actor.send({ type: "UNLOAD" });
    await waitFor(actor, (s) => s.value === "idle");

    actor.send({ type: "START_RECORDING", screenStream: makeDisplayStream() });
    await waitFor(actor, (s) => s.value === "recording");
    const secondActorId = actor.getSnapshot().context.screen.actorId!;
    const secondRecorder = FakeScreenMediaRecorder.instances[1]!;
    expect(secondActorId).not.toBe(firstActorId);
    expect(actor.getSnapshot().children[firstActorId]).toBeDefined();
    expect(actor.getSnapshot().children[secondActorId]).toBeDefined();

    firstRecorder.finishStop();
    await waitFor(actor, (s) => s.children[firstActorId] === undefined);

    expect(ready).toHaveLength(1);
    expect(actor.getSnapshot().value).toBe("recording");
    expect(actor.getSnapshot().context.screen.actorId).toBe(secondActorId);
    expect(actor.getSnapshot().context.screen.isRecording).toBe(true);
    expect(actor.getSnapshot().children[secondActorId]).toBeDefined();
    expect(secondRecorder.state).toBe("recording");
  });

  it("guardrail: the finalized recording carries no screen fields", async () => {
    const stopped: { value: Recording | null } = { value: null };
    const actor = start({ onRecordingStop: (recording) => (stopped.value = recording) });

    actor.send({ type: "START_RECORDING", screenStream: makeDisplayStream() });
    await waitFor(actor, (s) => s.value === "recording");
    actor.send({ type: "STOP_RECORDING" });
    await waitFor(actor, (s) => s.matches({ playback: "ready" }));

    const recording = stopped.value;
    expect(recording).not.toBeNull();
    const screenKeys = Object.keys(recording ?? {}).filter((key) =>
      key.toLowerCase().startsWith("screen"),
    );
    expect(screenKeys).toEqual([]);
  });
});
