import { describe, expect, it } from "vitest";
import {
  authorizeCloseTracks,
  authorizePullTracks,
  authorizePushTracks,
  authorizeSessionScoped,
  buildUpstreamSfuUrl,
  closeTracksRequestSchema,
  parseVoiceSfuOperation,
  pullTracksRequestSchema,
  pushTracksRequestSchema,
  renegotiateRequestSchema,
  upstreamNewSessionResponseSchema,
  upstreamTracksResponseSchema,
  VoiceSfuRequestQueue,
  type ActivePublication,
  type VoiceConnectionSfuState,
} from "./realtimeSfuGateway";

const CALLER_CONNECTION = "0d5f4c72-9a3b-4c1d-8e2f-6a7b8c9d0e1f";
const OTHER_CONNECTION = "1b2c3d4e-5f60-4711-8223-3445566778aa";

const AUDIO_SDP =
  "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n";
const VIDEO_SDP =
  "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n";

const idleState: VoiceConnectionSfuState = {
  sfuSessionId: null,
  publishedTrackName: null,
  publishedMid: null,
  receivingMids: [],
  receivingTracks: [],
};

const connectedState: VoiceConnectionSfuState = {
  ...idleState,
  sfuSessionId: "session-abc",
};

const publishingState: VoiceConnectionSfuState = {
  ...connectedState,
  publishedTrackName: "mic-track",
  publishedMid: "1",
  receivingMids: ["2", "3"],
};

const publications: ActivePublication[] = [
  { ownerVoiceConnectionId: OTHER_CONNECTION, sessionId: "session-other", trackName: "their-mic" },
  { ownerVoiceConnectionId: CALLER_CONNECTION, sessionId: "session-abc", trackName: "mic-track" },
];

describe("SFU operation parsing", () => {
  it("recognizes only the supported operations", () => {
    expect(parseVoiceSfuOperation("POST", "/sessions/new")).toEqual({ kind: "create-session" });
    expect(parseVoiceSfuOperation("GET", "/generate-ice-servers")).toEqual({ kind: "ice-servers" });
    expect(parseVoiceSfuOperation("POST", "/sessions/abc/tracks/new")).toEqual({
      kind: "push-tracks",
      sessionId: "abc",
    });
    expect(parseVoiceSfuOperation("PUT", "/sessions/abc/renegotiate")).toEqual({
      kind: "renegotiate",
      sessionId: "abc",
    });
    expect(parseVoiceSfuOperation("PUT", "/sessions/abc/tracks/close")).toEqual({
      kind: "close-tracks",
      sessionId: "abc",
    });
  });

  it("fails closed for session reads, track updates, and unknown paths", () => {
    expect(parseVoiceSfuOperation("GET", "/sessions/abc")).toBeNull();
    expect(parseVoiceSfuOperation("PUT", "/sessions/abc/tracks/update")).toBeNull();
    expect(parseVoiceSfuOperation("DELETE", "/sessions/abc/tracks/close")).toBeNull();
    expect(parseVoiceSfuOperation("POST", "/apps/evil/sessions/new")).toBeNull();
    expect(parseVoiceSfuOperation("POST", "/sessions/../../other/tracks/new")).toBeNull();
    expect(parseVoiceSfuOperation("POST", "/sessions/new/extra")).toBeNull();
  });
});

