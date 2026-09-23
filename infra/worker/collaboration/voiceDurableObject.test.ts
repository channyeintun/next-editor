import { describe, expect, it, vi } from "vitest";
import type { CollaborationRole } from "../../../src/collaboration/protocol";
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

let nextId = 1;
function uuid(): string {
  return `40000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
}

function createVoiceRoom() {
  const sockets: FakeWebSocket[] = [];
  const ctx = {
    id: { name: ROOM_ID },
    setWebSocketAutoResponse: () => undefined,
    getWebSockets: () => sockets,
  };
  const room = new CollaborationVoiceRoomDurableObject(
    ctx as unknown as DurableObjectState,
    {} as Env,
  );

  /** A joined voice socket as acceptConnection leaves it (the 101 upgrade needs workerd). */
  function join(userId: string, roleVersion = 1): FakeWebSocket {
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

  return { join, control };
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
