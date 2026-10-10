import {
  MAX_VOICE_TRACKS_PER_CONNECTION,
  authorizeCloseTracks,
  authorizePullTracks,
  authorizePushTracks,
  authorizeSessionScoped,
  closeTracksRequestSchema,
  pullTracksRequestSchema,
  pushTracksRequestSchema,
  receivingTrackKey,
  renegotiateRequestSchema,
  upstreamNewSessionResponseSchema,
  upstreamRenegotiateResponseSchema,
  upstreamTracksResponseSchema,
  type ActivePublication,
  type RealtimeSfuUpstream,
  type ReceivingTrack,
  type VoiceConnectionSfuState,
} from "./realtimeSfuGateway";
import type { z } from "zod";

// One function per SFU operation the voice Durable Object proxies. The
// Durable Object authenticates the caller, serializes its requests, applies
// the rate window and reads the body; each operation then authorizes against
// the connection's registered state, calls the SFU and records the new
// ownership through a VoiceSfuConnection, so it can run against fakes.

export function noStoreJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function unauthorized(): Response {
  return noStoreJson({ error: "unauthorized" }, 403);
}

/** The fields of a voice socket's attachment that the SFU operations read. */
export interface VoiceSfuAttachment extends VoiceConnectionSfuState {
  readonly roomId: string;
  readonly voiceConnectionId: string;
}

/** The fields an SFU operation writes back over the live attachment. */
export interface VoiceSfuAttachmentUpdate {
  sfuSessionId?: string | null;
  publishedTrackName?: string | null;
  publishedMid?: string | null;
  receivingMids?: string[];
  receivingTracks?: ReceivingTrack[];
  participantRevision?: number;
}

/** One authorized voice connection's SFU request, as the Durable Object serves it. */
export interface VoiceSfuConnection {
  readonly upstream: Pick<RealtimeSfuUpstream, "request" | "closeTracks">;
  /** The request's path below /sfu and its method, forwarded upstream as they are. */
  readonly subpath: string;
  readonly method: string;
  /** The attachment as this request last read or wrote it. */
  current(): VoiceSfuAttachment;
  /** The attachment now, or null once the socket is gone, superseded or no longer the caller's. */
  readLive(): VoiceSfuAttachment | null;
  /**
   * Writes `update(latest)` over the live attachment and returns the result,
   * or null (writing nothing) when the attachment is no longer live.
   */
  persist(
    update: (latest: VoiceSfuAttachment) => VoiceSfuAttachmentUpdate,
  ): VoiceSfuAttachment | null;
  /** Every live connection's publication in this voice room. */
  activePublications(): ActivePublication[];
  nextRevision(): number;
  /** Announces the connection's current roster row to the room. */
  broadcastUpsert(): void;
  logOutcome(kind: string, status: number): void;
}

function stateFor(attachment: VoiceSfuAttachment): VoiceConnectionSfuState {
  return {
    sfuSessionId: attachment.sfuSessionId,
    publishedTrackName: attachment.publishedTrackName,
    publishedMid: attachment.publishedMid,
    receivingMids: attachment.receivingMids,
    receivingTracks: attachment.receivingTracks,
  };
}

function forward(conn: VoiceSfuConnection, upstreamBody: unknown): Promise<Response | null> {
  return conn.upstream.request(conn.subpath, conn.method, upstreamBody);
}

function closeRegisteredTracks(
  conn: VoiceSfuConnection,
  attachment: VoiceSfuAttachment,
  additionalMids: readonly string[] = [],
): Promise<boolean> {
  if (attachment.sfuSessionId === null) return Promise.resolve(true);
  return conn.upstream.closeTracks(attachment.sfuSessionId, [
    ...(attachment.publishedMid === null ? [] : [attachment.publishedMid]),
    ...attachment.receivingMids,
    ...additionalMids,
  ]);
}

function upstreamFailure(conn: VoiceSfuConnection, kind: string, status?: number): Response {
  // Upstream bodies are never logged or forwarded (§6.3).
  console.error("collaboration_voice_sfu_upstream_failed", {
    roomId: conn.current().roomId,
    kind,
    upstreamStatus: status ?? null,
  });
  return noStoreJson({ error: "sfu-unavailable" }, 502);
}

