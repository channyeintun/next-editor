import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, setup, waitFor } from "xstate";
import {
  audioPlaybackActor,
  audioRecordingActor,
  type AudioPlaybackEmit,
  type AudioPlaybackEvent,
  type AudioPlaybackInput,
  type NarrationLoadEmitted,
  type NarrationLoadFacts,
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
        audioPlayback: fromTypedCallback<
          AudioPlaybackEvent,
          AudioPlaybackInput,
          AudioPlaybackEmit,
          NarrationLoadEmitted
        >(() => {}),
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
    preload = "";
    /** HAVE_ENOUGH_DATA unless a test starves the element. */
    readyState = 4;
    /** NETWORK_EMPTY (0) to NETWORK_NO_SOURCE (3); 2 is NETWORK_LOADING. */
    networkState = 0;
    /** The loaded ranges, in seconds, as `[start, end]` pairs. */
    bufferedRanges: Array<[number, number]> = [];
    error: { code: number } | null = null;
    onloadedmetadata: (() => void) | null = null;
    onloadeddata: (() => void) | null = null;
    onprogress: (() => void) | null = null;
    onsuspend: (() => void) | null = null;
    oncanplay: (() => void) | null = null;
    ondurationchange: (() => void) | null = null;
    onplaying: (() => void) | null = null;
    onwaiting: (() => void) | null = null;
    onpause: (() => void) | null = null;
    ontimeupdate: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    playCalls = 0;
    pauseCalls = 0;
    loadCalls = 0;

    constructor() {
      MockAudio.instances.push(this);
    }

    get ended() {
      return Number.isFinite(this.duration) && this.currentTime >= this.duration;
    }

    get buffered() {
      const ranges = this.bufferedRanges;
      return {
        length: ranges.length,
        start: (index: number) => ranges[index]![0],
        end: (index: number) => ranges[index]![1],
      };
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

    removeAttribute(name: string) {
      if (name === "src") this.src = "";
    }

    /** Like a real element, load() starts over: no error, no data, paused, at the start. */
    load() {
      this.loadCalls++;
      this.error = null;
      this.readyState = 0;
      this.paused = true;
      this.currentTime = 0;
    }
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
  const observePlayback = (
    source: Pick<AudioPlaybackInput, "blob" | "audioUrl"> = {
      blob: new Blob(["audio"], { type: "audio/webm" }),
    },
  ) => {
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
            ...source,
            volume: 1,
            playbackRate: 1,
            startPositionMs: 0,
          },
        },
        on: {
          AUDIO_PLAYBACK_READY: { actions: ({ event }) => reported.push(event) },
          AUDIO_PLAYBACK_ERROR: { actions: ({ event }) => reported.push(event) },
          AUDIO_PLAYBACK_STALLED: { actions: ({ event }) => reported.push(event) },
          AUDIO_PLAYBACK_RESUMED: { actions: ({ event }) => reported.push(event) },
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

  // A published lesson's narration is not in memory: the element downloads it as it plays.
  describe("a narration streamed from its URL", () => {
    const NARRATION_URL = "https://cdn.example.com/lesson.ogg";
    const STALLED = { type: "AUDIO_PLAYBACK_STALLED" } as const;
    const RESUMED = { type: "AUDIO_PLAYBACK_RESUMED" } as const;

    afterEach(() => {
      vi.useRealTimers();
    });

    it("plays from the URL alone, and loads none of it before PLAY", () => {
      const { player } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;

      expect(audio.src).toBe(NARRATION_URL);
      expect(audio.preload).toBe("none");

      player.send({ type: "PLAY" });

      expect(audio.preload).toBe("auto");
      expect(audio.playCalls).toBe(1);
    });

    it("leaves a narration that is already in memory to load as the browser does", () => {
      const { player } = observePlayback();
      const audio = MockAudio.instances[0]!;

      player.send({ type: "PLAY" });

      expect(audio.src).toBe("blob:mock");
      expect(audio.preload).toBe("");
    });

    it("says when the sound has not arrived, and when it flows again", () => {
      const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;

      // Asked to play before anything has downloaded.
      audio.readyState = 0;
      player.send({ type: "PLAY" });
      expect(reported).toEqual([STALLED]);

      audio.readyState = 4;
      audio.onplaying?.();
      expect(reported).toEqual([STALLED, RESUMED]);

      // The download falls behind the playhead mid-lesson.
      audio.readyState = 2;
      audio.onwaiting?.();
      audio.onwaiting?.();
      expect(reported).toEqual([STALLED, RESUMED, STALLED]);

      // A browser that skips `playing` after a stall still moves the playhead.
      audio.readyState = 4;
      audio.ontimeupdate?.();
      expect(reported).toEqual([STALLED, RESUMED, STALLED, RESUMED]);
    });

    describe("tells whoever draws the wait how it is going", () => {
      const listenToLoad = (player: ReturnType<typeof observePlayback>["player"]) => {
        const facts: NarrationLoadFacts[] = [];
        player.on("NARRATION_LOAD", ({ type: _type, ...fact }) => facts.push(fact));
        return facts;
      };

      it("emits each step the element takes, from the start of the wait to sound", () => {
        const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
        const facts = listenToLoad(player);
        const audio = MockAudio.instances[0]!;
        audio.readyState = 0;

        // Loading before anyone waits for it is not a wait.
        audio.onprogress?.();
        expect(facts).toEqual([]);

        player.send({ type: "PLAY" });
        expect(facts).toEqual([
          { stage: "loading", readyState: 0, bufferedAheadSeconds: 0, dataArrivals: 0 },
        ]);

        // Data arrives for a while before the element knows anything about the file.
        audio.onprogress?.();
        audio.onprogress?.();
        audio.readyState = 1;
        audio.onloadedmetadata?.();
        audio.readyState = 2;
        audio.bufferedRanges = [[0, 0.4]];
        audio.onloadeddata?.();
        audio.bufferedRanges = [[0, 1.5]];
        audio.onprogress?.();
        expect(facts.slice(1)).toEqual([
          { stage: "loading", readyState: 0, bufferedAheadSeconds: 0, dataArrivals: 1 },
          { stage: "loading", readyState: 0, bufferedAheadSeconds: 0, dataArrivals: 2 },
          { stage: "loading", readyState: 1, bufferedAheadSeconds: 0, dataArrivals: 2 },
          { stage: "loading", readyState: 2, bufferedAheadSeconds: 0.4, dataArrivals: 2 },
          { stage: "loading", readyState: 2, bufferedAheadSeconds: 1.5, dataArrivals: 3 },
        ]);

        audio.readyState = 4;
        audio.onplaying?.();
        expect(facts.at(-1)).toEqual({
          stage: "flowing",
          readyState: 4,
          bufferedAheadSeconds: 1.5,
          dataArrivals: 3,
        });
        // The steps are for the drawer alone: the parent heard the stall and its end.
        expect(reported).toEqual([STALLED, RESUMED]);

        // Sound is flowing: what loads from here on is no wait.
        audio.onprogress?.();
        expect(facts).toHaveLength(7);

        // The next wait counts its own arrivals.
        audio.readyState = 1;
        audio.onwaiting?.();
        audio.onprogress?.();
        expect(facts.slice(7).map((fact) => fact.dataArrivals)).toEqual([0, 1]);
      });

      it("says how the wait ended before the parent ends the hold", () => {
        const order: string[] = [];
        const parent = createActor(
          setup({
            types: { events: {} as AudioPlaybackEmit },
            actors: { player: audioPlaybackActor },
          }).createMachine({
            invoke: {
              id: "player",
              src: "player",
              input: { audioUrl: NARRATION_URL, volume: 1, playbackRate: 1, startPositionMs: 0 },
            },
            on: {
              AUDIO_PLAYBACK_STALLED: { actions: () => order.push("STALLED") },
              AUDIO_PLAYBACK_RESUMED: { actions: () => order.push("RESUMED") },
            },
          }),
        ).start();
        spawnedActors.push(parent);
        const player = parent.getSnapshot().children.player!;
        player.on("NARRATION_LOAD", ({ stage }) => order.push(stage));
        const audio = MockAudio.instances[0]!;
        audio.readyState = 0;

        player.send({ type: "PLAY" });
        audio.readyState = 4;
        audio.onplaying?.();

        expect(order).toEqual(["loading", "STALLED", "flowing", "RESUMED"]);
      });

      it("counts the sound loaded from the playhead on, not what lies behind or far ahead", () => {
        const { player } = observePlayback({ audioUrl: NARRATION_URL });
        const facts = listenToLoad(player);
        const audio = MockAudio.instances[0]!;
        audio.readyState = 1;
        player.send({ type: "PLAY" });
        player.send({ type: "SEEK", timeMs: 60_000 });

        audio.bufferedRanges = [
          [0, 12],
          [90, 120],
        ];
        audio.onprogress?.();
        expect(facts.at(-1)?.bufferedAheadSeconds).toBe(0);

        // The range a seek asked for starts a moment after the playhead.
        audio.bufferedRanges = [
          [0, 12],
          [60.05, 62],
        ];
        audio.onprogress?.();
        // The playhead is where the timeline has run on to since the seek: a moment past 60 s.
        expect(facts.at(-1)?.bufferedAheadSeconds).toBeCloseTo(2, 3);
      });

      it("ends a wait it gave up on as abandoned, never as flowing", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const { player } = observePlayback({ audioUrl: NARRATION_URL });
        const facts = listenToLoad(player);
        const audio = MockAudio.instances[0]!;
        player.send({ type: "PLAY" });

        for (const delayMs of [1000, 2000, 4000]) {
          audio.error = { code: 4 };
          audio.onerror?.();
          vi.advanceTimersByTime(delayMs);
        }
        audio.error = { code: 4 };
        audio.onerror?.();

        expect(facts.map((fact) => fact.stage)).toEqual(["loading", "abandoned"]);
      });

      it("ends the wait of a refused play() as abandoned", async () => {
        MockAudio.playRejection = new DOMException("play() not allowed", "NotAllowedError");
        const { player } = observePlayback({ audioUrl: NARRATION_URL });
        const facts = listenToLoad(player);
        const audio = MockAudio.instances[0]!;
        audio.readyState = 0;
        // A real element is no longer paused once play() is called, refused or not...
        audio.play = function refusedPlay(this: typeof audio) {
          this.paused = false;
          return Promise.reject(MockAudio.playRejection).finally(() => {
            // ...and is paused again by the time the refusal is reported.
            this.paused = true;
          });
        };

        player.send({ type: "PLAY" });
        await settle();

        expect(facts.map((fact) => fact.stage)).toEqual(["loading", "abandoned"]);
      });
    });

    describe("warmed up before PLAY", () => {
      const WARM = { type: "WARM" } as const;
      const listenToLoad = (player: ReturnType<typeof observePlayback>["player"]) => {
        const facts: NarrationLoadFacts[] = [];
        player.on("NARRATION_LOAD", ({ type: _type, ...fact }) => facts.push(fact));
        return facts;
      };

      it("loads the start of the narration when asked, with nobody waiting for it", () => {
        const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
        const facts = listenToLoad(player);
        const audio = MockAudio.instances[0]!;

        player.send(WARM);
        // Its metadata, which brings the first sound with it: not the whole file.
        expect(audio.preload).toBe("metadata");
        expect(audio.loadCalls).toBe(1);
        expect(facts).toEqual([
          { stage: "warming", readyState: 0, bufferedAheadSeconds: 0, dataArrivals: 0 },
        ]);

        audio.onprogress?.();
        audio.onprogress?.();
        audio.readyState = 1;
        audio.onloadedmetadata?.();
        audio.readyState = 4;
        audio.bufferedRanges = [[0, 8]];
        audio.oncanplay?.();
        expect(facts.slice(1)).toEqual([
          { stage: "warming", readyState: 0, bufferedAheadSeconds: 0, dataArrivals: 1 },
          { stage: "warming", readyState: 0, bufferedAheadSeconds: 0, dataArrivals: 2 },
          { stage: "warming", readyState: 1, bufferedAheadSeconds: 0, dataArrivals: 2 },
          { stage: "warmed", readyState: 4, bufferedAheadSeconds: 8, dataArrivals: 2 },
        ]);

        // It is warmed up: what loads from here on is nobody's wait.
        audio.onprogress?.();
        audio.onsuspend?.();
        expect(facts).toHaveLength(5);
        // The lesson was never held for it, and it was never asked to play.
        expect(reported).toEqual([]);
        expect(audio.playCalls).toBe(0);
      });

      it("does not load twice where lifting preload has already started the load", () => {
        const { player } = observePlayback({ audioUrl: NARRATION_URL });
        const facts = listenToLoad(player);
        const audio = MockAudio.instances[0]!;
        // A browser that put the load off until asked starts it as `preload` is lifted.
        Object.defineProperty(audio, "preload", {
          configurable: true,
          get: () => "metadata",
          set: () => {
            audio.networkState = 2;
          },
        });

        player.send(WARM);

        expect(audio.loadCalls).toBe(0);
        expect(facts.map((fact) => fact.stage)).toEqual(["warming"]);
      });

      it("has sound at once when PLAY follows", () => {
        const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
        const audio = MockAudio.instances[0]!;
        player.send(WARM);
        audio.readyState = 4;
        audio.oncanplay?.();

        player.send({ type: "PLAY" });

        expect(audio.playCalls).toBe(1);
        // Nothing to load again and nothing to wait for.
        expect(audio.loadCalls).toBe(1);
        expect(reported).toEqual([]);
      });

      it("is done when the browser stops loading by itself", () => {
        const { player } = observePlayback({ audioUrl: NARRATION_URL });
        const facts = listenToLoad(player);
        const audio = MockAudio.instances[0]!;
        player.send(WARM);

        // A phone loads nothing it was not asked to play.
        audio.onsuspend?.();

        expect(facts.map((fact) => fact.stage)).toEqual(["warming", "warmed"]);
      });

      it("leaves a failed warm-up for the first PLAY, with every reload still to spend", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
        const facts = listenToLoad(player);
        const audio = MockAudio.instances[0]!;
        player.send(WARM);

        audio.error = { code: 4 };
        audio.onerror?.();
        vi.advanceTimersByTime(60_000);
        // Nobody waits for it: no reload, no report, and the warm-up is over.
        expect(audio.loadCalls).toBe(1);
        expect(reported).toEqual([]);
        expect(facts.map((fact) => fact.stage)).toEqual(["warming", "warmed"]);

        // PLAY loads it again, and the lesson waits for it as for any narration.
        player.send({ type: "PLAY" });
        expect(audio.loadCalls).toBe(2);
        expect(reported).toEqual([STALLED]);

        // Every reload is still there to spend.
        for (const [delayMs, loads] of [
          [1000, 3],
          [2000, 4],
          [4000, 5],
        ] as const) {
          audio.error = { code: 4 };
          audio.onerror?.();
          vi.advanceTimersByTime(delayMs);
          expect(audio.loadCalls).toBe(loads);
        }
      });

      it("lets a PLAY that overtakes the warm-up wait on the same download", () => {
        const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
        const facts = listenToLoad(player);
        const audio = MockAudio.instances[0]!;
        player.send(WARM);
        audio.onprogress?.();
        audio.onprogress?.();
        audio.onprogress?.();

        player.send({ type: "PLAY" });

        expect(reported).toEqual([STALLED]);
        // Not loaded again, and what has arrived so far still counts.
        expect(audio.loadCalls).toBe(1);
        expect(facts.at(-1)).toEqual({
          stage: "loading",
          readyState: 0,
          bufferedAheadSeconds: 0,
          dataArrivals: 3,
        });
        audio.onprogress?.();
        expect(facts.at(-1)).toMatchObject({ stage: "loading", dataArrivals: 4 });

        // It is a wait now: the browser pausing its download does not end it.
        audio.onsuspend?.();
        expect(facts.at(-1)?.stage).toBe("loading");
      });

      it("is asked once, and not once the narration has been played", () => {
        const { player } = observePlayback({ audioUrl: NARRATION_URL });
        const facts = listenToLoad(player);
        const audio = MockAudio.instances[0]!;

        player.send(WARM);
        player.send(WARM);
        expect(audio.loadCalls).toBe(1);

        const played = observePlayback({ audioUrl: NARRATION_URL });
        const playedFacts = listenToLoad(played.player);
        const playedAudio = MockAudio.instances[1]!;
        played.player.send({ type: "PLAY" });
        played.player.send({ type: "PAUSE" });
        played.player.send(WARM);
        expect(playedAudio.loadCalls).toBe(0);
        expect(playedFacts).toEqual([]);
        expect(facts.map((fact) => fact.stage)).toEqual(["warming"]);
      });

      it("has nothing to fetch for a narration that is in memory", () => {
        const { player } = observePlayback();
        const facts = listenToLoad(player);
        const audio = MockAudio.instances[0]!;

        player.send(WARM);

        expect(audio.loadCalls).toBe(0);
        expect(audio.preload).toBe("");
        expect(facts.map((fact) => fact.stage)).toEqual(["warmed"]);
      });

      it("warms up a narration found elsewhere from its new place", () => {
        const { player } = observePlayback({ audioUrl: NARRATION_URL });
        const facts = listenToLoad(player);
        const audio = MockAudio.instances[0]!;
        player.send(WARM);
        audio.readyState = 4;
        audio.oncanplay?.();

        const movedUrl = "https://cdn.example.com/renamed.ogg";
        player.send({ type: "SET_SOURCE", audioUrl: movedUrl });

        expect(audio.src).toBe(movedUrl);
        expect(audio.preload).toBe("metadata");
        expect(facts.map((fact) => fact.stage)).toEqual(["warming", "warmed", "warming"]);
      });
    });

    it("reports a stall only while it is asked to play", () => {
      const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;
      audio.readyState = 0;

      // Not playing yet: nothing waits for it.
      audio.onwaiting?.();
      expect(reported).toEqual([]);

      player.send({ type: "PLAY" });
      player.send({ type: "PAUSE" });
      audio.onpause?.();
      expect(reported).toEqual([STALLED]);

      // Still without data on the next PLAY: said again.
      player.send({ type: "PLAY" });
      expect(reported).toEqual([STALLED, STALLED]);
    });

    it("is not waiting for data once it has ended, or when play() was refused", async () => {
      MockAudio.playRejection = new DOMException("play() not allowed", "NotAllowedError");
      const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;
      audio.readyState = 0;

      player.send({ type: "PLAY" });
      await settle();

      expect(reported).toEqual([
        {
          type: "AUDIO_PLAYBACK_ERROR",
          error: "Audio playback was blocked by the browser's autoplay policy",
        },
      ]);

      MockAudio.playRejection = null;
      audio.duration = 60;
      player.send({ type: "SEEK", timeMs: 60_000 });
      player.send({ type: "PLAY" });
      expect(reported).toHaveLength(1);
    });

    // The parent stops its timeline while the narration loads. Extrapolating across that
    // wait made the narration jump ahead by as long as it took: the lost opening words.
    it("does not skip the narration a held timeline waited for", () => {
      const clock = pinPerformanceClock();
      const { player } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;
      audio.readyState = 0;
      player.send({ type: "PLAY" });
      player.send({ type: "HOLD" });

      // Eight seconds of a slow connection.
      clock.now += 8000;
      audio.readyState = 4;
      audio.onplaying?.();
      expect(audio.currentTime).toBe(0);

      // The hold ends: the count goes on from where it was held.
      player.send({ type: "PLAY" });
      expect(audio.currentTime).toBe(0);
      clock.now += 2000;
      audio.onplaying?.();
      expect(audio.currentTime).toBe(2);
    });

    it("lines up with the held timeline while it waits, and follows a seek made meanwhile", () => {
      const clock = pinPerformanceClock();
      const { player } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;
      player.send({ type: "PLAY" });
      clock.now += 5000;
      audio.currentTime = 4.8;

      player.send({ type: "HOLD" });
      expect(audio.currentTime).toBe(5);

      // The timeline reports where it stopped; a few ms apart is not worth a seek.
      player.send({ type: "SYNC", timeMs: 5012 });
      expect(audio.currentTime).toBe(5);

      player.send({ type: "SEEK", timeMs: 20_000 });
      player.send({ type: "PLAY" });
      expect(audio.currentTime).toBe(20);
    });

    // A learner listening from another tab: no frame is drawn, so the parent's copy of
    // the time stays at the moment the tab was hidden while the narration plays on. A
    // hold taken from that copy wound the narration back to it, at every stall.
    it("holds where the narration has got to when the parent's time is long out of date", () => {
      const clock = pinPerformanceClock();
      const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;
      player.send({ type: "SEEK", timeMs: 120_000 });
      player.send({ type: "PLAY" });

      // Three minutes of sound with no SYNC, then the stream runs dry.
      clock.now += 180_000;
      audio.currentTime = 300;
      audio.readyState = 2;
      audio.onwaiting?.();
      expect(reported).toEqual([STALLED]);

      player.send({ type: "HOLD" });
      expect(audio.currentTime).toBe(300);

      // Waiting does not move it, and the hold ends where it began.
      clock.now += 20_000;
      audio.readyState = 4;
      audio.onplaying?.();
      player.send({ type: "PLAY" });
      expect(audio.currentTime).toBe(300);
    });

    it("loads again after a failed download, from where the timeline is", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      pinPerformanceClock();
      const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;
      player.send({ type: "SEEK", timeMs: 30_000 });
      player.send({ type: "PLAY" });

      audio.error = { code: 2 };
      audio.onerror?.();
      // Waiting to load again counts as waiting for sound; no failure is reported yet.
      expect(reported).toEqual([STALLED]);
      expect(audio.loadCalls).toBe(0);

      vi.advanceTimersByTime(1000);
      expect(audio.loadCalls).toBe(1);
      expect(audio.currentTime).toBe(30);
      expect(audio.playCalls).toBe(2);
      expect(reported).toEqual([STALLED]);

      audio.readyState = 4;
      audio.onplaying?.();
      expect(reported).toEqual([STALLED, RESUMED]);
    });

    it("gives up after a few reloads, and tries once more on the next PLAY", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;
      player.send({ type: "PLAY" });

      for (const delayMs of [1000, 2000, 4000]) {
        audio.error = { code: 4 };
        audio.onerror?.();
        vi.advanceTimersByTime(delayMs);
      }
      expect(audio.loadCalls).toBe(3);
      expect(reported).toEqual([STALLED]);

      audio.error = { code: 4 };
      audio.onerror?.();
      vi.advanceTimersByTime(60_000);
      expect(audio.loadCalls).toBe(3);
      expect(reported).toEqual([
        STALLED,
        { type: "AUDIO_PLAYBACK_ERROR", error: "Audio playback error" },
        RESUMED,
      ]);

      // The viewer plays again: one more try.
      player.send({ type: "PAUSE" });
      player.send({ type: "PLAY" });
      expect(audio.loadCalls).toBe(4);
    });

    // A narration that is not there (a 404) fails every load. Each Play may ask once;
    // the whole 1 s, 2 s, 4 s series again would hold the lesson seven seconds a Play.
    it("tries a narration it gave up on once per Play, not the whole series again", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;
      player.send({ type: "PLAY" });
      for (const delayMs of [1000, 2000, 4000, 0]) {
        audio.error = { code: 4 };
        audio.onerror?.();
        vi.advanceTimersByTime(delayMs);
      }
      expect(audio.loadCalls).toBe(3);
      player.send({ type: "PAUSE" });
      reported.length = 0;

      player.send({ type: "PLAY" });
      expect(audio.loadCalls).toBe(4);
      expect(reported).toEqual([STALLED]);

      audio.error = { code: 4 };
      audio.onerror?.();
      vi.advanceTimersByTime(60_000);
      expect(audio.loadCalls).toBe(4);
      expect(reported).toEqual([
        STALLED,
        { type: "AUDIO_PLAYBACK_ERROR", error: "Audio playback error" },
        RESUMED,
      ]);
    });

    it("has all its reloads back once sound has flowed again", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { player } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;
      player.send({ type: "PLAY" });
      for (const delayMs of [1000, 2000, 4000, 0]) {
        audio.error = { code: 4 };
        audio.onerror?.();
        vi.advanceTimersByTime(delayMs);
      }
      player.send({ type: "PAUSE" });
      player.send({ type: "PLAY" });
      audio.readyState = 4;
      audio.onplaying?.();
      expect(audio.loadCalls).toBe(4);

      // The connection drops again later: the series starts over.
      for (const delayMs of [1000, 2000, 4000]) {
        audio.error = { code: 2 };
        audio.onerror?.();
        vi.advanceTimersByTime(delayMs);
      }
      expect(audio.loadCalls).toBe(7);
    });

    // A recording that is still streaming in sends the player a PLAY with every chunk.
    // Loading a failed narration again at each one held the lesson again and again.
    it("does not try again at a PLAY repeated while it already plays", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { player, reported } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;
      player.send({ type: "PLAY" });
      for (const delayMs of [1000, 2000, 4000, 0]) {
        audio.error = { code: 4 };
        audio.onerror?.();
        vi.advanceTimersByTime(delayMs);
      }
      reported.length = 0;

      player.send({ type: "PLAY" });
      player.send({ type: "PLAY" });

      expect(audio.loadCalls).toBe(3);
      expect(reported).toEqual([]);
    });

    // Giving up ends the parent's hold with a PLAY. Loading again there would stall and
    // hold the lesson once more, for as long as the narration cannot be loaded.
    it("does not try again at the PLAY that ends a hold", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { player } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;
      player.send({ type: "PLAY" });
      player.send({ type: "HOLD" });
      for (const delayMs of [1000, 2000, 4000, 0]) {
        audio.error = { code: 4 };
        audio.onerror?.();
        vi.advanceTimersByTime(delayMs);
      }

      player.send({ type: "PLAY" });

      expect(audio.loadCalls).toBe(3);
    });

    it("reports a narration in memory that fails at once: loading it again cannot help", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { player, reported } = observePlayback();
      const audio = MockAudio.instances[0]!;
      player.send({ type: "PLAY" });

      audio.error = { code: 3 };
      audio.onerror?.();
      vi.advanceTimersByTime(60_000);

      expect(reported).toEqual([{ type: "AUDIO_PLAYBACK_ERROR", error: "Audio playback error" }]);
      expect(audio.loadCalls).toBe(0);
    });

    it("does not reload once the player is gone", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const actor = createActor(audioPlaybackActor, {
        input: { audioUrl: NARRATION_URL, volume: 1, playbackRate: 1, startPositionMs: 0 },
      }).start();
      const audio = MockAudio.instances[0]!;
      actor.send({ type: "PLAY" });
      audio.error = { code: 2 };
      audio.onerror?.();

      actor.stop();
      const loadsAtDisposal = audio.loadCalls;
      vi.advanceTimersByTime(60_000);

      expect(audio.loadCalls).toBe(loadsAtDisposal);
      expect(audio.src).toBe("");
    });

    // Removing `src` does not end the element's download; only load() does. Left
    // running, the old lesson's narration shared a slow connection with the next one's.
    it("stops downloading when the player is gone", () => {
      const actor = createActor(audioPlaybackActor, {
        input: { audioUrl: NARRATION_URL, volume: 1, playbackRate: 1, startPositionMs: 0 },
      }).start();
      const audio = MockAudio.instances[0]!;
      actor.send({ type: "PLAY" });

      actor.stop();

      expect(audio.src).toBe("");
      expect(audio.loadCalls).toBe(1);
      expect(audio.paused).toBe(true);
    });

    it("moves to a narration found elsewhere and keeps playing from the same moment", () => {
      pinPerformanceClock();
      const { player } = observePlayback({ audioUrl: NARRATION_URL });
      const audio = MockAudio.instances[0]!;
      player.send({ type: "SEEK", timeMs: 12_000 });
      player.send({ type: "PLAY" });

      // The same narration again: nothing to do.
      player.send({ type: "SET_SOURCE", audioUrl: NARRATION_URL });
      expect(audio.playCalls).toBe(1);

      audio.currentTime = 0;
      player.send({ type: "SET_SOURCE", audioUrl: "https://cdn.example.com/renamed.ogg" });
      expect(audio.src).toBe("https://cdn.example.com/renamed.ogg");
      expect(audio.currentTime).toBe(12);
      expect(audio.playCalls).toBe(2);
    });
  });

  // The timeline is the clock, and it waits for the narration: a lesson on a slow
  // connection used to play on in silence until the whole file had downloaded.
  describe("a replay whose narration is still loading", () => {
    const NARRATION_URL = "https://cdn.example.com/lesson.ogg";

    const loadStreamedLesson = async (overrides: Partial<Recording> = {}) => {
      const actor = createActor(editorMachine, {
        input: { editorRef: { current: null } },
      }).start();
      spawnedActors.push(actor);
      const recording: Recording = {
        ...createRecording(),
        audioUrl: NARRATION_URL,
        ...overrides,
      };
      actor.send({ type: "LOAD_RECORDING", recording });
      await waitFor(actor, (snapshot) => snapshot.matches({ playback: "ready" }));
      const timeline = () => actor.getSnapshot().children.timelineActor!.getSnapshot();
      return { actor, recording, audio: MockAudio.instances[0]!, timeline };
    };

    it("gives the narration a player though none of it is in memory", async () => {
      const { audio } = await loadStreamedLesson();

      expect(audio.src).toBe(NARRATION_URL);
      expect(audio.preload).toBe("none");
      expect(audio.playCalls).toBe(0);
    });

    it("holds the timeline until the narration has sound, then goes on from there", async () => {
      pinPerformanceClock();
      const { actor, audio, timeline } = await loadStreamedLesson();
      audio.readyState = 0;

      actor.send({ type: "PLAY" });

      // Still playing to the viewer; the clock is not counting.
      expect(actor.getSnapshot().matches({ playback: "playing" })).toBe(true);
      expect(actor.getSnapshot().matches({ playback: { playing: "buffering" } })).toBe(true);
      expect(timeline().value).toBe("paused");
      expect(audio.playCalls).toBe(1);

      audio.readyState = 4;
      audio.onplaying?.();

      expect(actor.getSnapshot().matches({ playback: { playing: "running" } })).toBe(true);
      expect(timeline().value).toBe("running");
      expect(timeline().context.currentTime).toBe(0);
      expect(audio.currentTime).toBe(0);
    });

    it("holds again when the download falls behind mid-lesson", async () => {
      const { actor, audio, timeline } = await loadStreamedLesson();
      actor.send({ type: "PLAY" });
      expect(actor.getSnapshot().matches({ playback: { playing: "running" } })).toBe(true);

      audio.readyState = 2;
      audio.onwaiting?.();
      expect(actor.getSnapshot().matches({ playback: { playing: "buffering" } })).toBe(true);
      expect(timeline().value).toBe("paused");

      audio.readyState = 4;
      audio.onplaying?.();
      expect(timeline().value).toBe("running");
    });

    // A learner listening from another tab: no frame is drawn there, so no TICK comes and
    // the machine's copy of the time stays at the moment the tab was hidden, while the
    // clock and the narration go on. The hold stopped both at that old moment, and the
    // learner heard minutes of narration again, at every stall.
    it("holds where the clock is, not where the last drawn frame was", async () => {
      const clock = pinPerformanceClock();
      const { actor, audio, timeline } = await loadStreamedLesson({ duration: 600_000 });
      actor.send({ type: "PLAY" });
      expect(actor.getSnapshot().matches({ playback: { playing: "running" } })).toBe(true);

      // Three minutes of narration with no frame drawn, then the download falls behind.
      clock.now += 180_000;
      audio.currentTime = 180;
      audio.readyState = 2;
      audio.onwaiting?.();

      expect(actor.getSnapshot().matches({ playback: { playing: "buffering" } })).toBe(true);
      expect(timeline().value).toBe("paused");
      expect(timeline().context.currentTime).toBe(180_000);
      expect(actor.getSnapshot().context.timeline.currentTime).toBe(180_000);
      expect(audio.currentTime).toBe(180);

      // The wait is not counted, and both go on from where they stopped.
      clock.now += 30_000;
      audio.readyState = 4;
      audio.onplaying?.();
      expect(timeline().value).toBe("running");
      expect(timeline().context.currentTime).toBe(180_000);
      expect(audio.currentTime).toBe(180);
    });

    // The same out-of-date copy of the time went to the narration as a seek with every
    // chunk of a lesson that was still streaming in.
    it("does not wind the narration back when the lesson grows while no frame is drawn", async () => {
      const clock = pinPerformanceClock();
      const { actor, recording, audio } = await loadStreamedLesson({ duration: 600_000 });
      actor.send({ type: "PLAY" });

      clock.now += 180_000;
      audio.currentTime = 180;
      actor.send({ type: "EXTEND_RECORDING", recording: { ...recording } });

      expect(actor.getSnapshot().matches({ playback: { playing: "running" } })).toBe(true);
      expect(audio.currentTime).toBe(180);
    });

    it("still places the narration when the lesson grows while it is not playing", async () => {
      const { actor, recording, audio } = await loadStreamedLesson();
      actor.send({ type: "SEEK", time: 400 });
      audio.currentTime = 0;

      actor.send({ type: "EXTEND_RECORDING", recording: { ...recording } });

      expect(audio.currentTime).toBe(0.4);
    });

    it("lets the viewer pause and seek while it waits", async () => {
      pinPerformanceClock();
      const { actor, audio, timeline } = await loadStreamedLesson();
      audio.readyState = 0;
      actor.send({ type: "PLAY" });

      actor.send({ type: "SEEK", time: 400 });
      expect(actor.getSnapshot().matches({ playback: { playing: "buffering" } })).toBe(true);
      expect(timeline().context.currentTime).toBe(400);
      expect(audio.currentTime).toBe(0.4);

      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().matches({ playback: "paused" })).toBe(true);
      expect(audio.paused).toBe(true);

      // Played again while the narration is still without data: it waits again.
      actor.send({ type: "PLAY" });
      expect(actor.getSnapshot().matches({ playback: { playing: "buffering" } })).toBe(true);

      audio.readyState = 4;
      audio.onplaying?.();
      expect(timeline().value).toBe("running");
      expect(timeline().context.currentTime).toBe(400);
    });

    it("plays on without a narration that cannot be loaded", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { actor, recording, audio, timeline } = await loadStreamedLesson();
        audio.readyState = 0;
        actor.send({ type: "PLAY" });

        for (const delayMs of [1000, 2000, 4000, 0]) {
          audio.error = { code: 4 };
          audio.onerror?.();
          vi.advanceTimersByTime(delayMs);
        }

        expect(actor.getSnapshot().matches({ playback: { playing: "running" } })).toBe(true);
        expect(timeline().value).toBe("running");
        // It was given up on: the lesson is not held again for another round of reloads.
        expect(audio.loadCalls).toBe(3);

        // Nor when the lesson is still streaming in, which plays the narration again
        // with every chunk.
        actor.send({ type: "EXTEND_RECORDING", recording: { ...recording } });
        expect(actor.getSnapshot().matches({ playback: { playing: "running" } })).toBe(true);
        expect(timeline().value).toBe("running");
        expect(audio.loadCalls).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("moves its player to a narration the loader found under another name", async () => {
      const { actor, recording, audio } = await loadStreamedLesson();

      actor.send({
        type: "EXTEND_RECORDING",
        recording: { ...recording, audioUrl: "https://cdn.example.com/renamed.ogg" },
      });

      expect(MockAudio.instances).toHaveLength(1);
      expect(audio.src).toBe("https://cdn.example.com/renamed.ogg");
    });

    it("does not end a hold when the lesson grows while it waits", async () => {
      const { actor, recording, audio, timeline } = await loadStreamedLesson();
      audio.readyState = 0;
      actor.send({ type: "PLAY" });
      const playsWhileHeld = audio.playCalls;

      actor.send({ type: "EXTEND_RECORDING", recording: { ...recording } });

      expect(actor.getSnapshot().matches({ playback: { playing: "buffering" } })).toBe(true);
      expect(timeline().value).toBe("paused");
      expect(audio.playCalls).toBe(playsWhileHeld);
    });
  });
});
