import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { CollaborationRole } from "../../../src/collaboration/protocol";
import { sha256Hex } from "../../../src/shared/sha256Hex";
import {
  COLLABORATION_VOICE_PROTOCOL_VERSION,
  VOICE_CAPABILITY_HEADER,
} from "../../../src/voice/protocol";
import type { Env } from "../env";
import { FakeWebSocket } from "../testing/fakeWebSocket";
import { CollaborationVoiceRoomDurableObject } from "./voiceDurableObject";

vi.stubGlobal(
  "WebSocketRequestResponsePair",
  class {
    constructor(
      readonly request: string,
      readonly response: string,
    ) {}
  },
);

const VOICE_ORIGIN = "https://collaboration-voice.internal";
const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const MEMBER_ID = "20000000-0000-4000-8000-000000000002";
const PEER_ID = "20000000-0000-4000-8000-000000000003";
const OTHER_PEER_ID = "20000000-0000-4000-8000-000000000004";

let nextId = 1;
function uuid(): string {
  return `40000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
}

const VOICE_ENABLED_ENV = {
  VOICE_CHAT_ENABLED: "true",
  COLLABORATION_VOICE_ROOMS: {},
  REALTIME_SFU_APP_ID: "app",
  REALTIME_SFU_APP_SECRET: "secret",
} as unknown as Env;

function createVoiceRoom(env: Env = {} as Env) {
  const sockets: FakeWebSocket[] = [];
  const ctx = {
    id: { name: ROOM_ID },
    setWebSocketAutoResponse: () => undefined,
    getWebSockets: () => sockets,
  };
  const room = new CollaborationVoiceRoomDurableObject(ctx as unknown as DurableObjectState, env);

  /** A joined voice socket as acceptConnection leaves it (the 101 upgrade needs workerd). */
  function join(
    userId: string,
    roleVersion = 1,
    overrides: Record<string, unknown> = {},
  ): FakeWebSocket {
    const socket = new FakeWebSocket();
    socket.serializeAttachment({
      roomId: ROOM_ID,
      userId,
      displayName: "Member",
      role: "editor",
      roleVersion,
      collaborationSessionId: uuid(),
      maxMembers: 10,
      voiceConnectionId: uuid(),
      capabilityDigest: "0".repeat(64),
      muted: true,
      muteRevision: 0,
      participantRevision: 1,
      sfuSessionId: null,
      publishedTrackName: null,
      publishedMid: null,
      receivingMids: [],
      receivingTracks: [],
      // Fresh, so a message skips the D1 access revalidation.
      accessCheckedAt: Date.now(),
      ...overrides,
    });
    sockets.push(socket);
    return socket;
  }

  function control(
    roleVersion: number,
    targetUserId: string,
    targetRole: CollaborationRole | null,
  ) {
    return room.fetch(
      new Request(`${VOICE_ORIGIN}/control`, {
        method: "POST",
        body: JSON.stringify({
          event: {
            kind: "membership-changed",
            roomId: ROOM_ID,
            roleVersion,
            targetUserId,
            occurredAt: Date.now(),
          },
          targetRole,
        }),
      }),
    );
  }

  function message(socket: FakeWebSocket, body: Record<string, unknown>) {
    return room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(body));
  }

  /** An SFU request as the Worker forwards it for `socket`'s session. */
  function sfu(
    socket: FakeWebSocket,
    capability: string,
    method: string,
    subpath: string,
    body?: unknown,
  ) {
    const attachment = socket.deserializeAttachment() as Record<string, unknown>;
    const session = Object.fromEntries(
      [
        "roomId",
        "userId",
        "displayName",
        "role",
        "roleVersion",
        "collaborationSessionId",
        "maxMembers",
      ].map((key) => [key, attachment[key]]),
    );
    return room.fetch(
      new Request(`${VOICE_ORIGIN}/sfu${subpath}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Collaboration-Voice-Session": encodeURIComponent(JSON.stringify(session)),
          [VOICE_CAPABILITY_HEADER]: capability,
          "X-Voice-Connection": String(attachment.voiceConnectionId),
        },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    );
  }

  return { join, control, message, sfu };
}

describe("CollaborationVoiceRoomDurableObject membership control", () => {
  it("removes a member from the call", async () => {
    const { join, control } = createVoiceRoom();
    const member = join(MEMBER_ID);

    expect((await control(2, MEMBER_ID, null)).status).toBe(200);

    expect(member.closeCode).toBe(4003);
  });

  // The role version is room-wide: another member's change can raise this
  // socket's version before the removal arrives, and a repeated removal
  // carries the version the room already has.
  it("removes a member even when a later change reached the room first", async () => {
    const { join, control } = createVoiceRoom();
    const member = join(MEMBER_ID);

    await control(3, PEER_ID, "editor");
    await control(2, MEMBER_ID, null);

    expect(member.closeCode).toBe(4003);
    expect(member.messages()).toContainEqual(
      expect.objectContaining({ type: "voice.room-closed", reason: "member-removed" }),
    );
  });

  it("removes a member when the owner repeats the removal", async () => {
    const { join, control } = createVoiceRoom();
    const member = join(MEMBER_ID, 2);

    await control(2, MEMBER_ID, null);

    expect(member.closeCode).toBe(4003);
  });

  it("ignores a role change older than the socket's role version", async () => {
    const { join, control } = createVoiceRoom();
    const member = join(MEMBER_ID, 3);

    await control(2, MEMBER_ID, "viewer");

    expect(member.closeCode).toBeNull();
    expect(member.deserializeAttachment()).toMatchObject({ role: "editor", roleVersion: 3 });
  });
});