describe("request schemas", () => {
  it("accepts a single-track audio push", () => {
    const body = {
      sessionDescription: { type: "offer", sdp: AUDIO_SDP },
      tracks: [{ location: "local", trackName: "mic-track", mid: "1" }],
    };
    expect(pushTracksRequestSchema.safeParse(body).success).toBe(true);
  });

  it("rejects multi-track publishes and non-local locations", () => {
    const track = { location: "local", trackName: "mic-track", mid: "1" };
    expect(
      pushTracksRequestSchema.safeParse({
        sessionDescription: { type: "offer", sdp: AUDIO_SDP },
        tracks: [track, { ...track, trackName: "second", mid: "2" }],
      }).success,
    ).toBe(false);
    expect(
      pushTracksRequestSchema.safeParse({
        sessionDescription: { type: "offer", sdp: AUDIO_SDP },
        tracks: [{ ...track, location: "remote" }],
      }).success,
    ).toBe(false);
  });

  it("rejects malformed or oversized SDP", () => {
    expect(
      pushTracksRequestSchema.safeParse({
        sessionDescription: { type: "offer", sdp: "not sdp at all" },
        tracks: [{ location: "local", trackName: "mic", mid: "1" }],
      }).success,
    ).toBe(false);
    expect(
      pushTracksRequestSchema.safeParse({
        sessionDescription: { type: "offer", sdp: `v=0\r\n${"a".repeat(300 * 1024)}` },
        tracks: [{ location: "local", trackName: "mic", mid: "1" }],
      }).success,
    ).toBe(false);
    expect(
      pushTracksRequestSchema.safeParse({
        sessionDescription: { type: "offer", sdp: "v=0\r\nm=audio 9\r\n\u0000" },
        tracks: [{ location: "local", trackName: "mic", mid: "1" }],
      }).success,
    ).toBe(false);
  });

  it("bounds pull batches and validates identifiers", () => {
    expect(
      pullTracksRequestSchema.safeParse({
        tracks: [{ location: "remote", sessionId: "session-other", trackName: "their-mic" }],
      }).success,
    ).toBe(true);
    expect(pullTracksRequestSchema.safeParse({ tracks: [] }).success).toBe(false);
    expect(
      pullTracksRequestSchema.safeParse({
        tracks: [{ location: "remote", sessionId: "bad session", trackName: "their-mic" }],
      }).success,
    ).toBe(false);
  });

  it("validates renegotiate and close bodies strictly", () => {
    expect(
      renegotiateRequestSchema.safeParse({
        sessionDescription: { type: "answer", sdp: AUDIO_SDP },
      }).success,
    ).toBe(true);
    expect(
      renegotiateRequestSchema.safeParse({
        sessionDescription: { type: "offer", sdp: AUDIO_SDP },
      }).success,
    ).toBe(false);
    expect(
      closeTracksRequestSchema.safeParse({ tracks: [{ mid: "1" }], force: true }).success,
    ).toBe(true);
    expect(closeTracksRequestSchema.safeParse({ tracks: [{ mid: "1", extra: 1 }] }).success).toBe(
      false,
    );
  });
});

describe("authorization matrix", () => {
  it("scopes every session operation to the caller's registered session", () => {
    expect(authorizeSessionScoped(connectedState, "session-abc")).toEqual({ ok: true });
    expect(authorizeSessionScoped(connectedState, "session-other").ok).toBe(false);
    expect(authorizeSessionScoped(idleState, "session-abc").ok).toBe(false);
  });

  it("permits safe same-track replacement and rejects a distinct second publication", () => {
    const push = (trackName: string, sdp: string) => ({
      sessionDescription: { type: "offer" as const, sdp },
      tracks: [{ location: "local" as const, trackName, mid: "1" }],
    });
    expect(
      authorizePushTracks(connectedState, "session-abc", push("mic-track", AUDIO_SDP)),
    ).toEqual({ ok: true });
    expect(
      authorizePushTracks(publishingState, "session-abc", push("mic-track", AUDIO_SDP)),
    ).toEqual({ ok: true });
    expect(
      authorizePushTracks(publishingState, "session-abc", push("second-track", AUDIO_SDP)).ok,
    ).toBe(false);
    expect(
      authorizePushTracks(connectedState, "session-abc", push("mic-track", VIDEO_SDP)).ok,
    ).toBe(false);
    expect(
      authorizePushTracks(connectedState, "session-other", push("mic-track", AUDIO_SDP)).ok,
    ).toBe(false);
  });

  it("permits pulling only other members' active publications", () => {
    const pull = (sessionId: string, trackName: string) => ({
      tracks: [{ location: "remote" as const, sessionId, trackName }],
    });
    expect(
      authorizePullTracks(
        connectedState,
        "session-abc",
        pull("session-other", "their-mic"),
        CALLER_CONNECTION,
        publications,
      ),
    ).toEqual({ ok: true });
    // Guessed/unpublished track.
    expect(
      authorizePullTracks(
        connectedState,
        "session-abc",
        pull("session-other", "guessed-track"),
        CALLER_CONNECTION,
        publications,
      ).ok,
    ).toBe(false);
    // Cross-room track: not in this room's registry at all.
    expect(
      authorizePullTracks(
        connectedState,
        "session-abc",
        pull("session-in-other-room", "their-mic"),
        CALLER_CONNECTION,
        publications,
      ).ok,
    ).toBe(false);
    // The caller's own publication cannot be pulled back.
    expect(
      authorizePullTracks(
        connectedState,
        "session-abc",
        pull("session-abc", "mic-track"),
        CALLER_CONNECTION,
        publications,
      ).ok,
    ).toBe(false);
  });

  it("rejects duplicate pull batches while permitting registered-track replacement", () => {
    const track = {
      location: "remote" as const,
      sessionId: "session-other",
      trackName: "their-mic",
    };
    expect(
      authorizePullTracks(
        connectedState,
        "session-abc",
        { tracks: [track, track] },
        CALLER_CONNECTION,
        publications,
      ).ok,
    ).toBe(false);

    const alreadySubscribed: VoiceConnectionSfuState = {
      ...connectedState,
      receivingMids: ["7"],
      receivingTracks: [{ sessionId: "session-other", trackName: "their-mic", mid: "7" }],
    };
    expect(
      authorizePullTracks(
        alreadySubscribed,
        "session-abc",
        { tracks: [track] },
        CALLER_CONNECTION,
        publications,
      ),
    ).toEqual({ ok: true });
  });

  it("counts legacy receiving mids toward the subscription limit", () => {
    const atLimit: VoiceConnectionSfuState = {
      ...connectedState,
      receivingMids: Array.from({ length: 64 }, (_, index) => String(index)),
      receivingTracks: [],
    };
    expect(
      authorizePullTracks(
        atLimit,
        "session-abc",
        {
          tracks: [
            {
              location: "remote",
              sessionId: "session-other",
              trackName: "their-mic",
            },
          ],
        },
        CALLER_CONNECTION,
        publications,
      ).ok,
    ).toBe(false);
  });

  it("permits closing only the caller's own registered mids", () => {
    expect(
      authorizeCloseTracks(publishingState, "session-abc", { tracks: [{ mid: "1" }] }),
    ).toEqual({ ok: true });
    expect(
      authorizeCloseTracks(publishingState, "session-abc", {
        tracks: [{ mid: "2" }, { mid: "3" }],
      }),
    ).toEqual({ ok: true });
    // Another member's mid, supplied by identifier, must be rejected.
    expect(
      authorizeCloseTracks(publishingState, "session-abc", { tracks: [{ mid: "9" }] }).ok,
    ).toBe(false);
    expect(
      authorizeCloseTracks(publishingState, "session-abc", {
        tracks: [{ mid: "1" }, { mid: "9" }],
      }).ok,
    ).toBe(false);
  });
});

