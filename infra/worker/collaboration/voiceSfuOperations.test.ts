import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MAX_VOICE_TRACKS_PER_CONNECTION,
  type ActivePublication,
  type RealtimeSfuUpstream,
  type ReceivingTrack,
} from "./realtimeSfuGateway";
import {
  closeTracks,
  createSession,
  pushOrPullTracks,
  renegotiate,
  type VoiceSfuAttachment,
  type VoiceSfuAttachmentUpdate,
  type VoiceSfuConnection,
} from "./voiceSfuOperations";

const CALLER_CONNECTION = "0d5f4c72-9a3b-4c1d-8e2f-6a7b8c9d0e1f";
const OTHER_CONNECTION = "1b2c3d4e-5f60-4711-8223-3445566778aa";
const SESSION = "session-abc";

const AUDIO_SDP =
  "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n";

const THEIR_MIC: ActivePublication = {
  ownerVoiceConnectionId: OTHER_CONNECTION,
  sessionId: "session-other",
  trackName: "their-mic",
};

interface FakeAttachment extends VoiceSfuAttachment {
  receivingMids: string[];
  receivingTracks: ReceivingTrack[];
  participantRevision: number;
}

/**
 * A voice connection whose attachment lives in memory. `goOffline` makes the
 * attachment stop reading as live, as a superseded or closed socket does.
 */
function fakeConnection(
  initial: Partial<FakeAttachment>,
  options: { subpath: string; method: string; publications?: ActivePublication[] },
) {
  let stored: FakeAttachment = {
    roomId: "room-1",
    voiceConnectionId: CALLER_CONNECTION,
    sfuSessionId: SESSION,
    publishedTrackName: null,
    publishedMid: null,
    receivingMids: [],
    receivingTracks: [],
    participantRevision: 1,
    ...initial,
  };
  let current = stored;
  let live = true;
  let revision = stored.participantRevision;
  const writes: VoiceSfuAttachmentUpdate[] = [];
  const upserts: FakeAttachment[] = [];
  const outcomes: Array<[string, number]> = [];
  const request = vi.fn<RealtimeSfuUpstream["request"]>();
  const closeUpstreamTracks = vi.fn<RealtimeSfuUpstream["closeTracks"]>(async () => true);
  const conn: VoiceSfuConnection = {
    upstream: { request, closeTracks: closeUpstreamTracks },
    subpath: options.subpath,
    method: options.method,
    current: () => current,
    readLive: () => (live ? stored : null),
    persist: (update) => {
      if (!live) return null;
      const written = update(stored);
      writes.push(written);
      stored = { ...stored, ...written };
      current = stored;
      return current;
    },
    activePublications: () => options.publications ?? [],
    nextRevision: () => ++revision,
    broadcastUpsert: () => {
      upserts.push(current);
    },
    logOutcome: (kind, status) => {
      outcomes.push([kind, status]);
    },
  };
  return {
    conn,
    request,
    closeUpstreamTracks,
    writes,
    upserts,
    outcomes,
    stored: () => stored,
    goOffline: () => {
      live = false;
    },
  };
}

function tracksNew(initial: Partial<FakeAttachment>, publications: ActivePublication[] = []) {
  return fakeConnection(initial, {
    subpath: `/sessions/${SESSION}/tracks/new`,
    method: "POST",
    publications,
  });
}

function pushBody(trackName: string, mid: string) {
  return {
    sessionDescription: { type: "offer", sdp: AUDIO_SDP },
    tracks: [{ location: "local", trackName, mid }],
  };
}

function pullBody(...publications: ActivePublication[]) {
  return {
    tracks: publications.map(({ sessionId, trackName }) => ({
      location: "remote",
      sessionId,
      trackName,
    })),
  };
}

