import { z } from "zod";
import {
  MAX_VOICE_SFU_REQUEST_BYTES,
  voiceSfuSessionIdSchema,
  voiceSfuTrackNameSchema,
} from "../../../src/collaboration/voiceProtocol";

// Request/response contract between the partytracks client (verified against
// the exact-pinned 0.0.56 build) and the Cloudflare Realtime SFU HTTPS API,
// plus the pure authorization rules from the plan's section 6.2 matrix. All
// stateful ownership checks receive a snapshot of the caller's registered
// state so this module stays testable without a Durable Object.

export const REALTIME_SFU_API_BASE = "https://rtc.live.cloudflare.com/v1";

// Cloudflare's public STUN service. TURN is deliberately not configured in
// the initial rollout; add short-lived TURN credentials only with staging
// evidence (plan §13.3).
export const VOICE_STUN_ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }] as const;

const MAX_SDP_BYTES = MAX_VOICE_SFU_REQUEST_BYTES - 8 * 1024;

// Accept only plausible unified-plan SDP: bounded, starts with a version
// line, no control characters other than \r\n.
const sdpSchema = z
  .string()
  .min(8)
  .max(MAX_SDP_BYTES)
  .refine((sdp) => sdp.startsWith("v=0") && !/[^\r\n\x20-\x7e]/.test(sdp), {
    message: "invalid SDP",
  });

const midSchema = z.string().regex(/^[!-~]{1,16}$/);

const offerSchema = z.object({ type: z.literal("offer"), sdp: sdpSchema }).strict();
const answerSchema = z.object({ type: z.literal("answer"), sdp: sdpSchema }).strict();

// tracks/new with a session description publishes local tracks. The gateway
// allows exactly one audio publication per voice connection, so the batch
// size is one.
const pushTrackSchema = z
  .object({
    location: z.literal("local"),
    trackName: voiceSfuTrackNameSchema,
    mid: midSchema,
  })
  .strict();

export const pushTracksRequestSchema = z
  .object({
    sessionDescription: offerSchema,
    tracks: z.array(pushTrackSchema).length(1),
  })
  .strict();

const pullTrackSchema = z
  .object({
    location: z.literal("remote"),
    sessionId: voiceSfuSessionIdSchema,
    trackName: voiceSfuTrackNameSchema,
  })
  .strict();

export const pullTracksRequestSchema = z
  .object({
    // Bounded by the roster ceiling; a room can never have more remote
    // publications than members.
    tracks: z.array(pullTrackSchema).min(1).max(64),
  })
  .strict();

export const renegotiateRequestSchema = z.object({ sessionDescription: answerSchema }).strict();

export const closeTracksRequestSchema = z
  .object({
    tracks: z
      .array(z.object({ mid: midSchema }).strict())
      .min(1)
      .max(64),
    sessionDescription: offerSchema.optional(),
    force: z.boolean().optional(),
  })
  .strict();

// Upstream responses are validated and rebuilt field-by-field. Plain
// z.object() strips unknown keys, so verbose upstream fields (including
// upstream error descriptions) never reach the browser.
const upstreamSessionDescriptionSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: sdpSchema,
});

const upstreamTrackResultSchema = z.object({
  trackName: voiceSfuTrackNameSchema.optional(),
  sessionId: voiceSfuSessionIdSchema.optional(),
  mid: midSchema.nullish(),
  errorCode: z.string().max(64).optional(),
});

export const upstreamNewSessionResponseSchema = z.object({
  sessionId: voiceSfuSessionIdSchema,
});

export const upstreamTracksResponseSchema = z.object({
  requiresImmediateRenegotiation: z.boolean().optional(),
  tracks: z.array(upstreamTrackResultSchema).max(64).optional(),
  sessionDescription: upstreamSessionDescriptionSchema.optional(),
  errorCode: z.string().max(64).optional(),
});

export const upstreamRenegotiateResponseSchema = z.object({
  errorCode: z.string().max(64).optional(),
});

export type SanitizedTrackResult = {
  trackName?: string;
  sessionId?: string;
  mid?: string | null;
  errorCode?: string;
};

export type SanitizedTracksResponse = {
  requiresImmediateRenegotiation?: boolean;
  tracks?: SanitizedTrackResult[];
  sessionDescription?: { type: "offer" | "answer"; sdp: string };
  errorCode?: string;
};

export function sanitizeTracksResponse(
  parsed: z.infer<typeof upstreamTracksResponseSchema>,
): SanitizedTracksResponse {
  const response: SanitizedTracksResponse = {};
  if (parsed.requiresImmediateRenegotiation !== undefined) {
    response.requiresImmediateRenegotiation = parsed.requiresImmediateRenegotiation;
  }
  if (parsed.tracks) {
    response.tracks = parsed.tracks.map((track) => {
      const entry: SanitizedTrackResult = {};
      if (track.trackName !== undefined) entry.trackName = track.trackName;
      if (track.sessionId !== undefined) entry.sessionId = track.sessionId;
      if (track.mid !== undefined) entry.mid = track.mid;
      if (track.errorCode !== undefined) entry.errorCode = track.errorCode;
      return entry;
    });
  }
  if (parsed.sessionDescription) {
    response.sessionDescription = {
      type: parsed.sessionDescription.type,
      sdp: parsed.sessionDescription.sdp,
    };
  }
  if (parsed.errorCode !== undefined) response.errorCode = parsed.errorCode;
  return response;
}

