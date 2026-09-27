import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor } from "xstate";
import { buildScreenCaptureStream, screenRecordingActor } from "./screenActor";

// The duration the recorder measured reaches the WebM header through fixWebmDuration.
const webmDuration = vi.hoisted(() => ({
  fixWebmDuration: vi.fn<(blob: Blob, durationMs: number) => Promise<Blob>>(async (blob) => blob),
}));
vi.mock("../utils/webmDuration", () => webmDuration);

// ---------------------------------------------------------------------------
// Minimal WebRTC/MediaRecorder fakes (jsdom provides none of these).
// ---------------------------------------------------------------------------

class FakeTrack {
  kind: string;
  stopped = false;
  private listeners: Record<string, Array<() => void>> = {};

  constructor(kind: "video" | "audio") {
    this.kind = kind;
  }

  stop() {
    this.stopped = true;
  }

  clone() {
    return new FakeTrack(this.kind as "video" | "audio");
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

class FakeMediaStream {
  private tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = []) {
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

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: "running" | "closed" = "running";
  sourceCount = 0;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamDestination() {
    return { stream: new FakeMediaStream([new FakeTrack("audio")]) };
  }

  createMediaStreamSource(_stream: unknown) {
    this.sourceCount += 1;
    return { connect() {} };
  }

  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

class FakeMediaRecorder {
  static supported = true;
  static instances: FakeMediaRecorder[] = [];

  static isTypeSupported() {
    return FakeMediaRecorder.supported;
  }

  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }

  start(_timeslice?: number) {
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
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["v"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const FakeAudioContextCtor = FakeAudioContext as unknown as typeof AudioContext;

describe("buildScreenCaptureStream", () => {
  const originalMediaStream = Object.getOwnPropertyDescriptor(globalThis, "MediaStream");

  beforeEach(() => {
    FakeAudioContext.instances = [];
    Object.defineProperty(globalThis, "MediaStream", {
      configurable: true,
      value: FakeMediaStream,
    });
  });

  afterEach(() => {
    if (originalMediaStream) {
      Object.defineProperty(globalThis, "MediaStream", originalMediaStream);
    } else {
      delete (globalThis as Record<string, unknown>).MediaStream;
    }
  });

  it("mixes a cloned mic track when display has no audio", () => {
    const display = new FakeMediaStream([new FakeTrack("video")]);
    const mic = new FakeTrack("audio");

    const result = buildScreenCaptureStream(
      display as unknown as MediaStream,
      mic as unknown as MediaStreamTrack,
      {
        audioContextCtor: FakeAudioContextCtor,
      },
    );

    expect(result.audioContext).not.toBeNull();
    expect((result.stream as unknown as FakeMediaStream).getVideoTracks()).toHaveLength(1);
    expect((result.stream as unknown as FakeMediaStream).getAudioTracks()).toHaveLength(1);
    // One source node per audio input: mic only here.
    expect(FakeAudioContext.instances[0]?.sourceCount).toBe(1);
  });

  it("mixes both tab audio and the mic into a single audio track", () => {
    const display = new FakeMediaStream([new FakeTrack("video"), new FakeTrack("audio")]);
    const mic = new FakeTrack("audio");

    const result = buildScreenCaptureStream(
      display as unknown as MediaStream,
      mic as unknown as MediaStreamTrack,
      {
        audioContextCtor: FakeAudioContextCtor,
      },
    );

    expect(result.audioContext).not.toBeNull();
    expect(FakeAudioContext.instances[0]?.sourceCount).toBe(2);
    expect((result.stream as unknown as FakeMediaStream).getAudioTracks()).toHaveLength(1);
  });

  it("uses tab audio alone when there is no mic track", () => {
    const display = new FakeMediaStream([new FakeTrack("video"), new FakeTrack("audio")]);

    const result = buildScreenCaptureStream(display as unknown as MediaStream, null, {
      audioContextCtor: FakeAudioContextCtor,
    });

    expect(result.audioContext).not.toBeNull();
    expect(FakeAudioContext.instances[0]?.sourceCount).toBe(1);
  });

  it("records video-only (no AudioContext) when no audio source exists", () => {
    const display = new FakeMediaStream([new FakeTrack("video")]);

    const result = buildScreenCaptureStream(display as unknown as MediaStream, null, {
      audioContextCtor: FakeAudioContextCtor,
    });

    expect(result.audioContext).toBeNull();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect((result.stream as unknown as FakeMediaStream).getVideoTracks()).toHaveLength(1);
    expect((result.stream as unknown as FakeMediaStream).getAudioTracks()).toHaveLength(0);
  });
});

describe("screenRecordingActor", () => {
  const originalMediaStream = Object.getOwnPropertyDescriptor(globalThis, "MediaStream");
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  let actors: Array<ReturnType<typeof createActor>> = [];

  beforeEach(() => {
    FakeAudioContext.instances = [];
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.supported = true;
    Object.defineProperty(globalThis, "MediaStream", {
      configurable: true,
      value: FakeMediaStream,
    });
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: FakeMediaRecorder,
    });
  });

  afterEach(() => {
    for (const actor of actors) actor.stop();
    actors = [];
    vi.restoreAllMocks();
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
  });

  const spawn = (video: FakeTrack, mic: FakeTrack | null) => {
    const actor = createActor(screenRecordingActor, {
      input: {
        stream: new FakeMediaStream([video]) as unknown as MediaStream,
        micTrack: (mic as unknown as MediaStreamTrack) ?? null,
        audioContextCtor: FakeAudioContextCtor,
        sessionStartedAtPerf: 0,
      },
    }).start();
    actors.push(actor);
    return actor;
  };

  it("stops every owned track and closes the AudioContext on teardown", () => {
    const video = new FakeTrack("video");
    const mic = new FakeTrack("audio");
    const actor = spawn(video, mic);

    actor.send({ type: "START" });
    expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");

    actor.stop();

    expect(video.stopped).toBe(true);
    expect(mic.stopped).toBe(true);
    expect(FakeAudioContext.instances[0]?.state).toBe("closed");
    expect(FakeMediaRecorder.instances[0]?.state).toBe("inactive");
  });

  it("self-stops the recorder when the display track ends (browser 'Stop sharing')", () => {
    const video = new FakeTrack("video");
    const actor = spawn(video, null);

    actor.send({ type: "START" });
    expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");

    video.dispatch("ended");
    expect(FakeMediaRecorder.instances[0]?.state).toBe("inactive");
    expect(video.stopped).toBe(true);
  });

  // The recorder writes nothing while the take is paused, so the length written into the
  // WebM header leaves those spans out too, including one still open when it stops.
  it("leaves the take's pauses out of the recorded duration", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    webmDuration.fixWebmDuration.mockClear();
    const actor = spawn(new FakeTrack("video"), null);

    actor.send({ type: "START" });
    now += 1_000;
    actor.send({ type: "PAUSE" });
    expect(FakeMediaRecorder.instances[0]?.state).toBe("paused");
    now += 5_000;
    actor.send({ type: "RESUME" });
    expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");
    now += 500;
    actor.send({ type: "PAUSE" });
    now += 2_000;
    actor.send({ type: "STOP" });

    // 8.5 s from start to stop, less the 5 s pause and the 2 s one still open.
    expect(webmDuration.fixWebmDuration).toHaveBeenCalledWith(expect.any(Blob), 1_500);
  });

  it("releases owned media when MediaRecorder reports a runtime error", () => {
    const video = new FakeTrack("video");
    const mic = new FakeTrack("audio");
    const actor = spawn(video, mic);

    actor.send({ type: "START" });
    FakeMediaRecorder.instances[0]?.onerror?.(new Event("error"));

    expect(video.stopped).toBe(true);
    expect(mic.stopped).toBe(true);
    expect(FakeAudioContext.instances[0]?.state).toBe("closed");
  });
});