function receivingTrack(mid: string, publication: ActivePublication = THEIR_MIC): ReceivingTrack {
  return { sessionId: publication.sessionId, trackName: publication.trackName, mid };
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSession", () => {
  it("closes and clears a stale publication, announces it, then registers the new session", async () => {
    const fake = fakeConnection(
      {
        sfuSessionId: "session-old",
        publishedTrackName: "mic-track",
        publishedMid: "0",
        receivingMids: ["1"],
        receivingTracks: [receivingTrack("1")],
      },
      { subpath: "/sessions/new", method: "POST" },
    );
    fake.request.mockResolvedValue(Response.json({ sessionId: "session-new" }));

    const response = await createSession(fake.conn);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: "session-new" });
    expect(fake.closeUpstreamTracks).toHaveBeenCalledWith("session-old", ["0", "1"]);
    expect(fake.request).toHaveBeenCalledWith("/sessions/new", "POST", null);
    expect(fake.upserts).toEqual([
      expect.objectContaining({
        sfuSessionId: null,
        publishedTrackName: null,
        publishedMid: null,
        participantRevision: 2,
      }),
    ]);
    expect(fake.stored()).toMatchObject({
      sfuSessionId: "session-new",
      publishedTrackName: null,
      publishedMid: null,
      receivingMids: [],
      receivingTracks: [],
    });
    expect(fake.outcomes).toEqual([["create-session", 200]]);
  });

  it("does not announce replacing a session that published nothing", async () => {
    const fake = fakeConnection(
      { sfuSessionId: "session-old", receivingMids: ["1"], receivingTracks: [receivingTrack("1")] },
      { subpath: "/sessions/new", method: "POST" },
    );
    fake.request.mockResolvedValue(Response.json({ sessionId: "session-new" }));

    expect((await createSession(fake.conn)).status).toBe(200);

    expect(fake.upserts).toEqual([]);
    expect(fake.stored().participantRevision).toBe(1);
  });

  it("keeps the old session when its tracks cannot be closed", async () => {
    const fake = fakeConnection(
      { sfuSessionId: "session-old", publishedTrackName: "mic-track", publishedMid: "0" },
      { subpath: "/sessions/new", method: "POST" },
    );
    fake.closeUpstreamTracks.mockResolvedValue(false);

    const response = await createSession(fake.conn);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "sfu-unavailable" });
    expect(consoleError).toHaveBeenCalledWith(
      "collaboration_voice_sfu_upstream_failed",
      expect.objectContaining({ kind: "replace-session" }),
    );
    expect(fake.request).not.toHaveBeenCalled();
    expect(fake.writes).toEqual([]);
  });
});

describe("pushOrPullTracks: push", () => {
  it("closes the published mid of a retried publication before publishing its replacement", async () => {
    const fake = tracksNew({ publishedTrackName: "mic-track", publishedMid: "0" });
    fake.request.mockResolvedValue(
      Response.json({
        sessionDescription: { type: "answer", sdp: AUDIO_SDP },
        tracks: [{ trackName: "mic-track", mid: "1" }],
      }),
    );

    const response = await pushOrPullTracks(fake.conn, SESSION, pushBody("mic-track", "1"));

    expect(response.status).toBe(200);
    expect(fake.closeUpstreamTracks).toHaveBeenCalledWith(SESSION, ["0"]);
    expect(fake.closeUpstreamTracks.mock.invocationCallOrder[0]).toBeLessThan(
      fake.request.mock.invocationCallOrder[0],
    );
    expect(fake.request).toHaveBeenCalledWith(
      `/sessions/${SESSION}/tracks/new`,
      "POST",
      pushBody("mic-track", "1"),
    );
    expect(fake.upserts).toEqual([
      expect.objectContaining({ publishedTrackName: null, publishedMid: null }),
      expect.objectContaining({ publishedTrackName: "mic-track", publishedMid: "1" }),
    ]);
    expect(fake.stored()).toMatchObject({ publishedTrackName: "mic-track", publishedMid: "1" });
    expect(fake.outcomes).toEqual([["push-tracks", 200]]);
  });

  it("fails as replace-published-track when the published mid will not close", async () => {
    const fake = tracksNew({ publishedTrackName: "mic-track", publishedMid: "0" });
    fake.closeUpstreamTracks.mockResolvedValue(false);

    const response = await pushOrPullTracks(fake.conn, SESSION, pushBody("mic-track", "1"));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "sfu-unavailable" });
    expect(consoleError).toHaveBeenCalledWith(
      "collaboration_voice_sfu_upstream_failed",
      expect.objectContaining({ roomId: "room-1", kind: "replace-published-track" }),
    );
    expect(fake.request).not.toHaveBeenCalled();
    expect(fake.writes).toEqual([]);
  });

  it("rejects a second, differently named publication", async () => {
    const fake = tracksNew({ publishedTrackName: "mic-track", publishedMid: "0" });

    const response = await pushOrPullTracks(fake.conn, SESSION, pushBody("other-track", "1"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already publishing" });
    expect(fake.outcomes).toEqual([["push-tracks", 409]]);
    expect(fake.request).not.toHaveBeenCalled();
  });
});

