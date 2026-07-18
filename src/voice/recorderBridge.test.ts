import { beforeEach, describe, expect, it } from "vitest";
import {
  applyVoiceRecordingPolicy,
  isVoiceJoinedForRecording,
  resetVoiceRecorderBridgeForTests,
  setVoiceJoinedForRecording,
} from "./recorderBridge";

class FakeTrack {
  kind: string;
  stopped = false;
  private endedListeners: Array<() => void> = [];

  constructor(kind: string) {
    this.kind = kind;
  }

  stop(): void {
    this.stopped = true;
    for (const listener of this.endedListeners) listener();
    this.endedListeners = [];
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "ended") this.endedListeners.push(listener);
  }
}

class FakeStream {
  tracks: FakeTrack[];

  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks;
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }

  removeTrack(track: FakeTrack): void {
    this.tracks = this.tracks.filter((candidate) => candidate !== track);
  }
}

function asStream(stream: FakeStream): MediaStream {
  return stream as unknown as MediaStream;
}

beforeEach(() => {
  resetVoiceRecorderBridgeForTests();
});

describe("voice recorder bridge", () => {
  it("strips display audio outright when voice is already joined", () => {
    setVoiceJoinedForRecording(true);
    const audio = new FakeTrack("audio");
    const video = new FakeTrack("video");
    const stream = new FakeStream([video, audio]);
    applyVoiceRecordingPolicy(asStream(stream));
    expect(audio.stopped).toBe(true);
    expect(stream.tracks).toEqual([video]);
  });

  it("keeps tab audio when voice is not joined", () => {
    const audio = new FakeTrack("audio");
    const video = new FakeTrack("video");
    const stream = new FakeStream([video, audio]);
    applyVoiceRecordingPolicy(asStream(stream));
    expect(audio.stopped).toBe(false);
    expect(stream.tracks).toContain(audio);
  });

  it("stops registered display audio when voice joins mid-recording", () => {
    const audio = new FakeTrack("audio");
    const stream = new FakeStream([new FakeTrack("video"), audio]);
    applyVoiceRecordingPolicy(asStream(stream));
    expect(audio.stopped).toBe(false);

    setVoiceJoinedForRecording(true);
    expect(audio.stopped).toBe(true);
    expect(isVoiceJoinedForRecording()).toBe(true);
  });

  it("never touches video tracks and tolerates repeated transitions", () => {
    const video = new FakeTrack("video");
    const stream = new FakeStream([video]);
    applyVoiceRecordingPolicy(asStream(stream));
    setVoiceJoinedForRecording(true);
    setVoiceJoinedForRecording(false);
    setVoiceJoinedForRecording(true);
    expect(video.stopped).toBe(false);
    expect(stream.tracks).toEqual([video]);
  });

  it("forgets ended tracks so leaving voice cannot resurrect stale state", () => {
    const audio = new FakeTrack("audio");
    const stream = new FakeStream([audio]);
    applyVoiceRecordingPolicy(asStream(stream));
    // The recorder stopped the capture normally (share ended).
    audio.stop();
    audio.stopped = false;
    // A later voice join must not re-stop an unregistered track.
    setVoiceJoinedForRecording(true);
    expect(audio.stopped).toBe(false);
  });

  it("leaving voice re-enables tab audio for future recordings only", () => {
    setVoiceJoinedForRecording(true);
    setVoiceJoinedForRecording(false);
    const audio = new FakeTrack("audio");
    const stream = new FakeStream([audio]);
    applyVoiceRecordingPolicy(asStream(stream));
    expect(audio.stopped).toBe(false);
    expect(isVoiceJoinedForRecording()).toBe(false);
  });
});
