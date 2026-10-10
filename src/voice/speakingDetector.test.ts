import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createSpeakingDetector } from "./speakingDetector";

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

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly analysers: FakeAnalyser[] = [];
  close = vi.fn<() => Promise<void>>(() => Promise.resolve());

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    return { connect: vi.fn<() => void>(), disconnect: vi.fn<() => void>() };
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

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaStream", FakeMediaStream);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("speaking detector", () => {
  it("shares one AudioContext and closes it when the last detector stops", () => {
    const first = createSpeakingDetector(fakeTrack(), () => undefined);
    const second = createSpeakingDetector(fakeTrack(), () => undefined);
    expect(FakeAudioContext.instances).toHaveLength(1);
    const [context] = FakeAudioContext.instances;
    expect(context.analysers).toHaveLength(2);

    first.stop();
    expect(context.close).not.toHaveBeenCalled();
    // A repeated stop does not release the context on the other's behalf.
    first.stop();
    expect(context.close).not.toHaveBeenCalled();

    second.stop();
    expect(context.close).toHaveBeenCalledOnce();

    const third = createSpeakingDetector(fakeTrack(), () => undefined);
    expect(FakeAudioContext.instances).toHaveLength(2);
    third.stop();
    expect(FakeAudioContext.instances[1].close).toHaveBeenCalledOnce();
  });

  it("returns a no-op detector when the context cannot be created", () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new DOMException("too many contexts", "NotSupportedError");
        }
      },
    );
    const detector = createSpeakingDetector(fakeTrack(), () => undefined);
    expect(() => detector.stop()).not.toThrow();
  });

  it("reports speaking after the attack time and silence after the release time", () => {
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
