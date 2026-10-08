import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, waitFor } from "xstate";
import {
  audioRecordingActor,
  type AudioPlaybackEmit,
  type AudioPlaybackEvent,
  type AudioPlaybackInput,
} from "./audioActor";
import { editorMachine } from "./editorMachine";
import { fromTypedCallback } from "./fromTypedCallback";
import { getPlaybackAudioState } from "./playbackActors";
import type { Recording } from "../types";

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
  /** Hold `onstop` until `finishStop()`, like a MediaRecorder slow to flush its blob. */
  static deferStops = false;
  /** Data flushed just before `onstop`; null flushes nothing, leaving an empty blob. */
  static finalChunk: Blob | null = null;

  static isTypeSupported() {
    return true;
  }

  state: "inactive" | "recording" | "paused" = "inactive";
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

  pause() {
    this.state = "paused";
  }

  resume() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    if (FakeAudioMediaRecorder.deferStops) return;
    this.finishStop();
  }

  finishStop() {
    if (FakeAudioMediaRecorder.finalChunk) {
      this.ondataavailable?.({ data: FakeAudioMediaRecorder.finalChunk });
    }
    this.onstop?.();
  }
}

function createRecording(id: string): Recording {
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
  return {
    version: 4,
    id,
    name: id,
    createdAt: 1,
    duration: 1000,
    keyframeInterval: 120,
    frames: [
      {
        timestamp: 0,
        isKeyframe: true,
        state: {
          content: "",
          selection,
          position: { lineNumber: 1, column: 1 },
          viewState: null,
          mouseCursor: { x: 0, y: 0, visible: false },
        },
      },
    ],
  };
}