export async function createSession(conn: VoiceSfuConnection): Promise<Response> {
  // Any live connection may create a session: PartyTracks creates a
  // replacement PeerConnection/SFU session after terminal media failure.
  // Close every registered track first, then clear the old ownership
  // registry before creating the new session. This keeps one active
  // session per connection without breaking library recovery.
  const current = conn.current();
  if (current.sfuSessionId !== null) {
    const hadPublication = current.publishedTrackName !== null;
    if (!(await closeRegisteredTracks(conn, current))) {
      return upstreamFailure(conn, "replace-session");
    }
    const cleared = conn.persist(() => ({
      sfuSessionId: null,
      publishedTrackName: null,
      publishedMid: null,
      receivingMids: [],
      receivingTracks: [],
      ...(hadPublication ? { participantRevision: conn.nextRevision() } : {}),
    }));
    if (!cleared) return unauthorized();
    if (hadPublication) conn.broadcastUpsert();
  }
  const response = await forward(conn, null);
  if (!response || !response.ok) {
    return upstreamFailure(conn, "create-session", response?.status);
  }
  const parsed = upstreamNewSessionResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return upstreamFailure(conn, "create-session", response.status);
  const next = conn.persist(() => ({ sfuSessionId: parsed.data.sessionId }));
  if (!next) return unauthorized();
  conn.logOutcome("create-session", 200);
  return noStoreJson({ sessionId: parsed.data.sessionId });
}

// tracks/new carries either a push (with an SDP offer) or a pull (remote
// track list); disambiguate by shape, then authorize.
export async function pushOrPullTracks(
  conn: VoiceSfuConnection,
  sessionId: string,
  body: unknown,
): Promise<Response> {
  const push = pushTracksRequestSchema.safeParse(body);
  if (push.success) return pushTracks(conn, sessionId, push.data);
  const pull = pullTracksRequestSchema.safeParse(body);
  if (pull.success) return pullTracks(conn, sessionId, pull.data);
  conn.logOutcome("push-tracks", 400);
  return noStoreJson({ error: "invalid request" }, 400);
}

export async function pushTracks(
  conn: VoiceSfuConnection,
  sessionId: string,
  request: z.infer<typeof pushTracksRequestSchema>,
): Promise<Response> {
  const current = conn.current();
  const requested = request.tracks[0];
  const authorized = authorizePushTracks(stateFor(current), sessionId, request);
  if (!authorized.ok) {
    conn.logOutcome("push-tracks", authorized.status);
    return noStoreJson({ error: authorized.error }, authorized.status);
  }
  // A PartyTracks network retry can repeat tracks/new after Cloudflare
  // accepted the first request but before the browser received its
  // response. Replace that same stable track atomically within this
  // connection's queue; a differently named second publication was
  // rejected above.
  if (current.publishedTrackName === requested.trackName && current.publishedMid !== null) {
    const replacedMid = current.publishedMid;
    if (!(await conn.upstream.closeTracks(sessionId, [replacedMid]))) {
      return upstreamFailure(conn, "replace-published-track");
    }
    const cleared = conn.persist(() => ({
      publishedTrackName: null,
      publishedMid: null,
      participantRevision: conn.nextRevision(),
    }));
    if (!cleared) return unauthorized();
    conn.broadcastUpsert();
  }
  const response = await forward(conn, request);
  if (!response || !response.ok) return upstreamFailure(conn, "push-tracks", response?.status);
  const parsed = upstreamTracksResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return upstreamFailure(conn, "push-tracks", response.status);
  if (parsed.data.errorCode === undefined && parsed.data.sessionDescription === undefined) {
    return upstreamFailure(conn, "push-tracks", response.status);
  }
  const accepted =
    parsed.data.errorCode === undefined
      ? parsed.data.tracks.find(
          (track) => track.errorCode === undefined && track.mid === requested.mid,
        )
      : undefined;
  if (
    parsed.data.errorCode === undefined &&
    (parsed.data.tracks.length !== 1 ||
      (parsed.data.tracks[0]?.errorCode === undefined && !accepted))
  ) {
    await conn.upstream.closeTracks(
      sessionId,
      parsed.data.tracks.flatMap((track) =>
        track.errorCode === undefined && track.mid != null ? [track.mid] : [],
      ),
    );
    return upstreamFailure(conn, "push-tracks", response.status);
  }
  if (accepted) {
    const acceptedMid = accepted.mid as string;
    const next = conn.persist(() => ({
      publishedTrackName: requested.trackName,
      publishedMid: acceptedMid,
      participantRevision: conn.nextRevision(),
    }));
    if (!next) {
      await conn.upstream.closeTracks(sessionId, [acceptedMid]);
      return unauthorized();
    }
    conn.broadcastUpsert();
  }
  conn.logOutcome("push-tracks", 200);
  return noStoreJson(parsed.data);
}