describe("pushOrPullTracks: pull", () => {
  it("rejects a track no other live connection publishes", async () => {
    const fake = tracksNew({});

    const response = await pushOrPullTracks(fake.conn, SESSION, pullBody(THEIR_MIC));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "unknown track" });
    expect(fake.outcomes).toEqual([["pull-tracks", 403]]);
    expect(fake.request).not.toHaveBeenCalled();
    expect(fake.writes).toEqual([]);
  });

  it("rejects a pull past the per-connection subscription cap", async () => {
    const fake = tracksNew(
      {
        receivingMids: Array.from({ length: MAX_VOICE_TRACKS_PER_CONNECTION }, (_, index) =>
          String(index),
        ),
      },
      [THEIR_MIC],
    );

    const response = await pushOrPullTracks(fake.conn, SESSION, pullBody(THEIR_MIC));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "subscription limit reached" });
    expect(fake.request).not.toHaveBeenCalled();
    expect(fake.writes).toEqual([]);
  });

  it("accepts a retry of a track it already receives, replacing the old mid", async () => {
    const fake = tracksNew({ receivingMids: ["3"], receivingTracks: [receivingTrack("3")] }, [
      THEIR_MIC,
    ]);
    fake.request.mockResolvedValue(
      Response.json({
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "offer", sdp: AUDIO_SDP },
        tracks: [{ sessionId: THEIR_MIC.sessionId, trackName: THEIR_MIC.trackName, mid: "4" }],
      }),
    );

    const response = await pushOrPullTracks(fake.conn, SESSION, pullBody(THEIR_MIC));

    expect(response.status).toBe(200);
    expect(fake.closeUpstreamTracks).toHaveBeenCalledWith(SESSION, ["3"]);
    expect(fake.stored()).toMatchObject({
      receivingMids: ["4"],
      receivingTracks: [receivingTrack("4")],
    });
    expect(fake.upserts).toEqual([]);
    expect(fake.outcomes).toEqual([["pull-tracks", 200]]);
  });

  it("rejects a tracks/new body that is neither a push nor a pull", async () => {
    const fake = tracksNew({});

    const response = await pushOrPullTracks(fake.conn, SESSION, { tracks: [] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid request" });
    expect(fake.outcomes).toEqual([["push-tracks", 400]]);
  });
});

describe("closeTracks", () => {
  function publishingConnection() {
    return fakeConnection(
      {
        publishedTrackName: "mic-track",
        publishedMid: "0",
        receivingMids: ["1", "2"],
        receivingTracks: [
          receivingTrack("1"),
          receivingTrack("2", { ...THEIR_MIC, trackName: "their-screen" }),
        ],
      },
      { subpath: `/sessions/${SESSION}/tracks/close`, method: "PUT" },
    );
  }

  it("clears a closed publication and the closed received mids, then announces", async () => {
    const fake = publishingConnection();
    fake.request.mockResolvedValue(Response.json({ tracks: [{ mid: "0" }, { mid: "1" }] }));

    const response = await closeTracks(fake.conn, SESSION, {
      tracks: [{ mid: "0" }, { mid: "1" }],
      force: true,
    });

    expect(response.status).toBe(200);
    expect(fake.stored()).toMatchObject({
      publishedTrackName: null,
      publishedMid: null,
      receivingMids: ["2"],
      receivingTracks: [receivingTrack("2", { ...THEIR_MIC, trackName: "their-screen" })],
      participantRevision: 2,
    });
    expect(fake.upserts).toEqual([expect.objectContaining({ publishedMid: null })]);
    expect(fake.outcomes).toEqual([["close-tracks", 200]]);
  });

  it("does not announce when only received tracks closed", async () => {
    const fake = publishingConnection();
    fake.request.mockResolvedValue(Response.json({ tracks: [{ mid: "1" }] }));

    const response = await closeTracks(fake.conn, SESSION, { tracks: [{ mid: "1" }], force: true });

    expect(response.status).toBe(200);
    expect(fake.stored()).toMatchObject({
      publishedTrackName: "mic-track",
      publishedMid: "0",
      receivingMids: ["2"],
      participantRevision: 1,
    });
    expect(fake.upserts).toEqual([]);
  });

  it("rejects a mid the connection does not own", async () => {
    const fake = publishingConnection();

    const response = await closeTracks(fake.conn, SESSION, { tracks: [{ mid: "9" }], force: true });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "unknown mid" });
    expect(fake.request).not.toHaveBeenCalled();
  });
});