describe("audioRecordingActor lifecycle", () => {
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  let actors: Array<ReturnType<typeof createActor>> = [];

  beforeEach(() => {
    FakeAudioMediaRecorder.instances = [];
    FakeAudioMediaRecorder.deferStops = false;
    FakeAudioMediaRecorder.finalChunk = null;
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
    vi.useRealTimers();
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

  // The take can be paused while the microphone prompt is still open; the recorder that
  // starts afterwards must not write the paused stretch.
  it("pauses with the take, including a pause that comes before the recorder starts", async () => {
    let grantMicrophone!: (stream: MediaStream) => void;
    const streamPromise = new Promise<MediaStream>((resolve) => {
      grantMicrophone = resolve;
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => streamPromise },
    });

    const actor = createActor(audioRecordingActor, { input: {} }).start();
    actors.push(actor);
    actor.send({ type: "START" });
    actor.send({ type: "PAUSE" });

    grantMicrophone(new FakeAudioStream(new FakeAudioTrack()) as unknown as MediaStream);
    await vi.waitFor(() => expect(FakeAudioMediaRecorder.instances).toHaveLength(1));
    const recorder = FakeAudioMediaRecorder.instances[0]!;
    expect(recorder.state).toBe("paused");

    actor.send({ type: "RESUME" });
    expect(recorder.state).toBe("recording");
    actor.send({ type: "PAUSE" });
    expect(recorder.state).toBe("paused");
  });

  it("reports a MediaRecorder runtime error and drains the recording session", async () => {
    const track = new FakeAudioTrack();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve(new FakeAudioStream(track) as unknown as MediaStream),
      },
    });
    const onError = vi.fn<(error: Error) => void>();
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null }, enableAudioRecording: true, onError },
    }).start();
    actors.push(actor);

    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));
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

  // The machine passed its own constraints, and the actor kept a different default, with
  // mono and 16kHz hints, that no take ever reached. The actor's default is now the one set.
  it("asks for the microphone with the constraints every take records with", async () => {
    const requests: MediaStreamConstraints[] = [];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: (constraints: MediaStreamConstraints) => {
          requests.push(constraints);
          return Promise.resolve(
            new FakeAudioStream(new FakeAudioTrack()) as unknown as MediaStream,
          );
        },
      },
    });
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null }, enableAudioRecording: true },
    }).start();
    actors.push(actor);

    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));

    expect(requests).toEqual([
      { audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true } },
    ]);
  });

  describe("with a picked microphone", () => {
    const defaults = { autoGainControl: true, echoCancellation: true, noiseSuppression: true };
    const liveStream = () =>
      Promise.resolve(new FakeAudioStream(new FakeAudioTrack()) as unknown as MediaStream);
    const failure = (name: string, message: string) =>
      Promise.reject(Object.assign(new Error(message), { name }));

    const answerMicrophone = (
      answer: (call: number) => Promise<MediaStream>,
    ): MediaStreamConstraints[] => {
      const requests: MediaStreamConstraints[] = [];
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: (constraints: MediaStreamConstraints) => {
            requests.push(constraints);
            return answer(requests.length);
          },
        },
      });
      return requests;
    };

    const startMachine = (onError?: (error: Error) => void) => {
      const actor = createActor(editorMachine, {
        input: { editorRef: { current: null }, enableAudioRecording: true, onError },
      }).start();
      actors.push(actor);
      return actor;
    };

    it("records from it", async () => {
      const requests = answerMicrophone(liveStream);
      const actor = startMachine();

      actor.send({ type: "START_RECORDING", microphoneDeviceId: "usb-mic" });
      await waitFor(actor, (snapshot) => snapshot.matches("recording"));

      expect(requests).toEqual([{ audio: { ...defaults, deviceId: { exact: "usb-mic" } } }]);
    });

    it("records from the default microphone when the picked one is gone", async () => {
      const requests = answerMicrophone((call) =>
        call === 1 ? failure("OverconstrainedError", "no such device") : liveStream(),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const actor = startMachine();

      actor.send({ type: "START_RECORDING", microphoneDeviceId: "unplugged" });
      await waitFor(actor, (snapshot) => snapshot.matches("recording"));

      expect(requests).toEqual([
        { audio: { ...defaults, deviceId: { exact: "unplugged" } } },
        { audio: defaults },
      ]);
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    it("does not retry past a refused permission", async () => {
      const requests = answerMicrophone(() => failure("NotAllowedError", "Permission denied"));
      const onError = vi.fn<(error: Error) => void>();
      const actor = startMachine(onError);

      actor.send({ type: "START_RECORDING", microphoneDeviceId: "usb-mic" });
      await waitFor(actor, (snapshot) => snapshot.value === "idle");

      expect(requests).toHaveLength(1);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Permission denied" }),
      );
    });
  });

  describe("in the editor machine, past the finalize watchdog", () => {
    const narration = new Blob(["narration"], { type: "audio/webm" });

    // Playback of a take with narration spawns an audio player, which jsdom cannot run.
    const recorderMachine = editorMachine.provide({
      actors: {
        audioPlayback: fromTypedCallback<AudioPlaybackEvent, AudioPlaybackInput, AudioPlaybackEmit>(
          () => {},
        ),
      },
    });

    const provideMicrophones = (...tracks: FakeAudioTrack[]) => {
      const streams = tracks.map((track) => new FakeAudioStream(track) as unknown as MediaStream);
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: () => Promise.resolve(streams.shift()!) },
      });
    };

    const startRecorder = () => {
      const actor = createActor(recorderMachine, {
        input: { editorRef: { current: null }, enableAudioRecording: true },
      }).start();
      actors.push(actor);
      return actor;
    };

    // Records a take whose MediaRecorder is slow to flush and stops it. The caller then
    // lets the 2s watchdog finalize the take before the blob exists.
    const stopSlowTake = async (actor: ReturnType<typeof startRecorder>) => {
      FakeAudioMediaRecorder.deferStops = true;
      FakeAudioMediaRecorder.finalChunk = narration;
      actor.send({ type: "START_RECORDING" });
      await waitFor(actor, (snapshot) => snapshot.matches("recording"));
      actor.send({ type: "STOP_RECORDING" });
      expect(actor.getSnapshot().value).toBe("stoppingRecording");
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    it("lists the audio track of a take whose narration lands after the watchdog", async () => {
      provideMicrophones(new FakeAudioTrack());
      const actor = startRecorder();

      await stopSlowTake(actor);
      vi.advanceTimersByTime(2000);
      expect(actor.getSnapshot().value).toBe("loading");

      const take = actor.getSnapshot().context.recording!;
      expect(take.audioBlob).toBeUndefined();
      expect(take.tracks).toContainEqual(expect.objectContaining({ kind: "audio" }));
    });

    it("reattaches a blob that lands while the finalized take is loading", async () => {
      const track = new FakeAudioTrack();
      provideMicrophones(track);
      const actor = startRecorder();

      await stopSlowTake(actor);
      vi.advanceTimersByTime(2000);
      expect(actor.getSnapshot().value).toBe("loading");

      FakeAudioMediaRecorder.instances[0]!.finishStop();
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

      const take = actor.getSnapshot().context.recording!;
      expect(take.audioBlob).toBeInstanceOf(Blob);
      expect((take.audioBlob as Blob).size).toBe(narration.size);
      expect(take.audioSource).toBe("microphone");
      expect(take.audioStartOffsetMs).toBe(0);
      expect(getPlaybackAudioState(take)).not.toBeNull();
      expect(actor.getSnapshot().children.audioRecorder).toBeUndefined();
      expect(track.stopped).toBe(true);
    });

    it("attaches a blob that lands in playback to that take and to no other", async () => {
      const track = new FakeAudioTrack();
      provideMicrophones(track);
      const actor = startRecorder();

      await stopSlowTake(actor);
      vi.advanceTimersByTime(2000);
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
      expect(actor.getSnapshot().context.recording!.audioBlob).toBeUndefined();
      expect(actor.getSnapshot().children.audioRecorder).toBeDefined();
      expect(track.stopped).toBe(false);

      FakeAudioMediaRecorder.instances[0]!.finishStop();

      const take = actor.getSnapshot().context.recording!;
      expect(take.audioBlob).toBeInstanceOf(Blob);
      expect((take.audioBlob as Blob).size).toBe(narration.size);
      expect(take.audioSource).toBe("microphone");
      expect(take.audioStartOffsetMs).toBe(0);
      expect(getPlaybackAudioState(take)).not.toBeNull();
      expect(actor.getSnapshot().children.audioRecorder).toBeUndefined();
      expect(track.stopped).toBe(true);

      // The late blob leaves the audio slice marked as a microphone take. A recording
      // without narration loaded next must not inherit it.
      actor.send({ type: "LOAD_RECORDING", recording: createRecording("imported") });
      await waitFor(
        actor,
        (snapshot) =>
          snapshot.matches({ playback: "ready" }) && snapshot.context.recording?.id === "imported",
      );
      expect(actor.getSnapshot().context.recording!.audioBlob).toBeUndefined();
    });

    it("stops a recorder that never flushed when its take is unloaded", async () => {
      const firstTrack = new FakeAudioTrack();
      const secondTrack = new FakeAudioTrack();
      provideMicrophones(firstTrack, secondTrack);
      const actor = startRecorder();

      await stopSlowTake(actor);
      vi.advanceTimersByTime(2000);
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
      const stuckRecorder = actor.getSnapshot().children.audioRecorder;
      expect(stuckRecorder).toBeDefined();

      actor.send({ type: "UNLOAD" });
      expect(actor.getSnapshot().value).toBe("idle");
      expect(actor.getSnapshot().children.audioRecorder).toBeUndefined();
      expect(stuckRecorder!.getSnapshot().status).toBe("stopped");
      expect(firstTrack.stopped).toBe(true);

      // The first take's straggler finally flushes during the next take.
      actor.send({ type: "START_RECORDING" });
      await waitFor(actor, (snapshot) => snapshot.matches("recording"));
      FakeAudioMediaRecorder.instances[0]!.finishStop();

      const snapshot = actor.getSnapshot();
      expect(snapshot.matches("recording")).toBe(true);
      expect(snapshot.context.audio.isRecording).toBe(true);
      expect(snapshot.context.audio.blob).toBeNull();
      expect(snapshot.children.audioRecorder).toBeDefined();
      expect(snapshot.children.audioRecorder).not.toBe(stuckRecorder);
      expect(secondTrack.stopped).toBe(false);
    });

    it("stops a recorder that never flushed when another recording replaces its take", async () => {
      const track = new FakeAudioTrack();
      provideMicrophones(track);
      const actor = startRecorder();

      await stopSlowTake(actor);
      vi.advanceTimersByTime(2000);
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

      actor.send({ type: "LOAD_RECORDING", recording: createRecording("imported") });
      expect(actor.getSnapshot().children.audioRecorder).toBeUndefined();
      expect(track.stopped).toBe(true);
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

      FakeAudioMediaRecorder.instances[0]!.finishStop();

      expect(actor.getSnapshot().context.recording!.id).toBe("imported");
      expect(actor.getSnapshot().context.recording!.audioBlob).toBeUndefined();
    });
  });

  // MediaRecorder stops by itself when its track ends (device unplugged, permission
  // revoked). Its file is stored then, and `stoppingRecording` does not wait for a
  // microphone that already stopped, so nothing else would stop the actor, and the
  // next take's spawn under the same id would orphan it.
  it("stops a recorder that ends by itself mid-take", async () => {
    const track = new FakeAudioTrack();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.resolve(new FakeAudioStream(track) as unknown as MediaStream),
      },
    });
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null }, enableAudioRecording: true },
    }).start();
    actors.push(actor);

    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));
    const recorder = actor.getSnapshot().children.audioRecorder;
    expect(recorder).toBeDefined();

    FakeAudioMediaRecorder.instances[0]!.stop();

    const snapshot = actor.getSnapshot();
    expect(snapshot.matches("recording")).toBe(true);
    expect(snapshot.context.audio.isRecording).toBe(false);
    expect(snapshot.context.audio.blob).toBeInstanceOf(Blob);
    expect(snapshot.children.audioRecorder).toBeUndefined();
    expect(recorder!.getSnapshot().status).toBe("stopped");
    expect(track.stopped).toBe(true);
  });
});
