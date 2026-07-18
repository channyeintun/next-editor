import { describe, expect, it, vi } from "vitest";
import type { VoiceParticipant, VoicePublishedTrack } from "../collaboration/voiceProtocol";
import { VoiceEngine, type VoiceEngineDeps } from "./engine";
import type { VoiceSocketLike } from "./client";
import type { VoiceMediaSession, VoiceMediaSessionConfig } from "./partyTracksAdapter";
import type { RemoteAudioSink } from "./remoteAudioSink";

const ROOM_ID = "0d5f4c72-9a3b-4c1d-8e2f-6a7b8c9d0e1f";
const COLLAB_SESSION_ID = "1b2c3d4e-5f60-4711-8223-3445566778aa";
const SELF_CONNECTION_ID = "2c3d4e5f-6071-4822-9334-455667788bb0";
const REMOTE_CONNECTION_ID = "3d4e5f60-7182-4933-a445-566778899cc1";
const REMOTE_USER_ID = "4e5f6071-8293-4a44-b556-677889900dd2";
const CAPABILITY = "A".repeat(43);

type Listener = (event: { data?: unknown; code?: number }) => void;

class MockSocket implements VoiceSocketLike {
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(type: string, event: { data?: unknown; code?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  sentMessages(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

class MockMediaSession implements VoiceMediaSession {
  publishCalls = 0;
  releaseCalls = 0;
  resumeCalls = 0;
  closeCalls = 0;
  pulls: Array<{
    track: VoicePublishedTrack;
    closed: boolean;
    listeners: Array<(t: MediaStreamTrack) => void>;
  }> = [];
  publishResult: Promise<VoicePublishedTrack> = Promise.resolve({
    sessionId: "sfu-session-self",
    trackName: "self-track",
    location: "remote",
  });
  micTrackListeners: Array<(track: MediaStreamTrack | null) => void> = [];
  micErrorListeners: Array<(error: Error) => void> = [];

  publishMicrophone(): Promise<VoicePublishedTrack> {
    this.publishCalls += 1;
    return this.publishResult;
  }

  muteAndReleaseMicrophone(): void {
    this.releaseCalls += 1;
  }

  resumeBroadcasting(): void {
    this.resumeCalls += 1;
  }

  onMicrophoneTrack(listener: (track: MediaStreamTrack | null) => void): void {
    this.micTrackListeners.push(listener);
  }

  onMicrophoneError(listener: (error: Error) => void): void {
    this.micErrorListeners.push(listener);
  }

  pullTrack(track: VoicePublishedTrack) {
    const entry = {
      track,
      closed: false,
      listeners: [] as Array<(t: MediaStreamTrack) => void>,
    };
    this.pulls.push(entry);
    return {
      onTrack: (listener: (t: MediaStreamTrack) => void) => {
        entry.listeners.push(listener);
      },
      close: () => {
        entry.closed = true;
      },
    };
  }

  createSink(): never {
    throw new Error("not used in tests");
  }

  onConnectionState(): void {}

  close(): void {
    this.closeCalls += 1;
  }
}

class MockSink implements RemoteAudioSink {
  tracks: Array<MediaStreamTrack | null> = [];
  cleanups = 0;
  retries = 0;
  blocked = false;

  setTrack(track: MediaStreamTrack | null): void {
    this.tracks.push(track);
  }

  currentTrack(): MediaStreamTrack | null {
    return this.tracks.at(-1) ?? null;
  }

  isBlocked(): boolean {
    return this.blocked;
  }

  retryPlayback(): void {
    this.retries += 1;
  }

  cleanup(): void {
    this.cleanups += 1;
  }
}

function createHarness() {
  const sockets: MockSocket[] = [];
  const mediaSessions: MockMediaSession[] = [];
  const mediaConfigs: VoiceMediaSessionConfig[] = [];
  const sinks: MockSink[] = [];
  const detectors: Array<{ stopped: boolean }> = [];
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];

  const deps: VoiceEngineDeps = {
    createSocket: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    createMediaSession: (config) => {
      mediaConfigs.push(config);
      const media = new MockMediaSession();
      mediaSessions.push(media);
      return media;
    },
    createSink: () => {
      const sink = new MockSink();
      sinks.push(sink);
      return sink;
    },
    createSpeakingDetector: () => {
      const detector = { stopped: false };
      detectors.push(detector);
      return {
        stop: () => {
          detector.stopped = true;
        },
      };
    },
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as { cleared: boolean }).cleared = true;
    },
  };

  const engine = new VoiceEngine(
    { roomId: ROOM_ID, collaborationSessionId: COLLAB_SESSION_ID },
    deps,
  );
  engine.setAvailability(null);
  return { engine, sockets, mediaSessions, mediaConfigs, sinks, detectors, timers };
}

function remoteParticipant(overrides: Partial<VoiceParticipant> = {}): VoiceParticipant {
  return {
    voiceConnectionId: REMOTE_CONNECTION_ID,
    collaborationSessionId: "5f607182-93a4-4b55-8667-788990011ee3",
    userId: REMOTE_USER_ID,
    displayName: "Remote",
    role: "editor",
    muted: false,
    publishedTrack: {
      sessionId: "sfu-session-remote",
      trackName: "remote-track",
      location: "remote",
    },
    revision: 1,
    ...overrides,
  };
}

function selfParticipant(): VoiceParticipant {
  return {
    voiceConnectionId: SELF_CONNECTION_ID,
    collaborationSessionId: COLLAB_SESSION_ID,
    userId: "60718293-a4b5-4c66-9778-899001122ff4",
    displayName: "Self",
    role: "owner",
    muted: true,
    publishedTrack: null,
    revision: 1,
  };
}

function sendReady(socket: MockSocket): void {
  socket.emit("open");
  socket.emit("message", {
    data: JSON.stringify({
      type: "voice.ready",
      version: 1,
      voiceConnectionId: SELF_CONNECTION_ID,
      capability: CAPABILITY,
      limits: {
        maxParticipants: 10,
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      },
    }),
  });
}

function sendSnapshot(socket: MockSocket, participants: VoiceParticipant[], revision = 1): void {
  socket.emit("message", {
    data: JSON.stringify({ type: "voice.snapshot", version: 1, revision, participants }),
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("voice engine join", () => {
  it("joins in listening mode without acquiring the microphone", () => {
    const harness = createHarness();
    harness.engine.join();
    expect(harness.engine.getUiState().state).toBe("joining");
    expect(harness.sockets).toHaveLength(1);
    expect(harness.mediaSessions).toHaveLength(0);

    sendReady(harness.sockets[0]);
    expect(harness.mediaSessions).toHaveLength(1);
    sendSnapshot(harness.sockets[0], [selfParticipant()]);

    expect(harness.engine.getUiState().state).toBe("listening");
    // No microphone acquisition of any kind happened.
    expect(harness.mediaSessions[0].publishCalls).toBe(0);
    expect(harness.detectors).toHaveLength(0);
  });

  it("configures the media session with the room-scoped gateway and capability header", () => {
    const harness = createHarness();
    harness.engine.join();
    sendReady(harness.sockets[0]);
    const config = harness.mediaConfigs[0];
    expect(config.prefix).toBe(`/api/collaboration/rooms/${ROOM_ID}/voice/sfu`);
    expect(config.apiExtraParams).toContain(`voiceConnectionId=${SELF_CONNECTION_ID}`);
    expect(config.apiExtraParams).toContain(`collaborationSessionId=${COLLAB_SESSION_ID}`);
    expect(config.capability).toBe(CAPABILITY);
    expect(config.capabilityHeaderName).toBe("X-Voice-Capability");
    expect(config.iceServers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
  });

  it("subscribes to remote publications but never to its own", () => {
    const harness = createHarness();
    harness.engine.join();
    sendReady(harness.sockets[0]);
    sendSnapshot(harness.sockets[0], [selfParticipant(), remoteParticipant()]);

    const media = harness.mediaSessions[0];
    expect(media.pulls).toHaveLength(1);
    expect(media.pulls[0].track.trackName).toBe("remote-track");
    expect(harness.sinks).toHaveLength(1);
  });
});

describe("voice engine unmute/mute", () => {
  async function joinListening(harness: ReturnType<typeof createHarness>) {
    harness.engine.join();
    sendReady(harness.sockets[0]);
    sendSnapshot(harness.sockets[0], [selfParticipant()]);
    await flush();
  }

  it("publishes once on unmute and reports live with a mute-changed frame", async () => {
    const harness = createHarness();
    await joinListening(harness);
    harness.engine.unmute();
    expect(harness.engine.getUiState().state).toBe("unmuting");
    await flush();
    expect(harness.engine.getUiState().state).toBe("live");
    expect(harness.mediaSessions[0].publishCalls).toBe(1);
    const muteFrames = harness.sockets[0]
      .sentMessages()
      .filter((message) => message["type"] === "voice.mute-changed");
    expect(muteFrames).toEqual([
      { type: "voice.mute-changed", version: 1, revision: 1, muted: false },
    ]);
  });

  it("stays listening with an actionable error when permission is denied", async () => {
    const harness = createHarness();
    await joinListening(harness);
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    harness.mediaSessions[0].publishResult = Promise.reject(denied);
    harness.engine.unmute();
    await flush();
    const state = harness.engine.getUiState();
    expect(state.state).toBe("listening");
    expect(state.errorCode).toBe("microphone-permission-denied");
    expect(harness.mediaSessions[0].releaseCalls).toBe(1);
  });

  it("releases the physical capture on mute and keeps voice joined", async () => {
    const harness = createHarness();
    await joinListening(harness);
    harness.engine.unmute();
    await flush();
    harness.engine.mute();
    const media = harness.mediaSessions[0];
    expect(media.releaseCalls).toBe(1);
    expect(harness.engine.getUiState().state).toBe("listening");
    const muteFrames = harness.sockets[0]
      .sentMessages()
      .filter((message) => message["type"] === "voice.mute-changed");
    expect(muteFrames.at(-1)).toEqual({
      type: "voice.mute-changed",
      version: 1,
      revision: 2,
      muted: true,
    });
  });

  it("degrades to listening when the device fails while live", async () => {
    const harness = createHarness();
    await joinListening(harness);
    harness.engine.unmute();
    await flush();
    expect(harness.engine.getUiState().state).toBe("live");
    for (const listener of harness.mediaSessions[0].micErrorListeners) {
      listener(new Error("device lost"));
    }
    const state = harness.engine.getUiState();
    expect(state.state).toBe("listening");
    expect(state.errorCode).toBe("microphone-unavailable");
    expect(harness.mediaSessions[0].releaseCalls).toBeGreaterThan(0);
  });
});

describe("voice engine roster", () => {
  function joinWithRemote(harness: ReturnType<typeof createHarness>) {
    harness.engine.join();
    sendReady(harness.sockets[0]);
    sendSnapshot(harness.sockets[0], [selfParticipant(), remoteParticipant()]);
  }

  it("removes the sink when a participant leaves", () => {
    const harness = createHarness();
    joinWithRemote(harness);
    harness.sockets[0].emit("message", {
      data: JSON.stringify({
        type: "voice.participant-left",
        version: 1,
        revision: 2,
        voiceConnectionId: REMOTE_CONNECTION_ID,
      }),
    });
    expect(harness.sinks[0].cleanups).toBe(1);
    expect(harness.mediaSessions[0].pulls[0].closed).toBe(true);
    expect(harness.engine.getUiState().roster).toHaveLength(1);
  });

  it("ignores stale revisions", () => {
    const harness = createHarness();
    joinWithRemote(harness);
    harness.sockets[0].emit("message", {
      data: JSON.stringify({
        type: "voice.participant-upsert",
        version: 1,
        revision: 1,
        participant: remoteParticipant({ muted: true, revision: 1 }),
      }),
    });
    const remote = harness.engine
      .getUiState()
      .roster.find((entry) => entry.participant.voiceConnectionId === REMOTE_CONNECTION_ID);
    expect(remote?.participant.muted).toBe(false);
  });

  it("replaces the subscription when track metadata changes", () => {
    const harness = createHarness();
    joinWithRemote(harness);
    harness.sockets[0].emit("message", {
      data: JSON.stringify({
        type: "voice.participant-upsert",
        version: 1,
        revision: 2,
        participant: remoteParticipant({
          publishedTrack: {
            sessionId: "sfu-session-remote",
            trackName: "remote-track-2",
            location: "remote",
          },
          revision: 2,
        }),
      }),
    });
    const media = harness.mediaSessions[0];
    expect(media.pulls).toHaveLength(2);
    expect(media.pulls[0].closed).toBe(true);
    expect(harness.sinks[0].cleanups).toBe(1);
    expect(harness.sinks).toHaveLength(2);
  });
});

describe("voice engine cleanup", () => {
  it("leaves with complete resource teardown", async () => {
    const harness = createHarness();
    harness.engine.join();
    sendReady(harness.sockets[0]);
    sendSnapshot(harness.sockets[0], [selfParticipant(), remoteParticipant()]);
    harness.engine.unmute();
    await flush();

    harness.engine.leave();
    const state = harness.engine.getUiState();
    expect(state.state).toBe("idle");
    expect(state.roster).toHaveLength(0);
    expect(harness.mediaSessions[0].closeCalls).toBe(1);
    expect(harness.sinks[0].cleanups).toBe(1);
    expect(harness.sockets[0].readyState).toBe(3);
    for (const detector of harness.detectors) expect(detector.stopped).toBe(true);
    const leaveFrames = harness.sockets[0]
      .sentMessages()
      .filter((message) => message["type"] === "voice.leave");
    expect(leaveFrames).toHaveLength(1);
  });

  it("tolerates repeated leave and dispose", () => {
    const harness = createHarness();
    harness.engine.join();
    sendReady(harness.sockets[0]);
    sendSnapshot(harness.sockets[0], [selfParticipant()]);
    harness.engine.leave();
    harness.engine.leave();
    harness.engine.dispose();
    harness.engine.dispose();
    expect(harness.mediaSessions[0].closeCalls).toBe(1);
  });

  it("tears down on server room-closed", () => {
    const harness = createHarness();
    harness.engine.join();
    sendReady(harness.sockets[0]);
    sendSnapshot(harness.sockets[0], [selfParticipant(), remoteParticipant()]);
    harness.sockets[0].emit("message", {
      data: JSON.stringify({ type: "voice.room-closed", version: 1, reason: "member-removed" }),
    });
    expect(harness.engine.getUiState().state).toBe("idle");
    expect(harness.sinks[0].cleanups).toBe(1);
    expect(harness.mediaSessions[0].closeCalls).toBe(1);
  });
});

describe("voice engine reconnect", () => {
  it("schedules bounded reconnects and fails after the limit", () => {
    const harness = createHarness();
    harness.engine.join();
    sendReady(harness.sockets[0]);
    sendSnapshot(harness.sockets[0], [selfParticipant()]);

    // Four bounded attempts, then terminal failure.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      harness.sockets[attempt].emit("close", { code: 1006 });
      expect(harness.engine.getUiState().state).toBe("reconnecting");
      const timer = harness.timers[attempt];
      expect(timer).toBeDefined();
      timer.callback();
      expect(harness.sockets).toHaveLength(attempt + 2);
    }
    harness.sockets[4].emit("close", { code: 1006 });
    expect(harness.engine.getUiState().state).toBe("failed");
    expect(harness.engine.getUiState().errorCode).toBe("network");
    // Failure released the media session.
    expect(harness.mediaSessions[0].closeCalls).toBe(1);
  });

  it("recovers a new generation with a fresh media session and roster", () => {
    const harness = createHarness();
    harness.engine.join();
    sendReady(harness.sockets[0]);
    sendSnapshot(harness.sockets[0], [selfParticipant(), remoteParticipant()]);
    harness.sockets[0].emit("close", { code: 1006 });
    expect(harness.engine.getUiState().state).toBe("reconnecting");
    harness.timers[0].callback();

    const socket = harness.sockets[1];
    sendReady(socket);
    // Old media generation was replaced.
    expect(harness.mediaSessions[0].closeCalls).toBe(1);
    expect(harness.mediaSessions).toHaveLength(2);
    sendSnapshot(socket, [selfParticipant(), remoteParticipant()], 5);
    expect(harness.engine.getUiState().state).toBe("listening");
    // Remote subscription re-created on the new media session.
    expect(harness.mediaSessions[1].pulls).toHaveLength(1);
    // No microphone was acquired on recovery because the user was muted.
    expect(harness.mediaSessions[1].publishCalls).toBe(0);
  });
});

describe("voice engine autoplay", () => {
  it("retries every sink on enableAudio", () => {
    const harness = createHarness();
    harness.engine.join();
    sendReady(harness.sockets[0]);
    sendSnapshot(harness.sockets[0], [selfParticipant(), remoteParticipant()]);
    harness.engine.enableAudio();
    expect(harness.sinks[0].retries).toBe(1);
  });

  it("reflects blocked sinks in the ui state", () => {
    const harness = createHarness();
    harness.engine.join();
    sendReady(harness.sockets[0]);
    sendSnapshot(harness.sockets[0], [selfParticipant(), remoteParticipant()]);
    harness.sinks[0].blocked = true;
    const notify = vi.fn<() => void>();
    harness.engine.subscribe(notify);
    // Any roster change rebuilds the ui snapshot.
    harness.sockets[0].emit("message", {
      data: JSON.stringify({
        type: "voice.participant-upsert",
        version: 1,
        revision: 3,
        participant: remoteParticipant({ muted: true, revision: 3 }),
      }),
    });
    expect(harness.engine.getUiState().autoplayBlocked).toBe(true);
  });
});
