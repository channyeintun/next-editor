import { describe, expect, it } from "vitest";
import {
  MAX_VOICE_CLIENT_MESSAGE_BYTES,
  parseVoiceClientMessage,
  parseVoiceServerMessage,
  voiceCapabilitySchema,
  voiceParticipantSchema,
  voiceServerMessageSchema,
} from "./voiceProtocol";

const CONNECTION_ID = "0d5f4c72-9a3b-4c1d-8e2f-6a7b8c9d0e1f";
const USER_ID = "1b2c3d4e-5f60-4711-8223-3445566778aa";
const SESSION_ID = "2c3d4e5f-6071-4822-9334-455667788bb0";

const participant = {
  voiceConnectionId: CONNECTION_ID,
  collaborationSessionId: SESSION_ID,
  userId: USER_ID,
  displayName: "Ada",
  role: "editor",
  muted: true,
  publishedTrack: null,
  revision: 3,
};

describe("voice client messages", () => {
  it("accepts the documented client messages", () => {
    expect(
      parseVoiceClientMessage(
        JSON.stringify({ type: "voice.mute-changed", version: 1, revision: 4, muted: false }),
      ),
    ).toEqual({ type: "voice.mute-changed", version: 1, revision: 4, muted: false });
    expect(parseVoiceClientMessage(JSON.stringify({ type: "voice.leave", version: 1 }))).toEqual({
      type: "voice.leave",
      version: 1,
    });
    expect(
      parseVoiceClientMessage(JSON.stringify({ type: "voice.ping", version: 1, nonce: "abc" })),
    ).toEqual({ type: "voice.ping", version: 1, nonce: "abc" });
  });

  it("fails closed on unknown message types", () => {
    expect(
      parseVoiceClientMessage(JSON.stringify({ type: "voice.remote-unmute", version: 1 })),
    ).toBeNull();
  });

  it("fails closed on unknown fields", () => {
    expect(
      parseVoiceClientMessage(JSON.stringify({ type: "voice.leave", version: 1, extra: "field" })),
    ).toBeNull();
  });

  it("fails closed on a wrong protocol version", () => {
    expect(parseVoiceClientMessage(JSON.stringify({ type: "voice.leave", version: 2 }))).toBeNull();
  });

  it("rejects malformed JSON and oversized frames", () => {
    expect(parseVoiceClientMessage("{not json")).toBeNull();
    const oversized = JSON.stringify({
      type: "voice.ping",
      version: 1,
      nonce: "a".repeat(MAX_VOICE_CLIENT_MESSAGE_BYTES),
    });
    expect(parseVoiceClientMessage(oversized)).toBeNull();
  });

  it("rejects non-integer and negative revisions", () => {
    expect(
      parseVoiceClientMessage(
        JSON.stringify({ type: "voice.mute-changed", version: 1, revision: -1, muted: true }),
      ),
    ).toBeNull();
    expect(
      parseVoiceClientMessage(
        JSON.stringify({ type: "voice.mute-changed", version: 1, revision: 1.5, muted: true }),
      ),
    ).toBeNull();
  });
});

describe("voice participants", () => {
  it("accepts a server-shaped participant", () => {
    expect(voiceParticipantSchema.parse(participant)).toEqual(participant);
  });

  it("rejects invalid UUIDs and unknown fields", () => {
    expect(voiceParticipantSchema.safeParse({ ...participant, userId: "not-a-uuid" }).success).toBe(
      false,
    );
    expect(voiceParticipantSchema.safeParse({ ...participant, isAdmin: true }).success).toBe(false);
  });

  it("rejects track metadata with whitespace or oversized names", () => {
    const track = { sessionId: "abc123", trackName: "tr ack", location: "remote" };
    expect(
      voiceParticipantSchema.safeParse({ ...participant, publishedTrack: track }).success,
    ).toBe(false);
    expect(
      voiceParticipantSchema.safeParse({
        ...participant,
        publishedTrack: { sessionId: "abc123", trackName: "x".repeat(257), location: "remote" },
      }).success,
    ).toBe(false);
    expect(
      voiceParticipantSchema.safeParse({
        ...participant,
        publishedTrack: { sessionId: "abc123", trackName: "track-1", location: "remote" },
      }).success,
    ).toBe(true);
  });

  it("rejects a local track location", () => {
    expect(
      voiceParticipantSchema.safeParse({
        ...participant,
        publishedTrack: { sessionId: "abc123", trackName: "track-1", location: "local" },
      }).success,
    ).toBe(false);
  });
});

describe("voice server messages", () => {
  it("round-trips ready, snapshot, upsert, left, closed, error, pong", () => {
    const capability = "A".repeat(43);
    expect(voiceCapabilitySchema.safeParse(capability).success).toBe(true);
    const messages = [
      {
        type: "voice.ready",
        version: 1,
        voiceConnectionId: CONNECTION_ID,
        capability,
        limits: {
          maxParticipants: 10,
          iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        },
      },
      { type: "voice.snapshot", version: 1, revision: 7, participants: [participant] },
      { type: "voice.participant-upsert", version: 1, revision: 8, participant },
      { type: "voice.participant-left", version: 1, revision: 9, voiceConnectionId: CONNECTION_ID },
      { type: "voice.room-closed", version: 1, reason: "member-removed" },
      {
        type: "voice.error",
        version: 1,
        code: "rate-limited",
        recoverable: true,
        message: "Slow down",
      },
      { type: "voice.pong", version: 1, nonce: "abc" },
    ];
    for (const message of messages) {
      expect(parseVoiceServerMessage(JSON.stringify(message))).toEqual(message);
      expect(voiceServerMessageSchema.parse(message)).toEqual(message);
    }
  });

  it("fails closed on unknown server message types and stray fields", () => {
    expect(
      parseVoiceServerMessage(JSON.stringify({ type: "voice.force-unmute", version: 1 })),
    ).toBeNull();
    expect(
      parseVoiceServerMessage(
        JSON.stringify({ type: "voice.pong", version: 1, nonce: "abc", extra: 1 }),
      ),
    ).toBeNull();
  });

  it("rejects an unsafe error code or oversized message", () => {
    expect(
      parseVoiceServerMessage(
        JSON.stringify({
          type: "voice.error",
          version: 1,
          code: "database-password-wrong",
          recoverable: false,
          message: "x",
        }),
      ),
    ).toBeNull();
    expect(
      parseVoiceServerMessage(
        JSON.stringify({
          type: "voice.error",
          version: 1,
          code: "internal",
          recoverable: false,
          message: "x".repeat(257),
        }),
      ),
    ).toBeNull();
  });

  it("rejects malformed capabilities", () => {
    for (const capability of ["", "short", "A".repeat(42), "A".repeat(44), "!".repeat(43)]) {
      expect(voiceCapabilitySchema.safeParse(capability).success).toBe(false);
    }
  });
});
