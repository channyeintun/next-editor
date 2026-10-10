import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, setup, waitFor } from "xstate";
import {
  audioPlaybackActor,
  audioRecordingActor,
  type AudioPlaybackEmit,
  type AudioPlaybackEvent,
  type AudioPlaybackInput,
} from "./audioActor";
import { editorMachine } from "./editorMachine";
import { fromTypedCallback } from "./fromTypedCallback";
import { getPlaybackAudioState } from "./playbackActors";
import { createRecording, pinPerformanceClock } from "./testing/takeFixtures";
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

/** A recording without narration. */
function createSilentRecording(id: string): Recording {
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
      actor.send({ type: "LOAD_RECORDING", recording: createSilentRecording("imported") });
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

      actor.send({ type: "LOAD_RECORDING", recording: createSilentRecording("imported") });
      expect(actor.getSnapshot().children.audioRecorder).toBeUndefined();
      expect(track.stopped).toBe(true);
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

      FakeAudioMediaRecorder.instances[0]!.finishStop();

      expect(actor.getSnapshot().context.recording!.id).toBe("imported");
      expect(actor.getSnapshot().context.recording!.audioBlob).toBeUndefined();
    });
  });

  // startMicrophoneRecorder: the microphone take's audio slice starts from the idle one.
  it("starts a microphone take with an idle audio slice marked as recording", () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => new Promise<MediaStream>(() => {}) },
    });
    const actor = createActor(editorMachine, {
      input: { editorRef: { current: null }, enableAudioRecording: true },
    }).start();
    actors.push(actor);

    actor.send({ type: "START_RECORDING" });

    expect(actor.getSnapshot().value).toBe("startingRecording");
    expect(actor.getSnapshot().context.audio).toEqual({
      blob: null,
      isRecording: true,
      mediaRecorder: null,
      mimeType: "",
      source: "microphone",
      startOffsetMs: 0,
      externalDurationMs: null,
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

  // A selected-file take resumes its narration with PLAY alone. Extrapolating from the
  // PAUSE skipped the whole paused span, so the narration ran ahead of the take.
  it("resumes where PAUSE left it when PLAY comes without a SEEK", () => {
    const clock = pinPerformanceClock();
    const actor = createPlayback(1);
    const audio = MockAudio.instances[0]!;
    actor.send({ type: "PLAY" });
    clock.now += 1000;
    audio.currentTime = 1;
    actor.send({ type: "PAUSE" });

    clock.now += 3000;
    actor.send({ type: "PLAY" });

    expect(audio.currentTime).toBe(1);
  });

  // A retake pauses and seeks to the safe point, then resumes later with PLAY.
  it("resumes at the SEEK made while paused, not past it", () => {
    const clock = pinPerformanceClock();
    const actor = createPlayback(1);
    const audio = MockAudio.instances[0]!;
    actor.send({ type: "PLAY" });
    clock.now += 1000;
    audio.currentTime = 1;
    actor.send({ type: "PAUSE" });
    actor.send({ type: "SEEK", timeMs: 500 });

    clock.now += 3000;
    actor.send({ type: "PLAY" });

    expect(audio.currentTime).toBe(0.5);
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
    expect(reported).toEqual([{ type: "AUDIO_PLAYBACK_READY", durationMs: 12_500 }]);

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
    expect(actor.getSnapshot().matches("recording")).toBe(true);
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

    expect(actor.getSnapshot().matches("recording")).toBe(true);
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
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));
    const audio = MockAudio.instances[0]!;
    audio.duration = 3.2;
    audio.oncanplay?.();

    // The studio reads this length to reject stale narration.
    const recordingContext = actor.getSnapshot().context;
    expect(recordingContext.audio.externalDurationMs).toBe(3200);

    // The element ends after its length plus the time play() took to start.
    clock.now += 3250;
    audio.onended?.();
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));

    const recording = actor.getSnapshot().context.recording!;
    expect(recording.duration).toBe(3200);
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
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));
    const audio = MockAudio.instances[0]!;
    const audioBefore = actor.getSnapshot().context.audio;
    audio.duration = Number.POSITIVE_INFINITY;
    audio.oncanplay?.();
    audio.oncanplay?.();

    expect(actor.getSnapshot().context.audio.externalDurationMs).toBeNull();
    // Nothing was stored: the audio slice is the one the take started with.
    expect(actor.getSnapshot().context.audio).toBe(audioBefore);

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
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));
    actor.send({ type: "STOP_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
    expect(actor.getSnapshot().context.recording!.audioBlob).toBe(narration);

    actor.send({ type: "UNLOAD" });
    expect(actor.getSnapshot().context.audio.blob).toBeNull();

    actor.send({ type: "START_RECORDING" });
    await waitFor(actor, (snapshot) => snapshot.matches("recording"));
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

  it("moves the timeline and the narration to the stored playhead on SEEK and STOP", async () => {
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
    const timelineTime = () =>
      actor.getSnapshot().children.timelineActor!.getSnapshot().context.currentTime;

    actor.send({ type: "SEEK", time: 400 });
    expect(timelineTime()).toBe(400);
    expect(audio.currentTime).toBe(0.4);

    // Paused, and past the 1s recording: every consumer gets the clamped end.
    actor.send({ type: "PLAY" });
    actor.send({ type: "PAUSE" });
    actor.send({ type: "SEEK", time: 5_000 });
    expect(actor.getSnapshot().matches({ playback: "paused" })).toBe(true);
    expect(actor.getSnapshot().context.timeline.currentTime).toBe(1_000);
    expect(timelineTime()).toBe(1_000);
    expect(audio.currentTime).toBe(1);
    expect(onSeek).toHaveBeenLastCalledWith(1_000);

    actor.send({ type: "STOP" });
    expect(timelineTime()).toBe(0);
    expect(audio.currentTime).toBe(0);
  });
});
