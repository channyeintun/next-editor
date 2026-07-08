import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createActor, waitFor } from "xstate";
import type * as monaco from "monaco-editor";
import { editorMachine } from "./editorMachine";
import { audioPlaybackActor } from "./audioActor";
import type { Recording } from "../types";
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

  it("uses audioUrl directly when provided instead of a blob URL", () => {
    const actor = createActor(audioPlaybackActor, {
      input: {
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

  it("emits FINISHED when the audio element ends", () => {
    const actor = createPlayback(1);
    const audio = MockAudio.instances[0]!;

    actor.send({ type: "PLAY" });

    // The actor wires onended to send FINISHED back to the parent. Trigger it
    // and confirm the element actually had a handler registered.
    expect(audio.onended).toBeTypeOf("function");
    audio.onended!();

    // After onended fires the actor should still be alive (it's fromCallback —
    // only the parent machine acts on FINISHED). Just confirm no throw occurred.
    expect(actor.getSnapshot().status).toBe("active");
  });
});
