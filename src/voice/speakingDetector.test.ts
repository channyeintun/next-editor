import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

class FakeMediaStream {
  readonly tracks: MediaStreamTrack[];

  constructor(tracks: MediaStreamTrack[]) {
    this.tracks = tracks;
  }
}

// Each analyser plays back whatever level its test sets: 128 is silence, and
// a constant offset from it gives that RMS level.
class FakeAnalyser {
  fftSize = 2048;
  level = 128;
  disconnect = vi.fn<() => void>();

  getByteTimeDomainData(samples: Uint8Array): void {
    samples.fill(this.level);
  }
}

// Starts suspended, as WebKit starts a context made outside a user gesture.
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = "suspended";
  readonly analysers: FakeAnalyser[] = [];
  readonly sources: Array<{ disconnect: () => void }> = [];
  resume = vi.fn<() => Promise<void>>(() => Promise.resolve());
  close = vi.fn<() => Promise<void>>(() => Promise.resolve());

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    const source = { connect: vi.fn<() => void>(), disconnect: vi.fn<() => void>() };
    this.sources.push(source);
    return source;
  }

  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }
}

function fakeTrack(): MediaStreamTrack {
  return { readyState: "live" } as MediaStreamTrack;
}

// The shared context lives in core's module, so each test loads a fresh copy.
async function loadDetector() {
  return import("./speakingDetector");
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaStream", FakeMediaStream);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("speaking detector", () => {
  it("reads the page's one shared context and resumes it now or on the next gesture", async () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const { createSpeakingDetector } = await loadDetector();
    const { resumeSharedAudioContext } = await import("../core/src/utils/audioContext");

    createSpeakingDetector(fakeTrack(), () => undefined);
    createSpeakingDetector(fakeTrack(), () => undefined);

    expect(FakeAudioContext.instances).toHaveLength(1);
    const [context] = FakeAudioContext.instances;
    expect(context.analysers).toHaveLength(2);
    expect(context.resume).toHaveBeenCalled();
    expect(addListener.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(["mousedown", "touchstart", "keydown", "click"]),
    );
    expect(resumeSharedAudioContext()).toBe(context);
  });

  it("disconnects its nodes on stop and never closes the shared context", async () => {
    const { createSpeakingDetector } = await loadDetector();
    const detector = createSpeakingDetector(fakeTrack(), () => undefined);
    const [context] = FakeAudioContext.instances;

    detector.stop();
    detector.stop();

    expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(context.analysers[0].disconnect).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();
  });

  it("returns a no-op detector when the context cannot be created", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new DOMException("too many contexts", "NotSupportedError");
        }
      },
    );
    const { createSpeakingDetector } = await loadDetector();
    const detector = createSpeakingDetector(fakeTrack(), () => undefined);
    expect(() => detector.stop()).not.toThrow();
  });

  it("reports speaking after the attack time and silence after the release time", async () => {
    const { createSpeakingDetector } = await loadDetector();
    vi.useFakeTimers();
    const onChange = vi.fn<(isSpeaking: boolean) => void>();
    const detector = createSpeakingDetector(fakeTrack(), onChange);
    const [analyser] = FakeAudioContext.instances[0].analysers;

    analyser.level = 140;
    vi.advanceTimersByTime(100);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onChange.mock.calls).toEqual([[true]]);

    analyser.level = 128;
    vi.advanceTimersByTime(500);
    expect(onChange.mock.calls).toEqual([[true]]);
    vi.advanceTimersByTime(200);
    expect(onChange.mock.calls).toEqual([[true], [false]]);

    analyser.level = 140;
    vi.advanceTimersByTime(300);
    detector.stop();
    expect(onChange.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(analyser.disconnect).toHaveBeenCalledOnce();
  });
});

describe("resumeSpeakingDetection", () => {
  it("resumes the shared context the detectors read from", async () => {
    const { createSpeakingDetector, resumeSpeakingDetection } = await loadDetector();
    createSpeakingDetector(fakeTrack(), () => undefined);
    const [context] = FakeAudioContext.instances;
    context.resume.mockClear();

    resumeSpeakingDetection();

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(context.resume).toHaveBeenCalledOnce();
  });

  it("does nothing where the page cannot make an AudioContext", async () => {
    vi.stubGlobal("AudioContext", undefined);
    const { resumeSpeakingDetection } = await loadDetector();
    expect(() => resumeSpeakingDetection()).not.toThrow();
  });
});
