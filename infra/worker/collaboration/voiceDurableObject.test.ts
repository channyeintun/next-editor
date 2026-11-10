import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_SQLITE_PERSISTENCE_VERSION,
  type CollaborationRole,
} from "../../../src/collaboration/protocol";
import { sha256Hex } from "../../../src/shared/sha256Hex";
import {
  COLLABORATION_VOICE_PROTOCOL_VERSION,
  VOICE_CAPABILITY_HEADER,
} from "../../../src/voice/protocol";
import {
  getCollaborationRoomAccess,
  type CollaborationRoomAccess,
} from "../../db/collaborationQueries";
import { getSessionUser } from "../../db/queries";
import type { Env } from "../env";
import { FakeWebSocket } from "../testing/fakeWebSocket";
import { SqliteTestStorage } from "../testing/sqliteStorage";
import { stubWebSocketUpgrade } from "../testing/webSocketUpgrade";
import { CollaborationVoiceRoomDurableObject } from "./voiceDurableObject";

vi.mock("../../db/collaborationQueries", () => ({
  getCollaborationRoomAccess: vi.fn<typeof getCollaborationRoomAccess>(),
}));

vi.mock("../../db/queries", () => ({
  getSessionUser: vi.fn<typeof getSessionUser>(),
}));

stubWebSocketUpgrade(() => new FakeWebSocket());

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

/** Storage with the alarm the voice object arms for upstream release retries. */
class VoiceTestStorage extends SqliteTestStorage {
  alarmAt: number | null = null;

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(scheduledAt: number): Promise<void> {
    this.alarmAt = scheduledAt;
  }
}

const openStorages: SqliteTestStorage[] = [];

afterEach(() => {
  for (const storage of openStorages.splice(0)) storage.close();
});

/** The auth session the Worker saw sign `userId` in; every one is signed in unless a test says not. */
function authSessionOf(userId: string): string {
  return `session-of-${userId}`;
}

beforeEach(() => {
  vi.mocked(getCollaborationRoomAccess).mockReset();
  vi.mocked(getSessionUser)
    .mockReset()
    .mockImplementation(async (_db, authSessionId) =>
      authSessionId.startsWith("session-of-")
        ? ({ id: authSessionId.slice("session-of-".length) } as never)
        : null,
    );
});

function roomAccess(role: CollaborationRole, roleVersion: number): CollaborationRoomAccess {
  return {
    id: ROOM_ID,
    owner_id: PEER_ID,
    host_user_id: PEER_ID,
    status: "active",
    transport: "cloudflare-websocket",
    persistence_version: COLLABORATION_SQLITE_PERSISTENCE_VERSION,
    protocol_version: COLLABORATION_PROTOCOL_VERSION,
    document_schema_version: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
    role_version: roleVersion,
    max_members: 10,
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    purged_at: null,
    member_role: role,
  };
}