export async function pullTracks(
  conn: VoiceSfuConnection,
  sessionId: string,
  request: z.infer<typeof pullTracksRequestSchema>,
): Promise<Response> {
  const current = conn.current();
  const authorized = authorizePullTracks(
    stateFor(current),
    sessionId,
    request,
    current.voiceConnectionId,
    conn.activePublications(),
  );
  if (!authorized.ok) {
    conn.logOutcome("pull-tracks", authorized.status);
    return noStoreJson({ error: authorized.error }, authorized.status);
  }
  // Retry replacement mirrors the publication path: close only the
  // registered mids for requested stable remote track identities,
  // update the ownership registry, then forward the replacement pull.
  const requestedKeys = new Set(request.tracks.map(receivingTrackKey));
  const replacedTracks = current.receivingTracks.filter((track) =>
    requestedKeys.has(receivingTrackKey(track)),
  );
  if (replacedTracks.length > 0) {
    const replacedMids = new Set(replacedTracks.map((track) => track.mid));
    if (!(await conn.upstream.closeTracks(sessionId, [...replacedMids]))) {
      return upstreamFailure(conn, "replace-pulled-tracks");
    }
    const cleared = conn.persist((latest) => ({
      receivingMids: latest.receivingMids.filter((mid) => !replacedMids.has(mid)),
      receivingTracks: latest.receivingTracks.filter((track) => !replacedMids.has(track.mid)),
    }));
    if (!cleared) return unauthorized();
  }
  const response = await forward(conn, request);
  if (!response || !response.ok) return upstreamFailure(conn, "pull-tracks", response?.status);
  const parsed = upstreamTracksResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return upstreamFailure(conn, "pull-tracks", response.status);
  const additions: ReceivingTrack[] = [];
  const successfulTracks = parsed.data.errorCode === undefined ? parsed.data.tracks : [];
  const acceptedKeys = new Set<string>();
  let malformedSuccess = false;
  for (const track of successfulTracks) {
    if (track.errorCode !== undefined) continue;
    if (track.mid == null || track.sessionId === undefined || track.trackName === undefined) {
      malformedSuccess = true;
      continue;
    }
    const key = receivingTrackKey({
      sessionId: track.sessionId,
      trackName: track.trackName,
    });
    const requested = request.tracks.find(
      (candidate) =>
        candidate.sessionId === track.sessionId && candidate.trackName === track.trackName,
    );
    if (!requested || acceptedKeys.has(key)) {
      malformedSuccess = true;
      continue;
    }
    acceptedKeys.add(key);
    additions.push({
      sessionId: requested.sessionId,
      trackName: requested.trackName,
      mid: track.mid,
    });
  }
  if (
    parsed.data.errorCode === undefined &&
    (malformedSuccess ||
      parsed.data.tracks.length === 0 ||
      (parsed.data.requiresImmediateRenegotiation === true &&
        parsed.data.sessionDescription === undefined))
  ) {
    await conn.upstream.closeTracks(
      sessionId,
      successfulTracks.flatMap((track) =>
        track.errorCode === undefined && track.mid != null ? [track.mid] : [],
      ),
    );
    return upstreamFailure(conn, "pull-tracks", response.status);
  }
  if (additions.length > 0) {
    const next = conn.persist((latest) => {
      const byTrack = new Map(
        latest.receivingTracks.map((track) => [receivingTrackKey(track), track]),
      );
      for (const addition of additions) {
        byTrack.set(receivingTrackKey(addition), addition);
      }
      const receivingTracks = [...byTrack.values()].slice(0, MAX_VOICE_TRACKS_PER_CONNECTION);
      // Preserve legacy owned mids that predate receivingTracks; they
      // must remain closable and count toward the per-session limit.
      const receivingMids = [
        ...new Set([...latest.receivingMids, ...additions.map((addition) => addition.mid)]),
      ].slice(0, MAX_VOICE_TRACKS_PER_CONNECTION);
      return { receivingMids, receivingTracks };
    });
    if (!next) {
      await conn.upstream.closeTracks(
        sessionId,
        additions.map((track) => track.mid),
      );
      return unauthorized();
    }
  }
  conn.logOutcome("pull-tracks", 200);
  return noStoreJson(parsed.data);
}

