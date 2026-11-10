import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
  decodeCollaborationAwarenessProtocolUpdate,
  decodeCollaborationBinaryFrame,
  encodeCollaborationAwarenessProtocolUpdate,
  encodeCollaborationAwarenessUpdate,
  encodeCollaborationClientUpdate,
  encodeCollaborationSyncStep1,
  type CollaborationBinaryFrame,
} from "../../../src/collaboration/binaryProtocol";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_SQLITE_PERSISTENCE_VERSION,
  MAX_COLLABORATION_EDITOR_SCROLL_LEFT_PX,
  MAX_COLLABORATION_EDITOR_TOP_DELTA_PX,
  type CollaborationBootstrapResponse,
  type CollaborationRole,
} from "../../../src/collaboration/protocol";
import { seedCollaborationProject } from "../../../src/collaboration/projectDocument";
import { seedCollaborationTeachingDocument } from "../../../src/collaboration/teachingDocument";
import { isCollaborationTeachingInitialized } from "../../../src/collaboration/teachingRoot";
import {
  applyEncodedYjsSnapshot,
  encodeYjsDocument,
  encodeYjsSnapshotUpdate,
  encodeYjsUpdate,
} from "../../../src/collaboration/yjsUpdates";
import { createStarterHtmlCssWorkspace } from "../../../src/starters/htmlCss";
import {
  getCollaborationAsset,
  getCollaborationRoomAccess,
  type CollaborationRoomAccess,
} from "../../db/collaborationQueries";
import { getSessionUser } from "../../db/queries";
import type { Env } from "../env";
import { FakeWebSocket } from "../testing/fakeWebSocket";
import { SqliteTestStorage } from "../testing/sqliteStorage";
import { stubWebSocketUpgrade } from "../testing/webSocketUpgrade";
import { CollaborationRoomDurableObject } from "./roomDurableObject";
import {
  CollaborationRoomSqliteQuotaError,
  RoomSqliteDocumentStore,
} from "./roomSqliteDocumentStore";

vi.mock("../../db/collaborationQueries", () => ({
  getCollaborationRoomAccess: vi.fn<typeof getCollaborationRoomAccess>(),
  getCollaborationAsset: vi.fn<typeof getCollaborationAsset>(),
}));

vi.mock("../../db/queries", () => ({
  getSessionUser: vi.fn<typeof getSessionUser>(),
}));

vi.stubGlobal(
  "WebSocketRequestResponsePair",
  class {
    constructor(
      readonly request: string,
      readonly response: string,
    ) {}
  },
);

const ROOM_ORIGIN = "https://collaboration-room.internal";
const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = "20000000-0000-4000-8000-000000000001";
const MEMBER_ID = "20000000-0000-4000-8000-000000000002";
const PEER_ID = "20000000-0000-4000-8000-000000000003";
const CLIENT_ID = "30000000-0000-4000-8000-000000000001";