function createVoiceRoom(env: Env = {} as Env) {
  const sockets: FakeWebSocket[] = [];
  const storage = new VoiceTestStorage();
  openStorages.push(storage);
  const ctx = {
    id: { name: ROOM_ID },
    storage,
    setWebSocketAutoResponse: () => undefined,
    getWebSockets: () => sockets,
    acceptWebSocket: (socket: FakeWebSocket) => sockets.push(socket),
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
      authSessionId: authSessionOf(userId),
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

  function closeRoom(roleVersion: number) {
    return room.fetch(
      new Request(`${VOICE_ORIGIN}/control`, {
        method: "POST",
        body: JSON.stringify({
          event: {
            kind: "room-closed",
            roomId: ROOM_ID,
            roleVersion,
            targetUserId: null,
            occurredAt: Date.now(),
          },
        }),
      }),
    );
  }

  /** Opens a voice socket through the upgrade, with the session the Worker read from D1. */
  async function upgrade(
    userId: string,
    roleVersion: number,
  ): Promise<{ response: Response; socket: FakeWebSocket | null }> {
    const before = sockets.length;
    const session = {
      roomId: ROOM_ID,
      userId,
      displayName: "Member",
      role: "editor",
      roleVersion,
      collaborationSessionId: uuid(),
      maxMembers: 10,
      authSessionId: authSessionOf(userId),
    };
    const response = await room.fetch(
      new Request(`${VOICE_ORIGIN}/websocket`, {
        headers: {
          Upgrade: "websocket",
          "X-Collaboration-Voice-Session": encodeURIComponent(JSON.stringify(session)),
        },
      }),
    );
    return { response, socket: sockets.length > before ? sockets.at(-1)! : null };
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
        "authSessionId",
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

  return { join, control, closeRoom, upgrade, message, sfu, instance: room, storage };
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

// The Worker reads D1 once for the voice upgrade. A removal that commits
// after the read can reach this object first; /control retired only the
// sockets open then, and the late upgrade joined the call with a seat and
// the whole roster.
describe("CollaborationVoiceRoomDurableObject upgrades that predate an applied change", () => {
  const upsertsFor = (socket: FakeWebSocket, userId: string) =>
    socket
      .messages()
      .filter(
        (message) =>
          message.type === "voice.participant-upsert" &&
          (message.participant as { userId: string }).userId === userId,
      );

  it("refuses an upgrade read before a removal it has applied", async () => {
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    const peer = room.join(PEER_ID, 4);
    const member = room.join(MEMBER_ID, 4);
    await room.control(5, MEMBER_ID, null);
    expect(member.closeCode).toBe(4003);

    const late = await room.upgrade(MEMBER_ID, 4);

    expect(late.response.status).toBe(403);
    expect(late.socket).toBeNull();
    expect(upsertsFor(peer, MEMBER_ID)).toEqual([]);
  });

  it("refuses it even when no socket was open to carry the removal", async () => {
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    await room.control(5, MEMBER_ID, null);

    expect((await room.upgrade(MEMBER_ID, 4)).response.status).toBe(403);
  });

  it("accepts the member again once they rejoin at a later version", async () => {
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    await room.control(5, MEMBER_ID, null);

    expect((await room.upgrade(MEMBER_ID, 6)).response.status).toBe(101);
  });

  it("refuses every upgrade once the room has been closed", async () => {
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    await room.closeRoom(5);

    expect((await room.upgrade(MEMBER_ID, 5)).response.status).toBe(409);
  });

  it("gives an upgrade read before a demotion the demoted role", async () => {
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    await room.control(5, MEMBER_ID, "viewer");

    const late = await room.upgrade(MEMBER_ID, 4);

    expect(late.response.status).toBe(101);
    expect(late.socket!.deserializeAttachment()).toMatchObject({ role: "viewer", roleVersion: 5 });
  });
});

// Rechecks ran only on a frame the socket sent, and by design the client
// sends no heartbeat, so a member who lost access with no /control reaching
// their socket kept a seat and every roster update.
describe("CollaborationVoiceRoomDurableObject silent sockets", () => {
  it("rechecks a silent recipient whose access check is stale and retires it", async () => {
    const room = createVoiceRoom({ ...VOICE_ENABLED_ENV, DB: {} } as Env);
    const silent = room.join(MEMBER_ID, 1, { accessCheckedAt: 0 });
    const peer = room.join(PEER_ID);
    vi.mocked(getCollaborationRoomAccess).mockImplementation(async (_db, _room, userId) =>
      userId === MEMBER_ID ? null : roomAccess("editor", 1),
    );

    await room.message(peer, {
      type: "voice.mute-changed",
      version: COLLABORATION_VOICE_PROTOCOL_VERSION,
      revision: 1,
      muted: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getCollaborationRoomAccess).toHaveBeenCalledWith(expect.anything(), ROOM_ID, MEMBER_ID);
    expect(silent.closeCode).toBe(4003);
    expect(peer.messages()).toContainEqual(
      expect.objectContaining({ type: "voice.participant-left" }),
    );
  });

  it("leaves a recipient whose access check is fresh alone", async () => {
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    const listener = room.join(MEMBER_ID);
    const peer = room.join(PEER_ID);

    await room.message(peer, {
      type: "voice.mute-changed",
      version: COLLABORATION_VOICE_PROTOCOL_VERSION,
      revision: 1,
      muted: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getCollaborationRoomAccess).not.toHaveBeenCalled();
    expect(listener.closeCode).toBeNull();
  });
});

// The voice socket was checked against the sign-in session only at its
// upgrade, so a signed-out member kept their seat, their roster row and the
// media already negotiated.
describe("CollaborationVoiceRoomDurableObject signed-out sessions", () => {
  it("retires a socket whose session was signed out when it is revalidated", async () => {
    const room = createVoiceRoom({ ...VOICE_ENABLED_ENV, DB: {} } as Env);
    const member = room.join(MEMBER_ID, 1, { accessCheckedAt: 0 });
    const peer = room.join(PEER_ID);
    // The membership is unchanged, as after a sign-out.
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(roomAccess("editor", 1));
    vi.mocked(getSessionUser).mockResolvedValue(null);

    await room.message(member, {
      type: "voice.mute-changed",
      version: COLLABORATION_VOICE_PROTOCOL_VERSION,
      revision: 1,
      muted: false,
    });

    expect(getSessionUser).toHaveBeenCalledWith(expect.anything(), authSessionOf(MEMBER_ID));
    expect(member.closeCode).toBe(4003);
    expect(peer.messages()).toContainEqual(
      expect.objectContaining({ type: "voice.participant-left" }),
    );
    expect(peer.messages()).not.toContainEqual(
      expect.objectContaining({
        type: "voice.participant-upsert",
        participant: expect.objectContaining({ userId: MEMBER_ID, muted: false }),
      }),
    );
  });

  it("keeps a socket whose session is still signed in", async () => {
    const room = createVoiceRoom({ ...VOICE_ENABLED_ENV, DB: {} } as Env);
    const member = room.join(MEMBER_ID, 1, { accessCheckedAt: 0 });
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(roomAccess("editor", 1));

    await room.message(member, {
      type: "voice.mute-changed",
      version: COLLABORATION_VOICE_PROTOCOL_VERSION,
      revision: 1,
      muted: false,
    });

    expect(member.closeCode).toBeNull();
  });
});

// A removal was acknowledged as delivered before the removed member's SFU
// tracks were confirmed closed: the close was fire-and-forget, a failure was
// dropped silently, and the retired socket's attachment, the only record of
// the session and mids, was gone, so nothing could retry it.
describe("CollaborationVoiceRoomDurableObject upstream releases", () => {
  const CLOSE_URL = "https://rtc.live.cloudflare.com/v1/apps/app/sessions/session-a/tracks/close";
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function joinReceiving(room: ReturnType<typeof createVoiceRoom>) {
    return room.join(MEMBER_ID, 1, {
      sfuSessionId: "session-a",
      receivingMids: ["1", "2"],
      receivingTracks: [
        { sessionId: "session-p", trackName: "t1", mid: "1" },
        { sessionId: "session-p", trackName: "t2", mid: "2" },
      ],
    });
  }

  const closed = () => Response.json({ tracks: [{ mid: "1" }, { mid: "2" }] });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("network"))],
    ["a 500", async () => new Response("{}", { status: 500 })],
    [
      "a per-track error",
      async () => Response.json({ tracks: [{ mid: "1", errorCode: "x" }, { mid: "2" }] }),
    ],
  ])("does not report a removal delivered after %s, and retries it", async (_label, failure) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementationOnce(failure);
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    const member = joinReceiving(room);

    const response = await room.control(2, MEMBER_ID, null);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ delivered: false });
    expect(member.closeCode).toBe(4003);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0][0]).toBe(CLOSE_URL);
    expect(JSON.parse(String(upstream.mock.calls[0][1]?.body))).toEqual({
      tracks: [{ mid: "1" }, { mid: "2" }],
      force: true,
    });
    expect(room.storage.alarmAt).not.toBeNull();

    // The owner's retry reaches a session the object still remembers.
    upstream.mockImplementationOnce(async () => closed());
    const retry = await room.control(3, MEMBER_ID, null);

    expect(retry.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream.mock.calls[1][0]).toBe(CLOSE_URL);
  });

  it("reports a removal delivered once Realtime confirms the close", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => closed());
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    joinReceiving(room);

    const response = await room.control(2, MEMBER_ID, null);

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    // Nothing is left for the alarm to do.
    await room.instance.alarm();
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("retries a release from a socket that closed on its own until it is confirmed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => Promise.reject(new TypeError("network")));
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    const member = joinReceiving(room);

    room.instance.webSocketClose(member as unknown as WebSocket);
    await settle();
    expect(upstream).toHaveBeenCalledOnce();

    upstream.mockImplementationOnce(async () => closed());
    room.storage.alarmAt = null;
    await room.instance.alarm();

    expect(upstream).toHaveBeenCalledTimes(2);
    expect(room.storage.alarmAt).toBeNull();
  });

  it("gives up on a release Realtime never confirms after the retry window", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.reject(new TypeError("network")));
    const room = createVoiceRoom(VOICE_ENABLED_ENV);
    joinReceiving(room);
    await room.control(2, MEMBER_ID, null);

    now.mockReturnValue(1_700_000_000_000 + 11 * 60 * 1000);
    await room.instance.alarm();

    expect(logged).toHaveBeenCalledWith(
      "collaboration_voice_release_abandoned",
      expect.objectContaining({ mids: 2 }),
    );
    expect(upstream).toHaveBeenCalledOnce();
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
