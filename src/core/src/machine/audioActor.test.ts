import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, waitFor } from "xstate";
import { audioRecordingActor } from "./audioActor";
import { editorMachine } from "./editorMachine";

class FakeAudioTrack {
  stopped = false;

  stop() {
    this.stopped = true;
  }
}

class FakeAudioStream {
  private readonly track: FakeAudioTrack;

  constructor(track: FakeAudioTrack) {
    this.track = track;
  }

  getTracks() {
    return [this.track];
  }
}

class FakeAudioMediaRecorder {
  static instances: FakeAudioMediaRecorder[] = [];

  static isTypeSupported() {
    return true;
  }

  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor() {
    FakeAudioMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
    this.onstart?.();
  }

  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

describe("audioRecordingActor lifecycle", () => {
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  let actors: Array<ReturnType<typeof createActor>> = [];

  beforeEach(() => {
    FakeAudioMediaRecorder.instances = [];
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: FakeAudioMediaRecorder,
    });
  });

  afterEach(() => {
    for (const actor of actors) actor.stop();
    actors = [];
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

  it("does not start after STOP wins a pending getUserMedia race", async () => {
    const track = new FakeAudioTrack();
    let resolveStream!: (stream: MediaStream) => void;
    const streamPromise = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => streamPromise },
    });

    const actor = createActor(audioRecordingActor, { input: {} }).start();
    actors.push(actor);
    actor.send({ type: "START" });
    actor.send({ type: "STOP" });

    resolveStream(new FakeAudioStream(track) as unknown as MediaStream);
    await streamPromise;
    await Promise.resolve();

    expect(FakeAudioMediaRecorder.instances).toHaveLength(0);
    expect(track.stopped).toBe(true);
  });

  it("reports a MediaRecorder runtime error and drains the recording session", async () => {
    const track = new FakeAudioTrack();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve(new FakeAudioStream(track) as unknown as MediaStream),
      },
    });
    const onError = vi.fn();
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null }, enableAudioRecording: true, onError },
    }).start();
    actors.push(actor);

    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.value === "recording");
    const errorEvent = Object.assign(new Event("error"), {
      error: new Error("microphone failed"),
    });
    FakeAudioMediaRecorder.instances[0]!.onerror?.(errorEvent);
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "microphone failed" }));
    expect(actor.getSnapshot().context.recording).not.toBeNull();
    expect(actor.getSnapshot().children.audioRecorder).toBeUndefined();
    expect(track.stopped).toBe(true);
  });
});