// The SFU operations this gateway understands. Everything else — including
// tracks/update (simulcast) and session-state reads — fails closed until an
// explicit use case and ownership rule exist.
export type VoiceSfuOperation =
  | { kind: "create-session" }
  | { kind: "ice-servers" }
  | { kind: "push-tracks"; sessionId: string }
  | { kind: "pull-tracks"; sessionId: string }
  | { kind: "renegotiate"; sessionId: string }
  | { kind: "close-tracks"; sessionId: string };

export function parseVoiceSfuOperation(method: string, subpath: string): VoiceSfuOperation | null {
  if (method === "GET" && subpath === "/generate-ice-servers") return { kind: "ice-servers" };
  if (method === "POST" && subpath === "/sessions/new") return { kind: "create-session" };
  const sessionMatch = /^\/sessions\/([A-Za-z0-9_-]{1,64})(\/.*)$/.exec(subpath);
  if (!sessionMatch) return null;
  const sessionId = sessionMatch[1];
  const rest = sessionMatch[2];
  if (method === "POST" && rest === "/tracks/new") {
    // Push vs pull is decided by the request body shape, not the path.
    return { kind: "push-tracks", sessionId };
  }
  if (method === "PUT" && rest === "/renegotiate") return { kind: "renegotiate", sessionId };
  if (method === "PUT" && rest === "/tracks/close") return { kind: "close-tracks", sessionId };
  return null;
}

// Snapshot of a voice connection's registered SFU state as the authorization
// rules need it.
export interface VoiceConnectionSfuState {
  sfuSessionId: string | null;
  publishedTrackName: string | null;
  publishedMid: string | null;
  receivingMids: readonly string[];
}

export interface ActivePublication {
  ownerVoiceConnectionId: string;
  sessionId: string;
  trackName: string;
}

export type VoiceSfuAuthorization =
  | { ok: true }
  | { ok: false; status: 403 | 400 | 409; error: string };

function deny(status: 403 | 400 | 409, error: string): VoiceSfuAuthorization {
  return { ok: false, status, error };
}

export function authorizeCreateSession(state: VoiceConnectionSfuState): VoiceSfuAuthorization {
  // One SFU session per voice connection generation. A media-level recovery
  // that needs a brand new session must come through a new voice connection.
  if (state.sfuSessionId !== null) return deny(409, "session already exists");
  return { ok: true };
}

export function authorizeSessionScoped(
  state: VoiceConnectionSfuState,
  sessionId: string,
): VoiceSfuAuthorization {
  if (state.sfuSessionId === null || state.sfuSessionId !== sessionId) {
    return deny(403, "unknown session");
  }
  return { ok: true };
}

export function authorizePushTracks(
  state: VoiceConnectionSfuState,
  sessionId: string,
  body: z.infer<typeof pushTracksRequestSchema>,
): VoiceSfuAuthorization {
  const scoped = authorizeSessionScoped(state, sessionId);
  if (!scoped.ok) return scoped;
  const track = body.tracks[0];
  // Republishing under the same name replaces the connection's own
  // publication (mute/unmute device reacquisition); a second distinct live
  // publication is rejected.
  if (state.publishedTrackName !== null && state.publishedTrackName !== track.trackName) {
    return deny(409, "already publishing");
  }
  if (!/^m=audio\b/m.test(body.sessionDescription.sdp)) {
    return deny(400, "audio only");
  }
  if (/^m=(video|application)\b/m.test(body.sessionDescription.sdp)) {
    return deny(400, "audio only");
  }
  return { ok: true };
}

export function authorizePullTracks(
  state: VoiceConnectionSfuState,
  sessionId: string,
  body: z.infer<typeof pullTracksRequestSchema>,
  voiceConnectionId: string,
  activePublications: readonly ActivePublication[],
): VoiceSfuAuthorization {
  const scoped = authorizeSessionScoped(state, sessionId);
  if (!scoped.ok) return scoped;
  for (const track of body.tracks) {
    const publication = activePublications.find(
      (candidate) =>
        candidate.sessionId === track.sessionId && candidate.trackName === track.trackName,
    );
    // Only tracks currently published by another live connection in this
    // same voice room may be pulled; guessed or cross-room identifiers fail.
    if (!publication || publication.ownerVoiceConnectionId === voiceConnectionId) {
      return deny(403, "unknown track");
    }
  }
  return { ok: true };
}

export function authorizeCloseTracks(
  state: VoiceConnectionSfuState,
  sessionId: string,
  body: z.infer<typeof closeTracksRequestSchema>,
): VoiceSfuAuthorization {
  const scoped = authorizeSessionScoped(state, sessionId);
  if (!scoped.ok) return scoped;
  for (const track of body.tracks) {
    const owned = track.mid === state.publishedMid || state.receivingMids.includes(track.mid);
    if (!owned) return deny(403, "unknown mid");
  }
  return { ok: true };
}

export function buildUpstreamSfuUrl(appId: string, subpath: string): string {
  return `${REALTIME_SFU_API_BASE}/apps/${appId}${subpath}`;
}