describe("SFU request serialization", () => {
  it("runs mutations for one voice connection in request order", async () => {
    const queue = new VoiceSfuRequestQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run("connection", async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    });
    const second = queue.run("connection", async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    expect(queue.pendingCount("connection")).toBe(2);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(queue.pendingCount("connection")).toBe(0);
  });
});

// The Durable Object forwards the parsed response as it is, so the schema's
// stripping of unknown keys is the sanitization.
describe("upstream response sanitization", () => {
  it("keeps only the fields the client contract needs", () => {
    const parsed = upstreamTracksResponseSchema.parse({
      requiresImmediateRenegotiation: false,
      tracks: [
        {
          trackName: "their-mic",
          sessionId: "session-other",
          mid: "4",
          errorCode: undefined,
          errorDescription: "verbose upstream detail",
          internalDebug: { host: "sfu-77" },
        },
      ],
      sessionDescription: { type: "answer", sdp: AUDIO_SDP, upstreamExtra: true },
      unknownTopLevel: "dropped",
    });
    expect(parsed).toEqual({
      requiresImmediateRenegotiation: false,
      tracks: [{ trackName: "their-mic", sessionId: "session-other", mid: "4" }],
      sessionDescription: { type: "answer", sdp: AUDIO_SDP },
    });
  });

  it("keeps per-track error codes but drops descriptions", () => {
    const parsed = upstreamTracksResponseSchema.parse({
      tracks: [{ errorCode: "track_limit", errorDescription: "secret detail", mid: null }],
    });
    expect(parsed).toEqual({
      tracks: [{ errorCode: "track_limit", mid: null }],
    });
  });

  it("rejects track responses that omit ownership results", () => {
    expect(upstreamTracksResponseSchema.safeParse({}).success).toBe(false);
    expect(
      upstreamTracksResponseSchema.safeParse({
        sessionDescription: { type: "answer", sdp: AUDIO_SDP },
      }).success,
    ).toBe(false);
  });

  it("rejects session responses without a valid session id", () => {
    expect(upstreamNewSessionResponseSchema.safeParse({}).success).toBe(false);
    expect(upstreamNewSessionResponseSchema.safeParse({ sessionId: "bad id" }).success).toBe(false);
    expect(
      upstreamNewSessionResponseSchema.safeParse({ sessionId: "session-abc", extra: 1 }).success,
    ).toBe(true);
  });
});

describe("upstream URL construction", () => {
  it("scopes requests to the configured app", () => {
    expect(buildUpstreamSfuUrl("app123", "/sessions/new")).toBe(
      "https://rtc.live.cloudflare.com/v1/apps/app123/sessions/new",
    );
  });
});
