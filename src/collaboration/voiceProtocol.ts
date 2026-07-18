import { z } from "zod";
import { collaborationIdSchema, collaborationRoleSchema } from "./protocol";

// Coordination protocol for opt-in voice chat over the Cloudflare Realtime
// SFU. This is a JSON WebSocket protocol that is deliberately independent of
// the binary SCR3 collaboration protocol: media failures must never couple to
// document synchronization. Shared by the browser client and the Worker/Voice
// Durable Object, mirroring how protocol.ts is shared.
export const COLLABORATION_VOICE_PROTOCOL_VERSION = 1 as const;

// Voice sockets carry only small JSON coordination frames.
export const MAX_VOICE_CLIENT_MESSAGE_BYTES = 4 * 1024;
// SDP payloads proxied to the SFU are bounded well below Worker limits (§6.3
// of the plan suggests 256 KiB).
export const MAX_VOICE_SFU_REQUEST_BYTES = 256 * 1024;
// Hard ceiling for roster fan-out regardless of room configuration; rooms
// also enforce their own (smaller) max_members cap.
export const MAX_VOICE_ROSTER_SIZE = 64;
// Client coordination messages per second per connection (mute toggles and
// pings only — media negotiation goes through the HTTP gateway).
export const MAX_VOICE_MESSAGES_PER_SECOND = 10;
// SFU gateway operations per second per voice connection. Cloudflare allows
// 50 API calls/second/session; stay far below it.
export const MAX_VOICE_SFU_REQUESTS_PER_SECOND = 10;

// 32 random bytes, base64url without padding. Capabilities live only in
// JavaScript memory on the client and only as a SHA-256 digest on the server.
export const voiceCapabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

// Application-specific header that carries the capability on SFU gateway
// requests. Shared so client and Worker cannot drift.
export const VOICE_CAPABILITY_HEADER = "X-Voice-Capability";

// Cloudflare SFU session identifiers and partytracks track names. Bounded,
// printable, no whitespace; treated as access-controlled identifiers.
export const voiceSfuSessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const voiceSfuTrackNameSchema = z.string().regex(/^[!-~]{1,256}$/);

export const voicePublishedTrackSchema = z
  .object({
    sessionId: voiceSfuSessionIdSchema,
    trackName: voiceSfuTrackNameSchema,
    location: z.literal("remote"),
  })
  .strict();

export type VoicePublishedTrack = z.infer<typeof voicePublishedTrackSchema>;

// Server-owned participant state. Every field except the client's mute intent
// is derived on the server; published-track metadata comes only from
// validated SFU gateway responses, never from a client claim.
export const voiceParticipantSchema = z
  .object({
    voiceConnectionId: collaborationIdSchema,
    collaborationSessionId: collaborationIdSchema,
    userId: collaborationIdSchema,
    displayName: z.string().min(1).max(120),
    role: collaborationRoleSchema,
    muted: z.boolean(),
    publishedTrack: voicePublishedTrackSchema.nullable(),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type VoiceParticipant = z.infer<typeof voiceParticipantSchema>;

const voiceRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const voiceNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const voiceClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("voice.mute-changed"),
      version: z.literal(COLLABORATION_VOICE_PROTOCOL_VERSION),
      revision: voiceRevisionSchema,
      muted: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("voice.leave"),
      version: z.literal(COLLABORATION_VOICE_PROTOCOL_VERSION),
    })
    .strict(),
  z
    .object({
      type: z.literal("voice.ping"),
      version: z.literal(COLLABORATION_VOICE_PROTOCOL_VERSION),
      nonce: voiceNonceSchema,
    })
    .strict(),
]);

export type VoiceClientMessage = z.infer<typeof voiceClientMessageSchema>;

// Stable, sanitized error codes. Upstream/internal details never reach the
// client; these codes map to UI copy on the browser side.
export const voiceErrorCodeSchema = z.enum([
  "voice-disabled",
  "not-a-member",
  "room-not-active",
  "capacity",
  "superseded",
  "rate-limited",
  "invalid-message",
  "unauthorized",
  "sfu-unavailable",
  "maintenance",
  "internal",
]);

export type VoiceErrorCode = z.infer<typeof voiceErrorCodeSchema>;

export const voiceRoomClosedReasonSchema = z.enum([
  "room-closed",
  "member-removed",
  "feature-disabled",
  "maintenance",
]);

export type VoiceRoomClosedReason = z.infer<typeof voiceRoomClosedReasonSchema>;

const voiceIceServerSchema = z
  .object({
    urls: z.union([z.string().min(1).max(256), z.array(z.string().min(1).max(256)).min(1).max(8)]),
    username: z.string().min(1).max(256).optional(),
    credential: z.string().min(1).max(256).optional(),
  })
  .strict();

export const voiceLimitsSchema = z
  .object({
    maxParticipants: z.number().int().positive().max(MAX_VOICE_ROSTER_SIZE),
    iceServers: z.array(voiceIceServerSchema).min(1).max(8),
  })
  .strict();

export type VoiceLimits = z.infer<typeof voiceLimitsSchema>;

export const voiceServerMessageSchema = z.discriminatedUnion("type", [
  // Sent only to the joining client; the capability is never broadcast.
  z
    .object({
      type: z.literal("voice.ready"),
      version: z.literal(COLLABORATION_VOICE_PROTOCOL_VERSION),
      voiceConnectionId: collaborationIdSchema,
      capability: voiceCapabilitySchema,
      limits: voiceLimitsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("voice.snapshot"),
      version: z.literal(COLLABORATION_VOICE_PROTOCOL_VERSION),
      revision: voiceRevisionSchema,
      participants: z.array(voiceParticipantSchema).max(MAX_VOICE_ROSTER_SIZE),
    })
    .strict(),
  z
    .object({
      type: z.literal("voice.participant-upsert"),
      version: z.literal(COLLABORATION_VOICE_PROTOCOL_VERSION),
      revision: voiceRevisionSchema,
      participant: voiceParticipantSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("voice.participant-left"),
      version: z.literal(COLLABORATION_VOICE_PROTOCOL_VERSION),
      revision: voiceRevisionSchema,
      voiceConnectionId: collaborationIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("voice.room-closed"),
      version: z.literal(COLLABORATION_VOICE_PROTOCOL_VERSION),
      reason: voiceRoomClosedReasonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("voice.error"),
      version: z.literal(COLLABORATION_VOICE_PROTOCOL_VERSION),
      code: voiceErrorCodeSchema,
      recoverable: z.boolean(),
      message: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal("voice.pong"),
      version: z.literal(COLLABORATION_VOICE_PROTOCOL_VERSION),
      nonce: voiceNonceSchema,
    })
    .strict(),
]);

export type VoiceServerMessage = z.infer<typeof voiceServerMessageSchema>;

export function parseVoiceClientMessage(raw: string): VoiceClientMessage | null {
  if (raw.length > MAX_VOICE_CLIENT_MESSAGE_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = voiceClientMessageSchema.safeParse(json);
  return result.success ? result.data : null;
}

export function parseVoiceServerMessage(raw: string): VoiceServerMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = voiceServerMessageSchema.safeParse(json);
  return result.success ? result.data : null;
}
