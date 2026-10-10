import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, waitFor } from "xstate";
import { editorMachine } from "./editorMachine";
import type { AudioRecordingEmit, AudioRecordingEvent, AudioRecordingInput } from "./audioActor";
import { fromTypedCallback } from "./fromTypedCallback";
import type { Recording } from "../types";

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
    await waitFor(actor, (s) => s.matches("recording"));

    expect(
      Object.keys(actor.getSnapshot().children).some((id) => id.startsWith("screenRecorder-")),
    ).toBe(false);
    expect(actor.getSnapshot().context.screen.isRecording).toBe(false);
  });

  it("spawns the screen actor and marks it recording", async () => {
    const actor = start();
    actor.send({ type: "START_RECORDING", screenStream: makeDisplayStream() });
    await waitFor(actor, (s) => s.matches("recording"));

    const screen = actor.getSnapshot().context.screen;
    expect(screen.actorId).toMatch(/^screenRecorder-/);
    expect(actor.getSnapshot().children[screen.actorId!]).toBeDefined();
    expect(screen.isRecording).toBe(true);
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
    await waitFor(actor, (s) => s.matches("recording"));
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
    await waitFor(actor, (s) => s.matches("recording"));
    const screenActorId = actor.getSnapshot().context.screen.actorId!;

    // User clicks the browser's native "Stop sharing".
    videoTrack.dispatch("ended");
    await waitFor(actor, (s) => s.context.screen.isRecording === false);

    expect(ready).toHaveLength(1);
    expect(actor.getSnapshot().matches("recording")).toBe(true); // session unaffected
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
    const ready: boolean[] = [];
    const actor = start({
      enableAudioRecording: true,
      onScreenRecordingReady: (payload) => ready.push(payload.hasAudio),
    });

    actor.send({ type: "START_RECORDING", screenStream: display as unknown as MediaStream });
    await waitFor(actor, (s) => s.matches("recording"));

    // The user ends the share early; the screen recorder tears down and stops its tracks.
    videoTrack.dispatch("ended");
    await waitFor(actor, (s) => s.context.screen.isRecording === false);

    // The microphone is the only audio source, so this shows it reached the mix.
    expect(ready).toEqual([true]);
    expect(micTrack.stopped).toBe(false);
    expect(actor.getSnapshot().matches("recording")).toBe(true);
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
    const dmpCodec = await import("../../dmp/dmpCodec");
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
        audioRecording: fromTypedCallback<
          AudioRecordingEvent,
          AudioRecordingInput,
          AudioRecordingEmit
        >(() => () => {}),
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
    await waitFor(actor, (s) => s.matches("recording"));
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
    await waitFor(actor, (s) => s.matches("recording"));
    await waitFor(actor, (s) => s.context.screen.isRecording === false);

    expect(ready).toHaveLength(0);
    expect(actor.getSnapshot().matches("recording")).toBe(true);
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
    await waitFor(actor, (s) => s.matches("recording"));
    const firstActorId = actor.getSnapshot().context.screen.actorId!;
    const firstRecorder = FakeScreenMediaRecorder.instances[0]!;

    actor.send({ type: "STOP_RECORDING" });
    await waitFor(actor, (s) => s.matches({ playback: "ready" }));
    actor.send({ type: "UNLOAD" });
    await waitFor(actor, (s) => s.value === "idle");

    actor.send({ type: "START_RECORDING", screenStream: makeDisplayStream() });
    await waitFor(actor, (s) => s.matches("recording"));
    const secondActorId = actor.getSnapshot().context.screen.actorId!;
    const secondRecorder = FakeScreenMediaRecorder.instances[1]!;
    expect(secondActorId).not.toBe(firstActorId);
    expect(actor.getSnapshot().children[firstActorId]).toBeDefined();
    expect(actor.getSnapshot().children[secondActorId]).toBeDefined();

    firstRecorder.finishStop();
    await waitFor(actor, (s) => s.children[firstActorId] === undefined);

    expect(ready).toHaveLength(1);
    expect(actor.getSnapshot().matches("recording")).toBe(true);
    expect(actor.getSnapshot().context.screen.actorId).toBe(secondActorId);
    expect(actor.getSnapshot().context.screen.isRecording).toBe(true);
    expect(actor.getSnapshot().children[secondActorId]).toBeDefined();
    expect(secondRecorder.state).toBe("recording");
  });

  it("guardrail: the finalized recording carries no screen fields", async () => {
    const stopped: { value: Recording | null } = { value: null };
    const actor = start({ onRecordingStop: (recording) => (stopped.value = recording) });

    actor.send({ type: "START_RECORDING", screenStream: makeDisplayStream() });
    await waitFor(actor, (s) => s.matches("recording"));
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
