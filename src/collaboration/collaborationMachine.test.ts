import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  collaborationRoomChannel,
  type CollaborationRoomSession,
} from "./protocol";
import { collaborationMachine } from "./collaborationMachine";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "20000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "30000000-0000-4000-8000-000000000001";

function roomSession(role: "owner" | "editor" | "viewer" = "editor"): CollaborationRoomSession {
  return {
    room: {
      id: ROOM_ID,
      ownerId: "40000000-0000-4000-8000-000000000001",
      hostUserId: "40000000-0000-4000-8000-000000000001",
      status: "active",
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
      roleVersion: 1,
      maxMembers: 10,
      createdAt: 1,
      updatedAt: 1,
    },
    membership: { role },
    channel: collaborationRoomChannel(ROOM_ID),
  };
}

describe("collaborationMachine", () => {
  it("moves through connect, sync, live, reconnect, and leave", () => {
    const actor = createActor(collaborationMachine).start();
    actor.send({ type: "CONNECT", roomId: ROOM_ID, sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    expect(actor.getSnapshot().value).toBe("connecting");
    actor.send({ type: "PROVIDER_OPEN", sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    expect(actor.getSnapshot().value).toBe("syncing");
    actor.send({
      type: "SYNCED",
      sessionId: SESSION_ID,
      attemptId: ATTEMPT_ID,
      roomSession: roomSession(),
    });
    expect(actor.getSnapshot().value).toBe("live");
    actor.send({ type: "OFFLINE_CHANGES" });
    expect(actor.getSnapshot().context.hasOfflineChanges).toBe(true);
    actor.send({ type: "DISCONNECTED", sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    expect(actor.getSnapshot().value).toBe("reconnecting");
    actor.send({
      type: "RETRY",
      sessionId: SESSION_ID,
      attemptId: "30000000-0000-4000-8000-000000000002",
      attempt: 1,
    });
    expect(actor.getSnapshot().value).toBe("connecting");
    actor.send({ type: "LEAVE" });
    expect(actor.getSnapshot()).toMatchObject({ value: "disconnected", context: { roomId: null } });
  });

  it("ignores late events from a replaced provider attempt", () => {
    const actor = createActor(collaborationMachine).start();
    actor.send({ type: "CONNECT", roomId: ROOM_ID, sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    actor.send({ type: "DISCONNECTED", sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    const nextAttempt = "30000000-0000-4000-8000-000000000002";
    actor.send({ type: "RETRY", sessionId: SESSION_ID, attemptId: nextAttempt, attempt: 1 });
    actor.send({ type: "PROVIDER_OPEN", sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    expect(actor.getSnapshot().value).toBe("connecting");
    actor.send({ type: "PROVIDER_OPEN", sessionId: SESSION_ID, attemptId: nextAttempt });
    expect(actor.getSnapshot().value).toBe("syncing");
  });

  it("applies an immediate role downgrade", () => {
    const actor = createActor(collaborationMachine).start();
    actor.send({ type: "CONNECT", roomId: ROOM_ID, sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    actor.send({ type: "PROVIDER_OPEN", sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    actor.send({
      type: "SYNCED",
      sessionId: SESSION_ID,
      attemptId: ATTEMPT_ID,
      roomSession: roomSession("editor"),
    });
    actor.send({ type: "ROLE_CHANGED", role: "viewer", roleVersion: 2 });
    expect(actor.getSnapshot().context).toMatchObject({ role: "viewer", room: { roleVersion: 2 } });
  });
});