describe("CollaborationVoiceRoomDurableObject roster upserts", () => {
  it("sends a mute change to the sender as well as the room", async () => {
    const { join, message } = createVoiceRoom(VOICE_ENABLED_ENV);
    const member = join(MEMBER_ID);
    const peer = join(PEER_ID);
    const memberConnectionId = (member.deserializeAttachment() as { voiceConnectionId: string })
      .voiceConnectionId;

    await message(member, {
      type: "voice.mute-changed",
      version: COLLABORATION_VOICE_PROTOCOL_VERSION,
      revision: 1,
      muted: false,
    });

    for (const socket of [member, peer]) {
      expect(socket.messages()).toContainEqual(
        expect.objectContaining({
          type: "voice.participant-upsert",
          participant: expect.objectContaining({
            voiceConnectionId: memberConnectionId,
            muted: false,
          }),
        }),
      );
    }
  });

  it("sends every member the identical upsert frame", async () => {
    const { join, message } = createVoiceRoom(VOICE_ENABLED_ENV);
    const member = join(MEMBER_ID);
    const peers = [join(PEER_ID), join(OTHER_PEER_ID)];

    await message(member, {
      type: "voice.mute-changed",
      version: COLLABORATION_VOICE_PROTOCOL_VERSION,
      revision: 1,
      muted: false,
    });

    const upsertFrames = [member, ...peers].map((socket) =>
      socket.sent.filter(
        (frame): frame is string =>
          typeof frame === "string" && frame.includes('"voice.participant-upsert"'),
      ),
    );
    expect(upsertFrames[0]).toHaveLength(1);
    expect(upsertFrames[1]).toEqual(upsertFrames[0]);
    expect(upsertFrames[2]).toEqual(upsertFrames[0]);
  });

  it("closes a member whose send fails and still reaches the rest", async () => {
    const { join, message } = createVoiceRoom(VOICE_ENABLED_ENV);
    const member = join(MEMBER_ID);
    const broken = join(PEER_ID);
    const peer = join(OTHER_PEER_ID);
    broken.send = () => {
      throw new Error("send failed");
    };

    await message(member, {
      type: "voice.mute-changed",
      version: COLLABORATION_VOICE_PROTOCOL_VERSION,
      revision: 1,
      muted: false,
    });

    expect(broken.closeCode).toBe(1011);
    expect(peer.messages()).toContainEqual(
      expect.objectContaining({ type: "voice.participant-upsert" }),
    );
  });
});

describe("CollaborationVoiceRoomDurableObject hibernated attachments", () => {
  function receiving(count: number) {
    const receivingTracks = Array.from({ length: count }, (_, index) => ({
      sessionId: `session-${index}`,
      trackName: "mic",
      mid: String(index),
    }));
    return { receivingTracks, receivingMids: receivingTracks.map((track) => track.mid) };
  }

  function muteChange(room: ReturnType<typeof createVoiceRoom>, socket: FakeWebSocket) {
    return room.message(socket, {
      type: "voice.mute-changed",
      version: COLLABORATION_VOICE_PROTOCOL_VERSION,
      revision: 1,
      muted: false,
    });
  }

  it("accepts an attachment holding the per-connection maximum of pulled tracks", async () => {
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    const member = room.join(MEMBER_ID, 1, receiving(64));

    await muteChange(room, member);

    expect(member.closeCode).toBeNull();
  });

  it("refuses an attachment holding one pulled track over the maximum", async () => {
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    const member = room.join(MEMBER_ID, 1, receiving(65));

    await muteChange(room, member);

    // 1008: the attachment no longer parses as a voice session.
    expect(member.closeCode).toBe(1008);
  });
});

describe("CollaborationVoiceRoomDurableObject SFU requests", () => {
  const CAPABILITY = "c".repeat(43);
  const AUDIO_SDP =
    "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a new session, then a publication the room hears about", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ sessionId: "session-new" }))
      .mockResolvedValueOnce(
        Response.json({
          sessionDescription: { type: "answer", sdp: AUDIO_SDP },
          tracks: [{ trackName: "mic", mid: "0" }],
        }),
      );
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    const member = room.join(MEMBER_ID, 1, { capabilityDigest: await sha256Hex(CAPABILITY) });
    const peer = room.join(PEER_ID);

    const created = await room.sfu(member, CAPABILITY, "POST", "/sessions/new");

    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ sessionId: "session-new" });
    expect(upstream.mock.calls[0][0]).toBe(
      "https://rtc.live.cloudflare.com/v1/apps/app/sessions/new",
    );
    expect(member.deserializeAttachment()).toMatchObject({ sfuSessionId: "session-new" });

    const pushed = await room.sfu(member, CAPABILITY, "POST", "/sessions/session-new/tracks/new", {
      sessionDescription: { type: "offer", sdp: AUDIO_SDP },
      tracks: [{ location: "local", trackName: "mic", mid: "0" }],
    });

    expect(pushed.status).toBe(200);
    expect(member.deserializeAttachment()).toMatchObject({
      publishedTrackName: "mic",
      publishedMid: "0",
    });
    expect(peer.messages()).toContainEqual(
      expect.objectContaining({
        type: "voice.participant-upsert",
        participant: expect.objectContaining({
          publishedTrack: { sessionId: "session-new", trackName: "mic", location: "remote" },
        }),
      }),
    );
  });

  it("refuses a capability that does not match the connection", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    const member = room.join(MEMBER_ID, 1, { capabilityDigest: await sha256Hex(CAPABILITY) });

    const response = await room.sfu(member, "d".repeat(43), "POST", "/sessions/new");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(upstream).not.toHaveBeenCalled();
    expect(member.deserializeAttachment()).toMatchObject({ sfuSessionId: null });
  });
});
