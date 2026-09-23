import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  COLLABORATION_AWARENESS_TTL_MS,
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_SQLITE_PERSISTENCE_VERSION,
  MAX_COLLABORATION_EDITOR_SCROLL_LEFT_PX,
  MAX_COLLABORATION_EDITOR_TOP_DELTA_PX,
  type CollaborationBootstrapResponse,
  type CollaborationRole,
} from "../../../src/collaboration/protocol";
import { seedCollaborationProject } from "../../../src/collaboration/projectDocument";
import {
  isCollaborationTeachingInitialized,
  seedCollaborationTeachingDocument,
} from "../../../src/collaboration/teachingDocument";
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
import type { Env } from "../env";
import { FakeWebSocket } from "../testing/fakeWebSocket";
import { SqliteTestStorage } from "../testing/sqliteStorage";
import { stubWebSocketUpgrade } from "../testing/webSocketUpgrade";
import { CollaborationRoomDurableObject } from "./roomDurableObject";

vi.mock("../../db/collaborationQueries", () => ({
  getCollaborationRoomAccess: vi.fn<typeof getCollaborationRoomAccess>(),
  getCollaborationAsset: vi.fn<typeof getCollaborationAsset>(),
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

beforeEach(() => {
  vi.mocked(getCollaborationRoomAccess).mockReset();
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
  ): Promise<{ response: Response; socket: FakeSocket | null }> {
    const session = canonicalSession(userId, "editor", sessionId);
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

  return { room, doc, connect, upgrade, disconnect, restart, edit, persistedText, control };
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
    await room.webSocketMessage(other as never, edit("+mine"));

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

  // The largest state the schemas accept, with the display name and the
  // selection's type names in two-byte text, which V8 stores at two bytes a
  // character. Its attachment is about 16.2 KB, fewer than 200 bytes under
  // the 16,384 that serializeAttachment takes. This is the worst case and
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
    const end = { type: id, tname: "\u4e00".repeat(1024), item: id, assoc: -1 };
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

  // Earlier revisions also stored the awareness event as `awareness`, beside
  // the same event inside awarenessState.
  it("reads an attachment an earlier revision wrote and drops its awareness copy", async () => {
    const { room, connect } = await createRoom();
    const member = connect(MEMBER_ID, "editor");
    const peer = connect(PEER_ID, "viewer");
    const session = member.deserializeAttachment() as ReturnType<typeof canonicalSession>;
    const now = Date.now();
    const event = {
      kind: "state",
      sessionId: session.sessionId,
      revision: 1,
      surface: { kind: "slides", isMaximized: false },
      cursor: null,
      roomId: ROOM_ID,
      actorId: MEMBER_ID,
      role: "editor",
      username: session.username,
      name: null,
      avatarUrl: null,
      isHost: false,
      occurredAt: now,
      expiresAt: now + COLLABORATION_AWARENESS_TTL_MS,
    };
    member.serializeAttachment({
      ...session,
      awarenessClientId: 7,
      awarenessClock: 1,
      awareness: event,
      awarenessState: { collaboration: event },
    });

    await room.webSocketMessage(member as never, awarenessFrame(member, 7, 2));

    expect(peer.frames().map((frame) => frame.kind)).toEqual(["awareness"]);
    const stored = member.deserializeAttachment();
    expect(stored).not.toHaveProperty("awareness");
    expect(stored).toMatchObject({ awarenessState: { collaboration: { revision: 2 } } });

    peer.sent.length = 0;
    room.webSocketClose(member as never);
    const leaves = peer
      .frames()
      .flatMap((frame) =>
        frame.kind === "awareness" ? decodeCollaborationAwarenessProtocolUpdate(frame.update) : [],
      );
    expect(leaves).toEqual([expect.objectContaining({ clientId: 7, state: null })]);
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
