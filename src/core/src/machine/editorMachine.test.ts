import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, waitFor } from "xstate";
import type * as monaco from "monaco-editor";
import { editorMachine } from "./editorMachine";
import { audioPlaybackActor } from "./audioActor";
import type { Recording } from "../types";
import type { WorkspaceRecordingSnapshot } from "../../../types/workspace";

// SoundTouch is loaded lazily by audioActor for pitch preservation. Replace it
// with a lightweight mock so the playback graph can be exercised under jsdom and
// the pitch-compensation wiring can be asserted without a real AudioWorklet.
const soundTouchMock = vi.hoisted(() => ({
  instances: [] as Array<{
    playbackRate: { value: number };
    pitch: { value: number };
    pitchSemitones: { value: number };
    disconnected: boolean;
  }>,
}));

vi.mock("@soundtouchjs/audio-worklet", () => {
  class MockSoundTouchNode {
    static async register() {}
    playbackRate = { value: 1 };
    pitch = { value: 1 };
    pitchSemitones = { value: 0 };
    disconnected = false;
    constructor() {
      soundTouchMock.instances.push(this);
    }
    connect() {}
    disconnect() {
      this.disconnected = true;
    }
  }
  return { SoundTouchNode: MockSoundTouchNode };
});

vi.mock("@soundtouchjs/audio-worklet/processor?url", () => ({
  default: "blob:soundtouch-processor",
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

function createRecording(audioBlob?: Blob): Recording {
  return {
    version: 3,
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

class MockAudio {
  static instances: MockAudio[] = [];

  currentTime = 0;
  volume = 1;
  playbackRate = 1;
  paused = true;
  src = "";
  duration = 60;
  oncanplaythrough: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(src: string) {
    this.src = src;
    MockAudio.instances.push(this);
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  load() {
    return undefined;
  }
}

describe("editorMachine external audio recording", () => {
  const originalAudio = globalThis.Audio;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;

  afterEach(() => {
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: originalAudio,
    });
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    MockAudio.instances = [];
  });

  it("plays an uploaded audio file while recording and stops when it ends", async () => {
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: MockAudio,
    });
    URL.createObjectURL = () => "blob:external-audio";
    URL.revokeObjectURL = () => undefined;

    const events: string[] = [];
    // Held in an object so the assignment inside the callback doesn't make
    // control-flow analysis narrow the variable to `never` at the read sites.
    const stoppedRecording: { value: Recording | null } = { value: null };
    const audioBlob = new Blob(["external audio"], { type: "audio/webm" });
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

    actor.send({ type: "START_RECORDING", audioBlob });
    await waitFor(actor, (snapshot) => snapshot.value === "recording");

    const audio = MockAudio.instances[0];
    expect(audio.paused).toBe(false);
    expect(actor.getSnapshot().context.audio.source).toBe("external");

    audio.oncanplaythrough?.();
    audio.onended?.();
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(events).toEqual(["recording:start", "recording:stop"]);
    expect(stoppedRecording.value?.audioBlob).toBe(audioBlob);
    expect(stoppedRecording.value?.audioSource).toBe("external");
    expect(stoppedRecording.value?.duration).toBe(60_000);
    expect(actor.getSnapshot().children.recordingAudioPlayer).toBeUndefined();

    actor.stop();
  });
});

describe("audioPlaybackActor", () => {
  class MockBufferSource {
    buffer: unknown = null;
    playbackRate = { value: 1 };
    onended: (() => void) | null = null;
    startedOffset: number | null = null;
    connect() {}
    disconnect() {}
    start(_when: number, offset: number) {
      this.startedOffset = offset;
    }
    stop() {}
  }

  class MockAudioContext {
    static instances: MockAudioContext[] = [];
    currentTime = 0;
    state = "running";
    destination = {};
    audioWorklet = { addModule: async () => {} };
    bufferSources: MockBufferSource[] = [];
    // A long mono buffer so any requested seek offset stays in range.
    private decodeResult = { duration: 120, numberOfChannels: 1, length: 1_000 };

    constructor() {
      MockAudioContext.instances.push(this);
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
    createBufferSource() {
      const source = new MockBufferSource();
      this.bufferSources.push(source);
      return source;
    }
    decodeAudioData() {
      return Promise.resolve(this.decodeResult);
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }

  const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const originalAudioWorkletNode = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode");
  let patchedBlobArrayBuffer = false;

  const installMockAudio = () => {
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: MockAudioContext,
    });
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: class {},
    });
    // jsdom's Blob lacks arrayBuffer(); the actor decodes via it, so stub it.
    if (typeof Blob.prototype.arrayBuffer !== "function") {
      (Blob.prototype as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer = () =>
        Promise.resolve(new ArrayBuffer(8));
      patchedBlobArrayBuffer = true;
    }
  };

  // Let the decode + worklet-registration promise chains (including the dynamic
  // imports) settle before asserting on the resulting audio graph.
  const flush = async () => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const restore = (name: string, descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[name];
    }
  };

  afterEach(() => {
    restore("AudioContext", originalAudioContext);
    restore("AudioWorkletNode", originalAudioWorkletNode);
    if (patchedBlobArrayBuffer) {
      delete (Blob.prototype as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
      patchedBlobArrayBuffer = false;
    }
    MockAudioContext.instances = [];
    soundTouchMock.instances = [];
  });

  const createPlayback = (playbackRate: number, startPositionMs = 0) =>
    createActor(audioPlaybackActor, {
      input: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        volume: 0.5,
        playbackRate,
        startPositionMs,
      },
    }).start();

  it("preserves pitch at 2x by routing through a tempo-matched SoundTouch node", async () => {
    installMockAudio();
    const actor = createPlayback(2);
    await flush();

    actor.send({ type: "PLAY" });
    await flush();

    const ctx = MockAudioContext.instances[0];
    const source = ctx.bufferSources.at(-1);
    // The buffer source still carries the 2x tempo, so speed is preserved...
    expect(source?.playbackRate.value).toBe(2);
    // ...while a SoundTouch node set to the same tempo cancels the resulting
    // octave shift, keeping the voice's pitch natural.
    expect(soundTouchMock.instances).toHaveLength(1);
    expect(soundTouchMock.instances[0].playbackRate.value).toBe(2);
    expect(soundTouchMock.instances[0].pitch.value).toBe(1);
    expect(soundTouchMock.instances[0].pitchSemitones.value).toBe(0);

    actor.stop();
  });

  it("stays native at 1x with no pitch shifter inserted", async () => {
    installMockAudio();
    const actor = createPlayback(1);
    await flush();

    actor.send({ type: "PLAY" });
    await flush();

    const ctx = MockAudioContext.instances[0];
    expect(ctx.bufferSources.at(-1)?.playbackRate.value).toBe(1);
    expect(soundTouchMock.instances).toHaveLength(0);

    actor.stop();
  });

  it("seeks in milliseconds and ignores sub-threshold high-speed sync drift", async () => {
    installMockAudio();
    const actor = createPlayback(2);
    await flush();

    actor.send({ type: "PLAY" });
    await flush();
    const ctx = MockAudioContext.instances[0];

    actor.send({ type: "SEEK", timeMs: 12_500 });
    expect(ctx.bufferSources.at(-1)?.startedOffset).toBe(12.5);

    const sourceCount = ctx.bufferSources.length;
    // 200ms drift is below AUDIO_SYNC_DRIFT_THRESHOLD_MS → no restart.
    actor.send({ type: "SYNC", timeMs: 12_700 });
    expect(ctx.bufferSources.length).toBe(sourceCount);

    // 500ms drift reaches the threshold → restart from the synced position.
    actor.send({ type: "SYNC", timeMs: 13_000 });
    expect(ctx.bufferSources.length).toBe(sourceCount + 1);
    expect(ctx.bufferSources.at(-1)?.startedOffset).toBe(13);

    actor.stop();
  });
});
