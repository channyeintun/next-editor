import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteAudioSink } from "./remoteAudioSink";

class FakeMediaStream {
  private readonly tracks: MediaStreamTrack[];

  constructor(tracks: MediaStreamTrack[]) {
    this.tracks = tracks;
  }

  getTracks(): MediaStreamTrack[] {
    return this.tracks;
  }
}

function fakeTrack() {
  return { stop: vi.fn<() => void>() } as unknown as MediaStreamTrack;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("remote audio sink", () => {
  it("reports a synchronous autoplay failure", () => {
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const element = document.createElement("audio");
    element.play = vi.fn<() => Promise<void>>(() => {
      throw new DOMException("blocked", "NotAllowedError");
    });
    const onBlockedChange = vi.fn<(blocked: boolean) => void>();
    const sink = createRemoteAudioSink({ createElement: () => element, onBlockedChange });

    sink.setTrack(fakeTrack());
    expect(sink.isBlocked()).toBe(true);
    expect(onBlockedChange).toHaveBeenLastCalledWith(true);
    sink.cleanup();
  });

  it("stops replaced tracks and ignores stale play rejections", async () => {
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const element = document.createElement("audio");
    let rejectFirst!: (reason?: unknown) => void;
    const firstPlay = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    element.play = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(firstPlay)
      .mockResolvedValueOnce();
    const onBlockedChange = vi.fn<(blocked: boolean) => void>();
    const sink = createRemoteAudioSink({ createElement: () => element, onBlockedChange });
    const first = fakeTrack();
    const second = fakeTrack();

    sink.setTrack(first);
    sink.setTrack(second);
    await Promise.resolve();
    rejectFirst(new DOMException("stale", "NotAllowedError"));
    await Promise.resolve();

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(sink.currentTrack()).toBe(second);
    expect(sink.isBlocked()).toBe(false);
    expect(onBlockedChange).not.toHaveBeenCalledWith(true);
    sink.cleanup();
    expect(second.stop).toHaveBeenCalledTimes(1);
  });
});