export async function renegotiate(
  conn: VoiceSfuConnection,
  sessionId: string,
  body: unknown,
): Promise<Response> {
  const parsedBody = renegotiateRequestSchema.safeParse(body);
  if (!parsedBody.success) return noStoreJson({ error: "invalid request" }, 400);
  const authorized = authorizeSessionScoped(stateFor(conn.current()), sessionId);
  if (!authorized.ok) {
    conn.logOutcome("renegotiate", authorized.status);
    return noStoreJson({ error: authorized.error }, authorized.status);
  }
  const response = await forward(conn, parsedBody.data);
  if (!response || !response.ok) return upstreamFailure(conn, "renegotiate", response?.status);
  const parsed = upstreamRenegotiateResponseSchema.safeParse(
    await response.json().catch(() => ({})),
  );
  if (!parsed.success) return upstreamFailure(conn, "renegotiate", response.status);
  if (!conn.readLive()) return unauthorized();
  conn.logOutcome("renegotiate", 200);
  return noStoreJson(parsed.data);
}

export async function closeTracks(
  conn: VoiceSfuConnection,
  sessionId: string,
  body: unknown,
): Promise<Response> {
  const parsedBody = closeTracksRequestSchema.safeParse(body);
  if (!parsedBody.success) return noStoreJson({ error: "invalid request" }, 400);
  const authorized = authorizeCloseTracks(stateFor(conn.current()), sessionId, parsedBody.data);
  if (!authorized.ok) {
    conn.logOutcome("close-tracks", authorized.status);
    return noStoreJson({ error: authorized.error }, authorized.status);
  }
  const response = await forward(conn, parsedBody.data);
  if (!response || !response.ok) return upstreamFailure(conn, "close-tracks", response?.status);
  const parsed = upstreamTracksResponseSchema.safeParse(await response.json().catch(() => ({})));
  if (!parsed.success) return upstreamFailure(conn, "close-tracks", response.status);
  if (
    parsed.data.errorCode === undefined &&
    parsedBody.data.force !== true &&
    parsed.data.sessionDescription === undefined
  ) {
    return upstreamFailure(conn, "close-tracks", response.status);
  }
  const reportedTracks = parsed.data.tracks.filter((track) => track.mid != null);
  const closedMids = new Set(
    parsed.data.errorCode !== undefined
      ? []
      : reportedTracks
          .filter((track) => track.errorCode === undefined)
          .map((track) => track.mid as string),
  );
  let wasPublishing = false;
  const next = conn.persist((latest) => {
    wasPublishing = latest.publishedMid !== null && closedMids.has(latest.publishedMid);
    return {
      publishedMid: wasPublishing ? null : latest.publishedMid,
      publishedTrackName: wasPublishing ? null : latest.publishedTrackName,
      receivingMids: latest.receivingMids.filter((mid) => !closedMids.has(mid)),
      receivingTracks: latest.receivingTracks.filter((track) => !closedMids.has(track.mid)),
      ...(wasPublishing ? { participantRevision: conn.nextRevision() } : {}),
    };
  });
  if (!next) return unauthorized();
  if (wasPublishing) conn.broadcastUpsert();
  conn.logOutcome("close-tracks", 200);
  return noStoreJson(parsed.data);
}
