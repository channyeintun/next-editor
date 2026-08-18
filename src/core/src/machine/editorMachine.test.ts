import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, fromCallback, waitFor } from "xstate";
import type * as monaco from "monaco-editor";
import { editorMachine } from "./editorMachine";
import {
  audioPlaybackActor,
  type AudioPlaybackEmit,
  type AudioPlaybackEvent,
  type AudioPlaybackInput,
} from "./audioActor";
import type {
  CameraRecordingEmit,
  CameraRecordingEvent,
  CameraRecordingInput,
} from "./cameraActor";
import { getPlaybackAudioState } from "./editorMachineHelpers";
import type { Recording, RecordingStreamDelta } from "../types";
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

    loadedSpy.mockRestore();
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
    expect(disposeCamera).toHaveBeenCalledTimes(1);
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
});

describe("audioPlaybackActor", () => {
  // Mock HTMLAudioElement — jsdom provides a stub but play()/pause() are not
  // fully functional. We replace it with a minimal manual mock that tracks
  // calls and lets tests trigger events imperatively.
  class MockAudio {
    static instances: MockAudio[] = [];
    src = "";
    volume = 1;
    playbackRate = 1;
    preservesPitch = true;
    crossOrigin: string | null = null;
    currentTime = 0;
    paused = true;
    oncanplay: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    playCalls = 0;
    pauseCalls = 0;

    constructor() {
      MockAudio.instances.push(this);
    }

    play() {
      this.playCalls++;
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
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: MockAudio });
    URL.createObjectURL = () => "blob:mock";
    URL.revokeObjectURL = () => {};
  });

  afterEach(() => {
    for (const actor of spawnedActors) {
      actor.stop();
    }
    spawnedActors = [];
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
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null } },
    }).start();
    spawnedActors.push(actor);

    actor.send({
      type: "START_RECORDING",
      audioBlob: new Blob(["audio"], { type: "audio/webm" }),
    });
    await waitFor(actor, (snapshot) => snapshot.value === "recording");
    MockAudio.instances[0]!.onended?.();
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(actor.getSnapshot().context.recording).not.toBeNull();
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
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private stopPending = false;

  constructor(_stream: unknown, options?: { mimeType?: string }) {
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
