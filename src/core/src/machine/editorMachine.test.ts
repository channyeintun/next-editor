import { afterEach, describe, expect, it } from "vite-plus/test";
import { createActor, waitFor } from "xstate";
import { editorMachine } from "./editorMachine";
import { audioPlaybackActor } from "./audioActor";
import type { Recording } from "../types";

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
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ playback: "playing" }),
    );

    actor.send({ type: "SET_SPEED", speed: 2 });
    actor.send({ type: "SEEK", time: 500 });
    actor.send({ type: "PAUSE" });

    await waitFor(actor, (snapshot) =>
      snapshot.matches({ playback: "paused" }),
    );
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
});

class MockAudio {
  static instances: MockAudio[] = [];

  currentTime = 0;
  volume = 1;
  playbackRate = 1;
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

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
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
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    MockAudio.instances = [];
    MockGainNode.instances = [];
    MockAudioWorkletNode.instances = [];
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