let nextId = 1;
function uuid(): string {
  return `40000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
}

/** A fake hibernatable socket that also decodes the room's binary frames. */
class FakeSocket extends FakeWebSocket {
  frames(): CollaborationBinaryFrame[] {
    return this.sent.flatMap((message) =>
      typeof message === "string" ? [] : [decodeCollaborationBinaryFrame(message)],
    );
  }
}

stubWebSocketUpgrade(() => new FakeSocket());

class RoomTestStorage extends SqliteTestStorage {
  async getAlarm(): Promise<number | null> {
    return null;
  }

  async setAlarm(): Promise<void> {}
}

function roomAccess(role: CollaborationRole, roleVersion: number): CollaborationRoomAccess {
  return {
    id: ROOM_ID,
    owner_id: OWNER_ID,
    host_user_id: OWNER_ID,
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const openStorages: RoomTestStorage[] = [];

afterEach(() => {
  for (const storage of openStorages.splice(0)) storage.close();
  vi.restoreAllMocks();
});

/** The auth session the Worker saw sign `userId` in; see signedInAs. */
function authSessionOf(userId: string): string {
  return `session-of-${userId}`;
}

/** Every authSessionOf session is signed in, unless a test signs it out. */
function signedInAs(_db: unknown, authSessionId: string) {
  const prefix = "session-of-";
  return Promise.resolve(
    authSessionId.startsWith(prefix)
      ? ({ id: authSessionId.slice(prefix.length) } as Awaited<ReturnType<typeof getSessionUser>>)
      : null,
  );
}

beforeEach(() => {
  vi.mocked(getCollaborationRoomAccess).mockReset();
  vi.mocked(getSessionUser).mockReset().mockImplementation(signedInAs);
});

/** A room whose durable document starts as `seed` leaves the shared test document. */
async function createRoom(
  seed: (doc: Y.Doc) => void = (doc) => doc.getText("scratch").insert(0, "seed"),
) {
  const storage = new RoomTestStorage();
  openStorages.push(storage);
  const sockets: FakeSocket[] = [];
  const ctx = {
    id: { name: ROOM_ID },
    storage,
    setWebSocketAutoResponse: () => undefined,
    getWebSockets: () => sockets,
    acceptWebSocket: (socket: FakeSocket) => sockets.push(socket),
  };
  const room = new CollaborationRoomDurableObject(
    ctx as unknown as DurableObjectState,
    { DB: {} } as Env,
  );
  // The shared document every participant edits in these tests.
  const doc = new Y.Doc();
  seed(doc);
  const initialized = await room.fetch(
    new Request(`${ROOM_ORIGIN}/sqlite/initialize`, {
      method: "POST",
      body: JSON.stringify({ roomId: ROOM_ID, snapshot: encodeYjsDocument(doc) }),
    }),
  );
  expect(initialized.status).toBe(200);

  /**
   * A socket as acceptConnection leaves it, placed directly. It skips the
   * upgrade, so it can set the role version, the last access check and the
   * member's profile.
   */
  function connect(
    userId: string,
    role: CollaborationRole,
    options: {
      roleVersion?: number;
      accessCheckedAt?: number;
      username?: string;
      name?: string | null;
      avatarUrl?: string | null;
    } = {},
  ): FakeSocket {
    const socket = new FakeSocket();
    const session = canonicalSession(userId, role, uuid(), options.roleVersion ?? 1);
    socket.serializeAttachment({
      ...session,
      username: options.username ?? session.username,
      name: options.name ?? session.name,
      avatarUrl: options.avatarUrl ?? session.avatarUrl,
      accessCheckedAt: options.accessCheckedAt ?? Date.now(),
    });
    sockets.push(socket);
    return socket;
  }

  /** Opens an editor's socket through the room's WebSocket upgrade. */
  async function upgrade(
    userId: string,
    sessionId: string,
    roleVersion = 1,
  ): Promise<{ response: Response; socket: FakeSocket | null }> {
    const session = canonicalSession(userId, "editor", sessionId, roleVersion);
    const response = await room.fetch(
      new Request(`${ROOM_ORIGIN}/websocket`, {
        headers: {
          Upgrade: "websocket",
          "X-Collaboration-Session": encodeURIComponent(JSON.stringify(session)),
        },
      }),
    );
    return { response, socket: response.status === 101 ? sockets.at(-1)! : null };
  }

  /** Loses `socket`'s client: workerd stops listing it, then reports the close. */
  function disconnect(socket: FakeSocket): void {
    socket.close(1006);
    sockets.splice(sockets.indexOf(socket), 1);
    room.webSocketClose(socket as never);
  }

  /** A fresh instance of this room's object over the same storage, as after an eviction. */
  function restart(): CollaborationRoomDurableObject {
    return new CollaborationRoomDurableObject(
      ctx as unknown as DurableObjectState,
      { DB: {} } as Env,
    );
  }

  /** Appends `text` to the shared document and returns it as a client-update frame. */
  function edit(text: string, updateId = uuid()): ArrayBuffer {
    const before = Y.encodeStateVector(doc);
    doc.getText("scratch").insert(doc.getText("scratch").length, text);
    return toArrayBuffer(
      encodeCollaborationClientUpdate({
        clientId: CLIENT_ID,
        updateId,
        update: Y.encodeStateAsUpdate(doc, before),
      }),
    );
  }

  /** The text a client sees after loading the room's durable document. */
  async function persistedText(): Promise<string> {
    const response = await room.fetch(
      new Request(`${ROOM_ORIGIN}/sqlite/export`, { method: "POST" }),
    );
    const exported = (await response.json()) as CollaborationBootstrapResponse;
    const restored = new Y.Doc();
    applyEncodedYjsSnapshot(restored, exported.snapshot.update, "test");
    const text = restored.getText("scratch").toString();
    restored.destroy();
    return text;
  }

  function control(
    roleVersion: number,
    targetUserId: string,
    targetRole: CollaborationRole | null,
  ) {
    return room.fetch(
      new Request(`${ROOM_ORIGIN}/control`, {
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
      new Request(`${ROOM_ORIGIN}/control`, {
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

  return {
    room,
    doc,
    connect,
    upgrade,
    disconnect,
    restart,
    edit,
    persistedText,
    control,
    closeRoom,
  };
}

/** The session the Worker hands the room when a member opens a socket. */
function canonicalSession(
  userId: string,
  role: CollaborationRole,
  sessionId: string,
  roleVersion = 1,
) {
  return {
    roomId: ROOM_ID,
    userId,
    username: `user-${userId.slice(-1)}`,
    name: null,
    avatarUrl: null,
    hostUserId: OWNER_ID,
    role,
    roleVersion,
    sessionId,
    attemptId: uuid(),
    authSessionId: authSessionOf(userId),
  };
}

function awarenessFrame(socket: FakeSocket, clientId: number, clock: number): ArrayBuffer {
  const { sessionId } = socket.deserializeAttachment() as { sessionId: string };
  return toArrayBuffer(
    encodeCollaborationAwarenessUpdate(
      encodeCollaborationAwarenessProtocolUpdate([
        {
          clientId,
          clock,
          state: {
            collaboration: {
              kind: "state",
              sessionId,
              revision: clock,
              surface: { kind: "slides", isMaximized: false },
              cursor: null,
            },
          },
        },
      ]),
    ),
  );
}

function acks(socket: FakeSocket) {
  return socket.messages().filter((message) => message.type === "document.ack");
}

function errors(socket: FakeSocket) {
  return socket.messages().filter((message) => message.type === "error");
}

describe("CollaborationRoomDurableObject document initialization", () => {
  // Every later update is checked against the project root's structure, so a
  // creation snapshot that already breaks it would leave the room unusable.
  it("refuses a creation snapshot whose project root is malformed, storing nothing", async () => {
    const storage = new RoomTestStorage();
    openStorages.push(storage);
    const ctx = {
      id: { name: ROOM_ID },
      storage,
      setWebSocketAutoResponse: () => undefined,
      getWebSockets: () => [],
    };
    const room = new CollaborationRoomDurableObject(
      ctx as unknown as DurableObjectState,
      { DB: {} } as Env,
    );
    const doc = new Y.Doc();
    doc.getMap("project").set("schemaVersion", 2);

    const response = await room.fetch(
      new Request(`${ROOM_ORIGIN}/sqlite/initialize`, {
        method: "POST",
        body: JSON.stringify({ roomId: ROOM_ID, snapshot: encodeYjsDocument(doc) }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid collaboration snapshot" });
    await expect(
      room.fetch(new Request(`${ROOM_ORIGIN}/sqlite/export`, { method: "POST" })),
    ).rejects.toThrow(/not initialized/);
  });
});

// A repeated close republished the purge job every time. The room now
// remembers whether this close's purge is published, and holds a claim for a
// minute so a publish in flight (or one that just failed) is not doubled.
describe("CollaborationRoomDurableObject closed-room cleanup schedule", () => {
  const CLOSED_AT = 1_700_000_000_000;

  async function cleanup(room: CollaborationRoomDurableObject, step: "claim" | "confirm") {
    const response = await room.fetch(
      new Request(`${ROOM_ORIGIN}/cleanup/${step}`, {
        method: "POST",
        body: JSON.stringify({ roomId: ROOM_ID, closedAt: CLOSED_AT }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { claimed?: boolean };
  }

  it("lets one close publish, holds the next for a minute, then lets a retry through", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(CLOSED_AT);
    const { room } = await createRoom();

    expect(await cleanup(room, "claim")).toEqual({ claimed: true });
    expect(await cleanup(room, "claim")).toEqual({ claimed: false });
    now.mockReturnValue(CLOSED_AT + 61_000);
    expect(await cleanup(room, "claim")).toEqual({ claimed: true });
  });

  it("never claims again once the publish is confirmed", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(CLOSED_AT);
    const { room } = await createRoom();
    await cleanup(room, "claim");
    await cleanup(room, "confirm");

    now.mockReturnValue(CLOSED_AT + 24 * 60 * 60 * 1000);
    expect(await cleanup(room, "claim")).toEqual({ claimed: false });
  });
});

describe("CollaborationRoomDurableObject document updates", () => {
  it("persists an editor's update, acknowledges it and fans it out", async () => {
    const { room, connect, edit, persistedText } = await createRoom();
    const editor = connect(MEMBER_ID, "editor");
    const peer = connect(PEER_ID, "viewer");

    await room.webSocketMessage(editor as never, edit("+edit"));

    expect(acks(editor)).toHaveLength(1);
    expect(peer.frames().map((frame) => frame.kind)).toEqual(["server-update"]);
    expect(await persistedText()).toBe("seed+edit");
  });

  it("serves an accepted update to the next sync request", async () => {
    const { room, connect, edit } = await createRoom();
    const editor = connect(MEMBER_ID, "editor");
    const joining = connect(PEER_ID, "viewer");

    await room.webSocketMessage(editor as never, edit("+edit"));
    const fresh = new Y.Doc();
    await room.webSocketMessage(
      joining as never,
      toArrayBuffer(encodeCollaborationSyncStep1(fresh)),
    );

    const reply = joining.frames().find((frame) => frame.kind === "sync");
    Y.applyUpdate(fresh, (reply as { payload: Uint8Array }).payload);
    expect(fresh.getText("scratch").toString()).toBe("seed+edit");
  });

  it("fans out the stored update when a retry reuses its update ID", async () => {
    const { room, connect, edit, persistedText } = await createRoom();
    const editor = connect(MEMBER_ID, "editor");
    const peer = connect(PEER_ID, "viewer");
    const updateId = uuid();

    await room.webSocketMessage(editor as never, edit("+first", updateId));
    await room.webSocketMessage(editor as never, edit("+changed", updateId));

    expect(acks(editor)).toEqual([
      expect.objectContaining({ duplicate: false }),
      expect.objectContaining({ duplicate: true }),
    ]);
    // Both fan-outs carry the first update's stream ID and bytes.
    const [original, retry] = peer.frames();
    expect(retry).toEqual(original);
    expect(await persistedText()).toBe("seed+first");
  });

  it("refuses a viewer's update without persisting or broadcasting it", async () => {
    const { room, connect, edit, persistedText } = await createRoom();
    const viewer = connect(MEMBER_ID, "viewer");
    const peer = connect(PEER_ID, "editor");

    await room.webSocketMessage(viewer as never, edit("+nope"));

    expect(errors(viewer)).toEqual([expect.objectContaining({ code: "read-only" })]);
    expect(peer.sent).toEqual([]);
    expect(await persistedText()).toBe("seed");
  });

  it("rejects an empty client update instead of throwing", async () => {
    const { room, connect } = await createRoom();
    const editor = connect(MEMBER_ID, "editor");
    const empty = encodeCollaborationClientUpdate({
      clientId: CLIENT_ID,
      updateId: uuid(),
      update: new Uint8Array(0),
    });

    await room.webSocketMessage(editor as never, toArrayBuffer(empty));

    expect(errors(editor)).toEqual([expect.objectContaining({ code: "invalid-message" })]);
    expect(editor.closeCode).toBe(1008);
  });

  it("applies a /control demotion to the member's open socket", async () => {
    const { room, connect, edit, control, persistedText } = await createRoom();
    const member = connect(MEMBER_ID, "editor");

    expect((await control(2, MEMBER_ID, "viewer")).status).toBe(200);
    await room.webSocketMessage(member as never, edit("+nope"));

    expect(errors(member)).toEqual([expect.objectContaining({ code: "read-only" })]);
    expect(await persistedText()).toBe("seed");
  });

  it("closes a removed member's socket", async () => {
    const { connect, control } = await createRoom();
    const member = connect(MEMBER_ID, "editor");

    await control(2, MEMBER_ID, null);

    expect(member.closeCode).toBe(4003);
  });

  // Each membership route POSTs /control from its own Worker invocation, so
  // two quick changes can arrive in the opposite order to their D1 commits.
  it("ignores a role command older than the one already applied", async () => {
    const { room, connect, edit, control, persistedText } = await createRoom();
    const member = connect(MEMBER_ID, "editor");

    await control(3, MEMBER_ID, "viewer");
    await control(2, MEMBER_ID, "editor");
    await room.webSocketMessage(member as never, edit("+nope"));

    expect(errors(member)).toEqual([expect.objectContaining({ code: "read-only" })]);
    expect(await persistedText()).toBe("seed");
  });

  // The role version is room-wide: another member's change can raise this
  // socket's version before the removal arrives, and a repeated removal
  // carries the version the room already has.
  it("closes a removed member even when a later change reached the room first", async () => {
    const { connect, control } = await createRoom();
    const member = connect(MEMBER_ID, "editor");

    await control(3, PEER_ID, "editor");
    await control(2, MEMBER_ID, null);

    expect(member.closeCode).toBe(4003);
  });

  it("closes a removed member when the owner repeats the removal", async () => {
    const { connect, control } = await createRoom();
    const member = connect(MEMBER_ID, "editor", { roleVersion: 2 });

    await control(2, MEMBER_ID, null);

    expect(member.closeCode).toBe(4003);
  });

  // The byte quota never goes down, so the same update would be refused on
  // every reconnect: the refusal ends the session instead of inviting a retry.
  it("refuses an update over the room's byte quota as fatal", async () => {
    const { room, connect, edit } = await createRoom();
    const editor = connect(MEMBER_ID, "editor");
    const updateId = uuid();
    vi.spyOn(RoomSqliteDocumentStore.prototype, "appendDecoded").mockImplementationOnce(() => {
      throw new CollaborationRoomSqliteQuotaError();
    });

    await room.webSocketMessage(editor as never, edit("+big", updateId));

    expect(errors(editor)).toEqual([
      expect.objectContaining({ code: "quota-exceeded", fatal: true, updateId }),
    ]);
    expect(acks(editor)).toEqual([]);
  });

  it("closes with 1011 so the client retries when an update cannot be persisted", async () => {
    const { room, connect, edit } = await createRoom();
    const editor = connect(MEMBER_ID, "editor");
    const updateId = uuid();
    vi.spyOn(RoomSqliteDocumentStore.prototype, "appendDecoded").mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    await room.webSocketMessage(editor as never, edit("+lost", updateId));

    expect(errors(editor)).toEqual([
      expect.objectContaining({ code: "persistence-failed", fatal: false, updateId }),
    ]);
    expect(editor.closeCode).toBe(1011);
  });
});

// Yjs holds back a struct whose origin is missing, and a deletion past a
// client's clock, and applies them inside whichever later update supplies the
// dependency. Accepted, they were validated in that other member's update
// instead of the sender's: a forbidden write then got the victim's edits
// refused, and a deletion of the victim's future clocks erased everything they
// typed afterwards.
describe("CollaborationRoomDurableObject updates with missing dependencies", () => {
  const VICTIM_CLIENT = 1001;

  function clientUpdate(update: Uint8Array): ArrayBuffer {
    return toArrayBuffer(
      encodeCollaborationClientUpdate({ clientId: CLIENT_ID, updateId: uuid(), update }),
    );
  }

  it("refuses a write held back on another member's next edit", async () => {
    const { room, doc, connect, persistedText } = await createRoom();
    const owner = connect(OWNER_ID, "owner");
    const editor = connect(MEMBER_ID, "editor");
    const victim = new Y.Doc();
    victim.clientID = VICTIM_CLIENT;
    Y.applyUpdate(victim, Y.encodeStateAsUpdate(doc));
    const beforeVictimEdit = Y.encodeStateVector(victim);
    victim.getText("scratch").insert(victim.getText("scratch").length, "o");
    const victimEdit = Y.encodeStateAsUpdate(victim, beforeVictimEdit);
    const attacker = new Y.Doc();
    Y.applyUpdate(attacker, Y.encodeStateAsUpdate(victim));
    attacker.clientID = 4242;
    attacker.getText("scratch").insert(attacker.getText("scratch").length, "x");
    attacker.getMap("project").set("schemaVersion", 99);
    // Everything the attacker wrote waits on the victim's unsent edit.
    const planted = Y.encodeStateAsUpdate(attacker, Y.encodeStateVector(victim));

    await room.webSocketMessage(editor as never, clientUpdate(planted));
    await room.webSocketMessage(owner as never, clientUpdate(victimEdit));

    expect(acks(editor)).toEqual([]);
    expect(errors(editor)).toEqual([
      expect.objectContaining({ code: "invalid-message", fatal: true }),
    ]);
    expect(editor.closeCode).toBe(1008);
    expect(errors(owner)).toEqual([]);
    expect(acks(owner)).toHaveLength(1);
    expect(await persistedText()).toBe("seedo");
  });

  it("refuses a deletion of another member's future edits", async () => {
    const { room, doc, connect, persistedText } = await createRoom();
    const owner = connect(OWNER_ID, "owner");
    const editor = connect(MEMBER_ID, "editor");
    const forged = new Y.Doc();
    forged.clientID = VICTIM_CLIENT;
    Y.applyUpdate(forged, Y.encodeStateAsUpdate(doc));
    forged.getText("scratch").insert(0, "x".repeat(50));
    forged.getText("scratch").delete(0, 50);
    // No structs, only the deletion of the victim's first 50 clocks.
    const deletion = Y.encodeStateAsUpdate(forged, Y.encodeStateVector(forged));
    const victim = new Y.Doc();
    victim.clientID = VICTIM_CLIENT;
    Y.applyUpdate(victim, Y.encodeStateAsUpdate(doc));
    const beforeVictimEdit = Y.encodeStateVector(victim);
    victim.getText("scratch").insert(victim.getText("scratch").length, "o");

    await room.webSocketMessage(editor as never, clientUpdate(deletion));
    await room.webSocketMessage(
      owner as never,
      clientUpdate(Y.encodeStateAsUpdate(victim, beforeVictimEdit)),
    );

    expect(acks(editor)).toEqual([]);
    expect(errors(editor)).toEqual([
      expect.objectContaining({ code: "invalid-message", fatal: true }),
    ]);
    expect(acks(owner)).toHaveLength(1);
    expect(await persistedText()).toBe("seedo");
  });

  // The client's outbox is stop-and-wait, so its next update never runs ahead
  // of one the room has not acknowledged.
  it("still accepts an update that depends only on acknowledged state", async () => {
    const { room, connect, edit, persistedText } = await createRoom();
    const editor = connect(MEMBER_ID, "editor");

    await room.webSocketMessage(editor as never, edit("+one"));
    await room.webSocketMessage(editor as never, edit("+two"));

    expect(acks(editor)).toHaveLength(2);
    expect(await persistedText()).toBe("seed+one+two");
  });
});

describe("CollaborationRoomDurableObject sync requests", () => {
  it("answers a state vector with the missing document state", async () => {
    const { room, connect } = await createRoom();
    const member = connect(MEMBER_ID, "viewer");
    const empty = new Y.Doc();

    await room.webSocketMessage(
      member as never,
      toArrayBuffer(encodeCollaborationSyncStep1(empty)),
    );

    const [reply] = member.frames();
    expect(reply).toMatchObject({ kind: "sync", messageType: syncProtocol.messageYjsSyncStep2 });
    Y.applyUpdate(empty, (reply as { payload: Uint8Array }).payload);
    expect(empty.getText("scratch").toString()).toBe("seed");
  });

  it("rejects a state vector that does not decode", async () => {
    const { room, connect } = await createRoom();
    const member = connect(MEMBER_ID, "viewer");
    // Protocol v3, sync frame, step 1, a one-byte payload claiming five clients.
    const truncated = new Uint8Array([3, 0, syncProtocol.messageYjsSyncStep1, 1, 5]);

    await room.webSocketMessage(member as never, toArrayBuffer(truncated));

    expect(errors(member)).toEqual([expect.objectContaining({ code: "invalid-message" })]);
    expect(member.closeCode).toBe(1008);
  });
});

// A client sends one sync request per connection, and each answer can carry
// the whole document, so a socket asking many times a second is flooding.
describe("CollaborationRoomDurableObject sync request rate limits", () => {
  const syncReplies = (socket: FakeSocket) =>
    socket.frames().filter((frame) => frame.kind === "sync");

  it.each(["editor", "viewer"] as const)(
    "answers at most five sync requests a second from a socket with the %s role",
    async (role) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      const { room, connect } = await createRoom();
      const member = connect(MEMBER_ID, role);
      const other = connect(PEER_ID, "viewer");
      const request = toArrayBuffer(encodeCollaborationSyncStep1(new Y.Doc()));

      for (let index = 0; index < 8; index += 1) {
        await room.webSocketMessage(member as never, request);
      }
      await room.webSocketMessage(other as never, request);

      expect(syncReplies(member)).toHaveLength(5);
      expect(errors(member)).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({ code: "rate-limited", fatal: false }),
        ),
      );
      expect(member.closeCode).toBeNull();
      expect(syncReplies(other)).toHaveLength(1);

      now.mockReturnValue(1_700_000_001_000);
      await room.webSocketMessage(member as never, request);

      expect(syncReplies(member)).toHaveLength(6);
    },
  );
});

describe("CollaborationRoomDurableObject teaching initialization", () => {
  function initializeTeaching(room: CollaborationRoomDurableObject, update: string) {
    return room.fetch(
      new Request(`${ROOM_ORIGIN}/sqlite/teaching/initialize`, {
        method: "POST",
        body: JSON.stringify({
          roomId: ROOM_ID,
          actorId: OWNER_ID,
          update: {
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
            clientId: CLIENT_ID,
            updateId: uuid(),
            update,
          },
        }),
      }),
    );
  }

  const seedProject = (doc: Y.Doc) =>
    seedCollaborationProject(doc, createStarterHtmlCssWorkspace());

  it("stores and broadcasts a teaching-only initialization", async () => {
    const { room, doc, connect } = await createRoom(seedProject);
    const peer = connect(PEER_ID, "viewer");
    const before = Y.encodeStateVector(doc);
    seedCollaborationTeachingDocument(doc, { slides: [], whiteboardElements: [] });

    const response = await initializeTeaching(
      room,
      encodeYjsSnapshotUpdate(Y.encodeStateAsUpdate(doc, before)),
    );

    expect(response.status).toBe(200);
    expect(peer.frames().map((frame) => frame.kind)).toEqual(["server-update"]);
    const joining = connect(MEMBER_ID, "viewer");
    const fresh = new Y.Doc();
    await room.webSocketMessage(
      joining as never,
      toArrayBuffer(encodeCollaborationSyncStep1(fresh)),
    );
    const reply = joining.frames().find((frame) => frame.kind === "sync");
    Y.applyUpdate(fresh, (reply as { payload: Uint8Array }).payload);
    expect(isCollaborationTeachingInitialized(fresh)).toBe(true);
  });

  it("answers bytes that are not a Yjs update without Yjs's own error text", async () => {
    const { room } = await createRoom(seedProject);

    // Three 0xff bytes: a varint that runs off the end of the update.
    const response = await initializeTeaching(room, "////");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid teaching initialization" });
  });

  it("names the document rule an initialization breaks", async () => {
    const { room, doc } = await createRoom(seedProject);
    const before = Y.encodeStateVector(doc);
    doc.getMap("project").set("schemaVersion", 2);

    const response = await initializeTeaching(
      room,
      encodeYjsUpdate(Y.encodeStateAsUpdate(doc, before)),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Unsupported collaboration document schema version",
    });
  });
});

describe("CollaborationRoomDurableObject update rate limits", () => {
  it("does not charge the room budget for updates a socket's own limit refused", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { room, connect, edit } = await createRoom();
    const flooding = connect(MEMBER_ID, "editor");
    const other = connect(PEER_ID, "editor");

    for (let index = 0; index < 125; index += 1) {
      await room.webSocketMessage(flooding as never, edit("x"));
    }
    // Its own document: an edit on the shared one would build on the
    // refused updates, which the room has never seen.
    const others = new Y.Doc();
    others.getText("other").insert(0, "+mine");
    await room.webSocketMessage(
      other as never,
      toArrayBuffer(
        encodeCollaborationClientUpdate({
          clientId: CLIENT_ID,
          updateId: uuid(),
          update: Y.encodeStateAsUpdate(others),
        }),
      ),
    );

    expect(acks(flooding)).toHaveLength(30);
    expect(errors(other)).toEqual([]);
    expect(acks(other)).toHaveLength(1);
  });

  it("still caps the whole room at 120 accepted updates a second", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { room, connect, edit } = await createRoom();
    const editors = Array.from({ length: 5 }, (_, index) =>
      connect(`20000000-0000-4000-8000-00000000001${index}`, "editor"),
    );

    for (const editor of editors) {
      for (let index = 0; index < 25; index += 1) {
        await room.webSocketMessage(editor as never, edit("x"));
      }
    }

    expect(editors.flatMap(acks)).toHaveLength(120);
    expect(editors.flatMap(errors)).toEqual(
      Array.from({ length: 5 }, () => expect.objectContaining({ code: "rate-limited" })),
    );
  });
});

// Every member sees the others' session IDs in awareness, so a session ID
// alone does not say whose socket it is.
describe("CollaborationRoomDurableObject session reconnects", () => {
  it("lets a member reconnect with their session ID while another member holds it", async () => {
    const { upgrade, disconnect } = await createRoom();
    const sessionId = uuid();
    const first = await upgrade(MEMBER_ID, sessionId);
    disconnect(first.socket!);
    await upgrade(PEER_ID, sessionId);

    const reconnect = await upgrade(MEMBER_ID, sessionId);

    expect(reconnect.response.status).toBe(101);
  });

  it("leaves another member's socket with the same session ID open", async () => {
    const { upgrade } = await createRoom();
    const sessionId = uuid();
    const member = await upgrade(MEMBER_ID, sessionId);

    const peer = await upgrade(PEER_ID, sessionId);
    await upgrade(MEMBER_ID, sessionId);

    expect(peer.response.status).toBe(101);
    expect(peer.socket!.closeCode).toBeNull();
    expect(member.socket!.closeCode).toBe(4000);
  });

  it("still replaces the same member's previous socket for that session ID", async () => {
    const { upgrade } = await createRoom();
    const sessionId = uuid();
    const first = await upgrade(MEMBER_ID, sessionId);

    const second = await upgrade(MEMBER_ID, sessionId);

    expect(second.response.status).toBe(101);
    expect(first.socket!.closeCode).toBe(4000);
    expect(second.socket!.closeCode).toBeNull();
  });
});

// Every budget the room keeps (sync answers, awareness, updates) is per
// socket, so without a per-member cap one member could multiply them by
// opening sockets with fresh session IDs.
describe("CollaborationRoomDurableObject concurrent sockets per member", () => {
  it("refuses a member's fifth concurrent socket and keeps the four open", async () => {
    const { upgrade } = await createRoom();
    const open = [];
    for (let index = 0; index < 4; index += 1) open.push(await upgrade(MEMBER_ID, uuid()));

    const fifth = await upgrade(MEMBER_ID, uuid());

    expect(open.map(({ response }) => response.status)).toEqual([101, 101, 101, 101]);
    expect(fifth.response.status).toBe(409);
    expect(fifth.socket).toBeNull();
    expect(open.map(({ socket }) => socket!.closeCode)).toEqual([null, null, null, null]);
  });

  it("still lets a member at the cap reconnect one of their sessions", async () => {
    const { upgrade } = await createRoom();
    const sessionIds = [uuid(), uuid(), uuid(), uuid()];
    const open = [];
    for (const sessionId of sessionIds) open.push(await upgrade(MEMBER_ID, sessionId));

    const reconnect = await upgrade(MEMBER_ID, sessionIds[0]);

    expect(reconnect.response.status).toBe(101);
    expect(open[0].socket!.closeCode).toBe(4000);
  });

  it("counts only the member's own sockets", async () => {
    const { upgrade } = await createRoom();
    for (let index = 0; index < 4; index += 1) await upgrade(MEMBER_ID, uuid());

    const peer = await upgrade(PEER_ID, uuid());

    expect(peer.response.status).toBe(101);
  });
});

describe("CollaborationRoomDurableObject awareness", () => {
  it("shows a participant again as soon as they republish after a reconnect", async () => {
    const { room, connect } = await createRoom();
    const first = connect(MEMBER_ID, "editor");
    const peer = connect(PEER_ID, "viewer");
    const peerAwareness = new awarenessProtocol.Awareness(new Y.Doc());
    const deliverToPeer = () => {
      for (const frame of peer.frames()) {
        if (frame.kind !== "awareness") continue;
        awarenessProtocol.applyAwarenessUpdate(peerAwareness, frame.update, "room");
      }
      peer.sent.length = 0;
    };

    await room.webSocketMessage(first as never, awarenessFrame(first, 7, 1));
    deliverToPeer();
    expect(peerAwareness.getStates().has(7)).toBe(true);

    first.close(1006);
    room.webSocketClose(first as never);
    deliverToPeer();
    expect(peerAwareness.getStates().has(7)).toBe(false);

    // The provider keeps its Awareness across reconnects, so its next clock is 2.
    const second = connect(MEMBER_ID, "editor");
    await room.webSocketMessage(second as never, awarenessFrame(second, 7, 2));
    deliverToPeer();
    expect(peerAwareness.getStates().has(7)).toBe(true);
    peerAwareness.destroy();
  });

  // y-protocols keeps one state per client ID, so the room lets only one open
  // socket publish each ID; without an owner, a disconnected member's ID
  // would go to whoever published it next.
  it("refuses an awareness client ID another member published first, even after they disconnected", async () => {
    const { room, connect, disconnect } = await createRoom();
    const first = connect(MEMBER_ID, "editor");
    await room.webSocketMessage(first as never, awarenessFrame(first, 7, 1));
    disconnect(first);

    const peer = connect(PEER_ID, "editor");
    await room.webSocketMessage(peer as never, awarenessFrame(peer, 7, 1));
    const second = connect(MEMBER_ID, "editor");
    await room.webSocketMessage(second as never, awarenessFrame(second, 7, 2));

    expect(errors(peer)).toEqual([expect.objectContaining({ code: "invalid-session" })]);
    expect(peer.closeCode).toBe(1008);
    expect(errors(second)).toEqual([]);
    expect(second.closeCode).toBeNull();
  });

  it("remembers awareness client owners across a restart", async () => {
    const { room, connect, disconnect, restart } = await createRoom();
    const member = connect(MEMBER_ID, "editor");
    await room.webSocketMessage(member as never, awarenessFrame(member, 7, 1));
    disconnect(member);

    const restarted = restart();
    const peer = connect(PEER_ID, "editor");
    await restarted.webSocketMessage(peer as never, awarenessFrame(peer, 7, 1));

    expect(errors(peer)).toEqual([expect.objectContaining({ code: "invalid-session" })]);
    expect(peer.closeCode).toBe(1008);
  });

  // A position that names a type resolves through Y.Doc.get, which creates
  // that root in every peer's document (y-monaco resolves remote selections
  // itself), so the room refuses the frame instead of relaying it.
  it("refuses a selection whose position names a root type, from any role", async () => {
    const { room, connect } = await createRoom();
    const viewer = connect(MEMBER_ID, "viewer");
    const peer = connect(PEER_ID, "editor");
    const { sessionId } = viewer.deserializeAttachment() as { sessionId: string };
    const named = { type: null, tname: "injected-root", item: null, assoc: 0 };
    const message = encodeCollaborationAwarenessUpdate(
      encodeCollaborationAwarenessProtocolUpdate([
        {
          clientId: 7,
          clock: 1,
          state: {
            collaboration: {
              kind: "state",
              sessionId,
              revision: 1,
              surface: { kind: "editor", fileNodeId: uuid(), viewport: null },
              cursor: null,
            },
            selection: { anchor: named, head: named },
          },
        },
      ]),
    );

    await room.webSocketMessage(viewer as never, toArrayBuffer(message));

    expect(errors(viewer)).toEqual([expect.objectContaining({ code: "invalid-message" })]);
    expect(viewer.closeCode).toBe(1008);
    expect(peer.frames()).toEqual([]);
  });

  // The largest state the schemas accept, with the display name in two-byte
  // text, which V8 stores at two bytes a character. Its attachment is about
  // 12.1 KB, about 4.2 KB under the 16,384 that serializeAttachment takes.
  // This is the worst case and
  // must stay green: a schema change that turns it red drops real members'
  // awareness.
  it("stores and relays a maximal schema-valid awareness state", async () => {
    const { room, connect, edit } = await createRoom();
    const member = connect(MEMBER_ID, "editor", {
      username: "u".repeat(64),
      name: "\u4e00".repeat(120),
      avatarUrl: "a".repeat(2048),
    });
    const peer = connect(PEER_ID, "viewer");
    const { sessionId } = member.deserializeAttachment() as { sessionId: string };
    const fileNodeId = uuid();
    const position = "A".repeat(2048);
    const id = { client: 0xffff_ffff, clock: Number.MAX_SAFE_INTEGER };
    const end = { type: id, tname: null, item: id, assoc: -1 };
    const message = encodeCollaborationAwarenessUpdate(
      encodeCollaborationAwarenessProtocolUpdate([
        {
          clientId: 0xffff_ffff,
          clock: Number.MAX_SAFE_INTEGER,
          state: {
            collaboration: {
              kind: "state",
              sessionId,
              revision: Number.MAX_SAFE_INTEGER,
              surface: {
                kind: "editor",
                fileNodeId,
                viewport: {
                  topAnchor: position,
                  topDeltaPx: MAX_COLLABORATION_EDITOR_TOP_DELTA_PX,
                  scrollLeftPx: MAX_COLLABORATION_EDITOR_SCROLL_LEFT_PX,
                },
              },
              cursor: { fileNodeId, anchor: position, head: position },
            },
            selection: { anchor: end, head: end },
          },
        },
      ]),
    );

    // An editor who has typed also carries the socket's update window.
    await room.webSocketMessage(member as never, edit("x"));
    peer.sent.length = 0;
    await room.webSocketMessage(member as never, toArrayBuffer(message));

    expect(peer.frames().map((frame) => frame.kind)).toEqual(["awareness"]);
    expect(member.deserializeAttachment()).toMatchObject({
      updateWindowCount: 1,
      awarenessState: { selection: { anchor: end, head: end } },
    });
  });

  it("carries a demotion into the member's stored awareness state", async () => {
    const { room, connect, control } = await createRoom();
    const member = connect(MEMBER_ID, "editor");
    await room.webSocketMessage(member as never, awarenessFrame(member, 7, 1));

    await control(2, MEMBER_ID, "viewer");

    expect(member.deserializeAttachment()).toMatchObject({
      awarenessState: { collaboration: { role: "viewer" } },
    });
  });
});

// The Worker reads D1 once for an upgrade and forwards that snapshot. A
// removal that commits after the read can reach the room first; its /control
// closed only the sockets open then, and the late upgrade got the access the
// member had just lost.
describe("CollaborationRoomDurableObject upgrades that predate an applied change", () => {
  it("refuses an upgrade read before a removal the room has applied", async () => {
    const { upgrade, control } = await createRoom();

    expect((await control(2, MEMBER_ID, null)).status).toBe(200);
    const late = await upgrade(MEMBER_ID, uuid(), 1);

    expect(late.response.status).toBe(403);
    expect(late.socket).toBeNull();
  });

  it("remembers the removal across a restart", async () => {
    const { control, restart } = await createRoom();
    await control(2, MEMBER_ID, null);

    const response = await restart().fetch(
      new Request(`${ROOM_ORIGIN}/websocket`, {
        headers: {
          Upgrade: "websocket",
          "X-Collaboration-Session": encodeURIComponent(
            JSON.stringify(canonicalSession(MEMBER_ID, "editor", uuid(), 1)),
          ),
        },
      }),
    );

    expect(response.status).toBe(403);
  });

  it("accepts the member again once they rejoin at a later version", async () => {
    const { upgrade, control } = await createRoom();
    await control(2, MEMBER_ID, null);

    const rejoined = await upgrade(MEMBER_ID, uuid(), 3);

    expect(rejoined.response.status).toBe(101);
  });

  it("gives an upgrade read before a demotion the demoted role", async () => {
    const { room, upgrade, edit, control, persistedText } = await createRoom();
    await control(2, MEMBER_ID, "viewer");

    const late = await upgrade(MEMBER_ID, uuid(), 1);
    await room.webSocketMessage(late.socket as never, edit("+nope"));

    expect(late.socket!.deserializeAttachment()).toMatchObject({ role: "viewer", roleVersion: 2 });
    expect(errors(late.socket!)).toEqual([expect.objectContaining({ code: "read-only" })]);
    expect(await persistedText()).toBe("seed");
  });

  it("refuses every upgrade once the room has been closed", async () => {
    const { upgrade, closeRoom } = await createRoom();
    await closeRoom(1);

    expect((await upgrade(MEMBER_ID, uuid(), 1)).response.status).toBe(409);
  });

  it("does not let an older role change override a newer one", async () => {
    const { upgrade, control } = await createRoom();
    await control(3, MEMBER_ID, null);
    await control(2, MEMBER_ID, "editor");

    expect((await upgrade(MEMBER_ID, uuid(), 1)).response.status).toBe(403);
  });
});

// Rechecks ran only on a frame from the socket itself, and pings are answered
// without waking the room, so a member who never sent one kept receiving every
// edit after losing access whenever no /control reached their socket.
describe("CollaborationRoomDurableObject silent sockets", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("rechecks a silent recipient whose access check is stale and closes it", async () => {
    const { room, connect, edit } = await createRoom();
    const owner = connect(OWNER_ID, "owner");
    const silent = connect(MEMBER_ID, "editor", { accessCheckedAt: 0 });
    vi.mocked(getCollaborationRoomAccess).mockImplementation(async (_db, _room, userId) =>
      userId === MEMBER_ID ? null : roomAccess("owner", 1),
    );

    await room.webSocketMessage(owner as never, edit("+first"));
    await settle();
    await room.webSocketMessage(owner as never, edit("+second"));

    expect(getCollaborationRoomAccess).toHaveBeenCalledWith(expect.anything(), ROOM_ID, MEMBER_ID);
    expect(silent.closeCode).toBe(4003);
    expect(silent.frames().filter((frame) => frame.kind === "server-update")).toHaveLength(1);
  });

  it("leaves a recipient whose access check is fresh alone", async () => {
    const { room, connect, edit } = await createRoom();
    const owner = connect(OWNER_ID, "owner");
    const listener = connect(MEMBER_ID, "viewer");

    await room.webSocketMessage(owner as never, edit("+edit"));
    await settle();

    expect(getCollaborationRoomAccess).not.toHaveBeenCalled();
    expect(listener.closeCode).toBeNull();
  });

  it("rechecks a silent recipient at most once an interval", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { room, connect, edit } = await createRoom();
    const owner = connect(OWNER_ID, "owner");
    const listener = connect(MEMBER_ID, "viewer", { accessCheckedAt: 0 });
    vi.mocked(getCollaborationRoomAccess).mockImplementation(async (_db, _room, userId) =>
      roomAccess(userId === MEMBER_ID ? "viewer" : "owner", 1),
    );

    for (let index = 0; index < 5; index += 1) {
      await room.webSocketMessage(owner as never, edit("x"));
      await settle();
    }
    const listenerChecks = () =>
      vi.mocked(getCollaborationRoomAccess).mock.calls.filter(([, , user]) => user === MEMBER_ID);
    expect(listenerChecks()).toHaveLength(1);

    now.mockReturnValue(1_700_000_006_000);
    await room.webSocketMessage(owner as never, edit("y"));
    await settle();

    expect(listenerChecks()).toHaveLength(2);
    expect(listener.closeCode).toBeNull();
  });
});

// Each socket used to be checked against the sign-in session only at its
// upgrade: signing out (or the session expiring) left an open socket reading
// the room and, for an editor, writing it until it closed on its own.
describe("CollaborationRoomDurableObject signed-out sessions", () => {
  it("closes a socket whose session was signed out when it is revalidated", async () => {
    const { room, connect, edit, persistedText } = await createRoom();
    const member = connect(MEMBER_ID, "editor", { accessCheckedAt: 0 });
    // The membership is unchanged, as after a sign-out.
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(roomAccess("editor", 1));
    vi.mocked(getSessionUser).mockResolvedValue(null);

    await room.webSocketMessage(member as never, edit("+after-logout"));
    await room.webSocketMessage(
      member as never,
      toArrayBuffer(encodeCollaborationSyncStep1(new Y.Doc())),
    );

    expect(getSessionUser).toHaveBeenCalledWith(expect.anything(), authSessionOf(MEMBER_ID));
    expect(acks(member)).toEqual([]);
    expect(errors(member)).toEqual([
      expect.objectContaining({ code: "access-revoked", fatal: true }),
    ]);
    expect(member.closeCode).toBe(4003);
    expect(member.frames().filter((frame) => frame.kind === "sync")).toEqual([]);
    expect(await persistedText()).toBe("seed");
  });

  it("closes a socket whose session now belongs to someone else", async () => {
    const { room, connect, edit } = await createRoom();
    const member = connect(MEMBER_ID, "editor", { accessCheckedAt: 0 });
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(roomAccess("editor", 1));
    vi.mocked(getSessionUser).mockResolvedValue({ id: PEER_ID } as never);

    await room.webSocketMessage(member as never, edit("+nope"));

    expect(member.closeCode).toBe(4003);
  });

  it("closes a silent socket of a signed-out session on the next broadcast", async () => {
    const { room, connect, edit } = await createRoom();
    const owner = connect(OWNER_ID, "owner");
    const silent = connect(MEMBER_ID, "viewer", { accessCheckedAt: 0 });
    vi.mocked(getCollaborationRoomAccess).mockImplementation(async (_db, _room, userId) =>
      roomAccess(userId === MEMBER_ID ? "viewer" : "owner", 1),
    );
    vi.mocked(getSessionUser).mockImplementation(async (db, authSessionId) =>
      authSessionId === authSessionOf(MEMBER_ID) ? null : signedInAs(db, authSessionId),
    );

    await room.webSocketMessage(owner as never, edit("+first"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(silent.closeCode).toBe(4003);
  });

  it("keeps a socket whose session is still signed in", async () => {
    const { room, connect, edit } = await createRoom();
    const member = connect(MEMBER_ID, "editor", { accessCheckedAt: 0 });
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(roomAccess("editor", 1));

    await room.webSocketMessage(member as never, edit("+edit"));

    expect(acks(member)).toHaveLength(1);
    expect(member.closeCode).toBeNull();
  });
});

describe("CollaborationRoomDurableObject access revalidation", () => {
  it("rechecks D1 once the cached check is older than five seconds", async () => {
    const { room, connect, edit, persistedText } = await createRoom();
    const member = connect(MEMBER_ID, "editor", { accessCheckedAt: 0 });
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(roomAccess("viewer", 2));

    await room.webSocketMessage(member as never, edit("+nope"));

    expect(getCollaborationRoomAccess).toHaveBeenCalledOnce();
    expect(errors(member)).toEqual([expect.objectContaining({ code: "read-only" })]);
    expect(await persistedText()).toBe("seed");
  });

  // Without an answer the client would wait out its 15 s ack timer; the 1011
  // close makes it reconnect at once, and the update stays in its outbox.
  it("closes with 1011 when the D1 recheck fails instead of dropping the frame", async () => {
    const { room, connect, edit, persistedText } = await createRoom();
    const member = connect(MEMBER_ID, "editor", { accessCheckedAt: 0 });
    vi.mocked(getCollaborationRoomAccess).mockRejectedValue(new Error("D1 unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await room.webSocketMessage(member as never, edit("+edit"));

    expect(errors(member)).toEqual([
      expect.objectContaining({ code: "persistence-failed", fatal: false }),
    ]);
    expect(member.closeCode).toBe(1011);
    expect(acks(member)).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      "collaboration_access_check_failed",
      expect.objectContaining({ roomId: ROOM_ID }),
    );
    expect(await persistedText()).toBe("seed");
  });

  it("relays awareness from a socket whose access check is still fresh", async () => {
    const { room, connect } = await createRoom();
    const member = connect(MEMBER_ID, "viewer");
    const peer = connect(PEER_ID, "viewer");

    await room.webSocketMessage(member as never, awarenessFrame(member, 7, 1));

    expect(getCollaborationRoomAccess).not.toHaveBeenCalled();
    expect(peer.frames().map((frame) => frame.kind)).toEqual(["awareness"]);
  });

  // A member who only watches sends no document frames, but renews awareness
  // every 15 s; that is the frame that notices a revocation /control missed.
  it("closes a socket whose member was removed when its awareness is revalidated", async () => {
    const { room, connect } = await createRoom();
    const member = connect(MEMBER_ID, "viewer", { accessCheckedAt: 0 });
    const peer = connect(PEER_ID, "viewer");
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(null);

    await room.webSocketMessage(member as never, awarenessFrame(member, 7, 1));

    expect(member.closeCode).toBe(4003);
    expect(peer.sent).toEqual([]);
  });

  // D1 is not Durable Object storage, so the input gate stays open while it
  // answers and /control or other frames from the same socket run meanwhile.
  it("keeps a demotion that lands while the D1 read is in flight", async () => {
    const { room, connect, edit, control, persistedText } = await createRoom();
    const member = connect(MEMBER_ID, "editor", { accessCheckedAt: 0 });
    const read = deferred<CollaborationRoomAccess | null>();
    vi.mocked(getCollaborationRoomAccess).mockReturnValueOnce(read.promise);

    const inFlight = room.webSocketMessage(member as never, edit("+racing"));
    await control(2, MEMBER_ID, "viewer");
    // The read was issued before the demotion committed.
    read.resolve(roomAccess("editor", 1));
    await inFlight;
    await room.webSocketMessage(member as never, edit("+after"));

    expect(acks(member)).toEqual([]);
    expect(await persistedText()).toBe("seed");
  });

  it("drops an update whose socket was closed while the D1 read was in flight", async () => {
    const { room, connect, edit, control, persistedText } = await createRoom();
    const member = connect(MEMBER_ID, "editor", { accessCheckedAt: 0 });
    const peer = connect(PEER_ID, "viewer");
    const read = deferred<CollaborationRoomAccess | null>();
    vi.mocked(getCollaborationRoomAccess).mockReturnValueOnce(read.promise);

    const inFlight = room.webSocketMessage(member as never, edit("+revoked"));
    await control(2, MEMBER_ID, null);
    read.resolve(roomAccess("editor", 1));
    await inFlight;

    expect(member.closeCode).toBe(4003);
    expect(peer.frames()).toEqual([]);
    expect(await persistedText()).toBe("seed");
  });

  it("keeps awareness that arrives while the D1 read is in flight", async () => {
    const { room, connect, edit } = await createRoom();
    const member = connect(MEMBER_ID, "editor", { accessCheckedAt: 0 });
    const peer = connect(PEER_ID, "viewer");
    const read = deferred<CollaborationRoomAccess | null>();
    // The update's read stays pending; the awareness frame's own read answers.
    vi.mocked(getCollaborationRoomAccess)
      .mockResolvedValue(roomAccess("editor", 1))
      .mockReturnValueOnce(read.promise);

    const inFlight = room.webSocketMessage(member as never, edit("+typing"));
    await room.webSocketMessage(member as never, awarenessFrame(member, 7, 1));
    read.resolve(roomAccess("editor", 1));
    await inFlight;
    peer.sent.length = 0;
    room.webSocketClose(member as never);

    // Closing broadcasts a leave only for awareness the attachment still holds.
    const leaves = peer
      .frames()
      .flatMap((frame) =>
        frame.kind === "awareness" ? decodeCollaborationAwarenessProtocolUpdate(frame.update) : [],
      );
    expect(leaves).toEqual([expect.objectContaining({ clientId: 7, state: null })]);
  });
});
