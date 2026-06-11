import { afterEach, describe, expect, it } from "vite-plus/test";
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
  constructor(private content: string) {}

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

  constructor(private model: MockTextModel) {}

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
    let stoppedRecording: Recording | null = null;
    const actor = createActor(editorMachine, {
      input: {
        editorRef: { current: null },
        onRecordingStart: () => events.push("recording:start"),
        onRecordingStop: (recording) => {
          events.push("recording:stop");
          stoppedRecording = recording;
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
    expect(stoppedRecording?.frames.length).toBeGreaterThan(0);

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
  playCalls = 0;
  preservesPitch = true;
  mozPreservesPitch = true;
  webkitPreservesPitch = true;
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
    this.playCalls++;
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

class MockAudioNode {
  connectedTo: unknown = null;
  disconnected = false;

  connect(target: unknown) {
    this.connectedTo = target;
    return target;
  }

  disconnect() {
    this.disconnected = true;
  }
}

class MockMediaElementSourceNode extends MockAudioNode {
  constructor(readonly mediaElement: MockAudio) {
    super();
  }
}

class MockGainNode extends MockAudioNode {
  static instances: MockGainNode[] = [];
  gain = { value: 1 };

  constructor() {
    super();
    MockGainNode.instances.push(this);
  }
}

class MockAudioContext {
  audioWorklet = {
    addModule: async (url: string | URL) => {
      this.registeredModules.push(String(url));
    },
  };
  destination = new MockAudioNode();
  registeredModules: string[] = [];

  createMediaElementSource(audio: MockAudio) {
    return new MockMediaElementSourceNode(audio);
  }

  createGain() {
    return new MockGainNode();
  }

  resume() {
    return Promise.resolve();
  }
}

class DelayedMockAudioContext extends MockAudioContext {
  static instance: DelayedMockAudioContext | null = null;
  resolveModule: (() => void) | null = null;

  constructor() {
    super();
    DelayedMockAudioContext.instance = this;
    this.audioWorklet = {
      addModule: async (url: string | URL) => {
        this.registeredModules.push(String(url));
        await new Promise<void>((resolve) => {
          this.resolveModule = resolve;
        });
      },
    };
  }
}

class MockAudioWorkletNode extends EventTarget {
  static instances: MockAudioWorkletNode[] = [];
  connectedTo: unknown = null;
  disconnected = false;
  parameters = new Map<string, { value: number }>([
    ["pitch", { value: 0 }],
    ["pitchSemitones", { value: 0 }],
    ["playbackRate", { value: 0 }],
  ]);
  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (message: unknown) => {
      this.messages.push(message);
    },
  };
  messages: unknown[] = [];

  constructor(
    readonly context: MockAudioContext,
    readonly name: string,
    readonly options: unknown,
  ) {
    super();
    MockAudioWorkletNode.instances.push(this);
  }

  connect(target: unknown) {
    this.connectedTo = target;
    return target;
  }

  disconnect() {
    this.disconnected = true;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("audioPlaybackActor", () => {
  const originalAudio = globalThis.Audio;
  const originalAudioContext = window.AudioContext;
  const originalAudioWorkletNode = globalThis.AudioWorkletNode;
  const originalWindowAudioWorkletNode = window.AudioWorkletNode;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;

  afterEach(() => {
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: originalAudio,
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: originalAudioContext,
    });
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: originalAudioWorkletNode,
    });
    Object.defineProperty(window, "AudioWorkletNode", {
      configurable: true,
      value: originalWindowAudioWorkletNode,
    });
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    MockAudio.instances = [];
    MockGainNode.instances = [];
    MockAudioWorkletNode.instances = [];
    DelayedMockAudioContext.instance = null;
  });

  it("uses milliseconds for seek and avoids tiny high-speed sync corrections", async () => {
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: MockAudio,
    });
    URL.createObjectURL = () => "blob:mock-audio";
    URL.revokeObjectURL = () => undefined;

    const actor = createActor(audioPlaybackActor, {
      input: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        volume: 0.5,
        playbackRate: 2,
        startPositionMs: 30_000,
      },
    }).start();

    const audio = MockAudio.instances[0];
    expect(audio.currentTime).toBe(30);
    expect(audio.playbackRate).toBe(2);
    expect(audio.preservesPitch).toBe(true);
    expect(audio.mozPreservesPitch).toBe(true);
    expect(audio.webkitPreservesPitch).toBe(true);

    actor.send({ type: "SEEK", timeMs: 12_500 });
    expect(audio.currentTime).toBe(12.5);

    actor.send({ type: "PLAY" });
    await Promise.resolve();
    await Promise.resolve();

    actor.send({ type: "SYNC", timeMs: 12_700 });
    expect(audio.currentTime).toBe(12.5);

    actor.send({ type: "SYNC", timeMs: 13_000 });
    expect(audio.currentTime).toBe(13);

    actor.send({ type: "SET_PLAYBACK_RATE", rate: 1 });
    expect(audio.playbackRate).toBe(1);
    expect(audio.preservesPitch).toBe(true);

    actor.stop();
  });

  it("waits for delayed SoundTouch setup before initial high-speed play", async () => {
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: MockAudio,
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: DelayedMockAudioContext,
    });
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: MockAudioWorkletNode,
    });
    Object.defineProperty(window, "AudioWorkletNode", {
      configurable: true,
      value: MockAudioWorkletNode,
    });
    URL.createObjectURL = () => "blob:mock-audio";
    URL.revokeObjectURL = () => undefined;

    const actor = createActor(audioPlaybackActor, {
      input: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        volume: 0.5,
        playbackRate: 2,
        startPositionMs: 0,
      },
    }).start();

    const audio = MockAudio.instances[0];
    expect(audio.playbackRate).toBe(1);
    expect(audio.preservesPitch).toBe(false);

    actor.send({ type: "PLAY" });
    await Promise.resolve();
    await Promise.resolve();

    expect(audio.playCalls).toBe(0);
    expect(MockAudioWorkletNode.instances).toHaveLength(0);

    await waitUntil(() => DelayedMockAudioContext.instance?.resolveModule !== null);
    DelayedMockAudioContext.instance?.resolveModule?.();

    await waitUntil(() => MockAudioWorkletNode.instances.length === 1);
    await waitUntil(() => audio.playCalls === 1);

    const soundTouchNode = MockAudioWorkletNode.instances[0];
    expect(audio.playbackRate).toBe(2);
    expect(audio.preservesPitch).toBe(false);
    expect(soundTouchNode.parameters.get("playbackRate")?.value).toBe(2);

    actor.stop();
  });

  it("uses SoundTouch to keep pitch stable at high playback rates", async () => {
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: MockAudio,
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: MockAudioContext,
    });
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: MockAudioWorkletNode,
    });
    Object.defineProperty(window, "AudioWorkletNode", {
      configurable: true,
      value: MockAudioWorkletNode,
    });
    URL.createObjectURL = () => "blob:mock-audio";
    URL.revokeObjectURL = () => undefined;

    const actor = createActor(audioPlaybackActor, {
      input: {
        blob: new Blob(["audio"], { type: "audio/webm" }),
        volume: 0.5,
        playbackRate: 2,
        startPositionMs: 30_000,
      },
    }).start();

    await waitUntil(() => MockAudioWorkletNode.instances.length === 1);

    const audio = MockAudio.instances[0];
    const soundTouchNode = MockAudioWorkletNode.instances[0];
    const gainNode = MockGainNode.instances[0];

    expect(audio.playbackRate).toBe(2);
    expect(audio.preservesPitch).toBe(false);
    expect(soundTouchNode.parameters.get("playbackRate")?.value).toBe(2);
    expect(soundTouchNode.parameters.get("pitch")?.value).toBe(1);
    expect(soundTouchNode.parameters.get("pitchSemitones")?.value).toBe(0);
    expect(gainNode.gain.value).toBe(0.5);

    actor.send({ type: "SET_PLAYBACK_RATE", rate: 1.5 });
    expect(audio.playbackRate).toBe(1.5);
    expect(soundTouchNode.parameters.get("playbackRate")?.value).toBe(1.5);

    actor.send({ type: "SET_VOLUME", volume: 0.25 });
    expect(audio.volume).toBe(1);
    expect(gainNode.gain.value).toBe(0.25);

    actor.stop();
  });
});