describe("renegotiate", () => {
  it("rejects a session the connection does not own", async () => {
    const fake = fakeConnection(
      {},
      { subpath: "/sessions/session-other/renegotiate", method: "PUT" },
    );

    const response = await renegotiate(fake.conn, "session-other", {
      sessionDescription: { type: "answer", sdp: AUDIO_SDP },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "unknown session" });
    expect(fake.outcomes).toEqual([["renegotiate", 403]]);
    expect(fake.request).not.toHaveBeenCalled();
  });
});

describe("a connection that stops being live mid-request", () => {
  async function expectUnauthorized(response: Response, fake: { writes: unknown[] }) {
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(fake.writes).toEqual([]);
  }

  it("create-session does not register the new session", async () => {
    const fake = fakeConnection(
      { sfuSessionId: null },
      { subpath: "/sessions/new", method: "POST" },
    );
    fake.request.mockImplementation(async () => {
      fake.goOffline();
      return Response.json({ sessionId: "session-new" });
    });

    await expectUnauthorized(await createSession(fake.conn), fake);
    expect(fake.stored().sfuSessionId).toBeNull();
  });

  it("create-session stops when the stale session cannot be cleared", async () => {
    const fake = fakeConnection(
      { sfuSessionId: "session-old" },
      { subpath: "/sessions/new", method: "POST" },
    );
    fake.closeUpstreamTracks.mockImplementation(async () => {
      fake.goOffline();
      return true;
    });

    await expectUnauthorized(await createSession(fake.conn), fake);
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("push closes the track it just published instead of registering it", async () => {
    const fake = tracksNew({});
    fake.request.mockImplementation(async () => {
      fake.goOffline();
      return Response.json({
        sessionDescription: { type: "answer", sdp: AUDIO_SDP },
        tracks: [{ trackName: "mic-track", mid: "1" }],
      });
    });

    await expectUnauthorized(
      await pushOrPullTracks(fake.conn, SESSION, pushBody("mic-track", "1")),
      fake,
    );
    expect(fake.closeUpstreamTracks).toHaveBeenCalledWith(SESSION, ["1"]);
    expect(fake.upserts).toEqual([]);
  });

  it("pull closes the tracks it just pulled instead of registering them", async () => {
    const fake = tracksNew({}, [THEIR_MIC]);
    fake.request.mockImplementation(async () => {
      fake.goOffline();
      return Response.json({
        sessionDescription: { type: "offer", sdp: AUDIO_SDP },
        tracks: [{ sessionId: THEIR_MIC.sessionId, trackName: THEIR_MIC.trackName, mid: "4" }],
      });
    });

    await expectUnauthorized(await pushOrPullTracks(fake.conn, SESSION, pullBody(THEIR_MIC)), fake);
    expect(fake.closeUpstreamTracks).toHaveBeenCalledWith(SESSION, ["4"]);
  });

  it("renegotiate does not report success", async () => {
    const fake = fakeConnection({}, { subpath: `/sessions/${SESSION}/renegotiate`, method: "PUT" });
    fake.request.mockImplementation(async () => {
      fake.goOffline();
      return Response.json({});
    });

    await expectUnauthorized(
      await renegotiate(fake.conn, SESSION, {
        sessionDescription: { type: "answer", sdp: AUDIO_SDP },
      }),
      fake,
    );
    expect(fake.outcomes).toEqual([]);
  });

  it("close-tracks does not update ownership", async () => {
    const fake = fakeConnection(
      { publishedTrackName: "mic-track", publishedMid: "0" },
      { subpath: `/sessions/${SESSION}/tracks/close`, method: "PUT" },
    );
    fake.request.mockImplementation(async () => {
      fake.goOffline();
      return Response.json({ tracks: [{ mid: "0" }] });
    });

    await expectUnauthorized(
      await closeTracks(fake.conn, SESSION, { tracks: [{ mid: "0" }], force: true }),
      fake,
    );
    expect(fake.upserts).toEqual([]);
  });
});
