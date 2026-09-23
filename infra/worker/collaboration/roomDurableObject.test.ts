import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  type CollaborationBootstrapResponse,
  type CollaborationRole,
} from "../../../src/collaboration/protocol";
import { applyEncodedYjsSnapshot, encodeYjsDocument } from "../../../src/collaboration/yjsUpdates";
import {
  getCollaborationAsset,
  getCollaborationRoomAccess,
  type CollaborationRoomAccess,
} from "../../db/collaborationQueries";
import type { Env } from "../env";
import { SqliteTestStorage } from "../testing/sqliteStorage";
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
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;

let nextId = 1;
function uuid(): string {
  return `40000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
}

/** The parts of a hibernatable server WebSocket the room uses. */
class FakeSocket {
  readyState = WEBSOCKET_OPEN;
  closeCode: number | null = null;
  readonly sent: Array<string | ArrayBuffer> = [];
  private attachment: unknown = null;

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  send(message: string | ArrayBuffer): void {
    this.sent.push(message);
  }

  close(code?: number): void {
    this.closeCode = code ?? null;
    this.readyState = WEBSOCKET_CLOSED;
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent.flatMap((message) =>
      typeof message === "string" ? [JSON.parse(message) as Record<string, unknown>] : [],
    );
  }

  frames(): CollaborationBinaryFrame[] {
    return this.sent.flatMap((message) =>
      typeof message === "string" ? [] : [decodeCollaborationBinaryFrame(message)],
    );
  }
}

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

async function createRoom() {
  const storage = new RoomTestStorage();
  openStorages.push(storage);
  const sockets: FakeSocket[] = [];
  const ctx = {
    id: { name: ROOM_ID },
    storage,
    setWebSocketAutoResponse: () => undefined,
    getWebSockets: () => sockets,
    waitUntil: () => undefined,
  };
  const room = new CollaborationRoomDurableObject(
    ctx as unknown as DurableObjectState,
    { DB: {} } as Env,
  );
  // The shared document every participant edits in these tests.
  const doc = new Y.Doc();
  doc.getText("scratch").insert(0, "seed");
  const initialized = await room.fetch(
    new Request(`${ROOM_ORIGIN}/sqlite/initialize`, {
      method: "POST",
      body: JSON.stringify({ roomId: ROOM_ID, snapshot: encodeYjsDocument(doc) }),
    }),
  );
  expect(initialized.status).toBe(200);

  /** A socket as acceptConnection leaves it (WebSocketPair and a 101 need workerd). */
  function connect(
    userId: string,
    role: CollaborationRole,
    options: { roleVersion?: number; accessCheckedAt?: number } = {},
  ): FakeSocket {
    const socket = new FakeSocket();
    socket.serializeAttachment({
      roomId: ROOM_ID,
      userId,
      username: `user-${userId.slice(-1)}`,
      name: null,
      avatarUrl: null,
      hostUserId: OWNER_ID,
      role,
      roleVersion: options.roleVersion ?? 1,
      sessionId: uuid(),
      attemptId: uuid(),
      accessCheckedAt: options.accessCheckedAt ?? Date.now(),
    });
    sockets.push(socket);
    return socket;
  }

  /** Appends `text` to the shared document and returns it as a client-update frame. */
  function edit(text: string): ArrayBuffer {
    const before = Y.encodeStateVector(doc);
    doc.getText("scratch").insert(doc.getText("scratch").length, text);
    return toArrayBuffer(
      encodeCollaborationClientUpdate({
        clientId: CLIENT_ID,
        updateId: uuid(),
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

  return { room, connect, edit, persistedText, control };
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

  it("refuses a viewer's update without persisting or broadcasting it", async () => {
    const { room, connect, edit, persistedText } = await createRoom();
    const viewer = connect(MEMBER_ID, "viewer");
    const peer = connect(PEER_ID, "editor");

    await room.webSocketMessage(viewer as never, edit("+nope"));

    expect(errors(viewer)).toEqual([expect.objectContaining({ code: "read-only" })]);
    expect(peer.sent).toEqual([]);
    expect(await persistedText()).toBe("seed");
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

  it("keeps a member who rejoined at a newer version when an older removal arrives", async () => {
    const { connect, control } = await createRoom();
    const member = connect(MEMBER_ID, "editor", { roleVersion: 6 });

    await control(5, MEMBER_ID, null);

    expect(member.closeCode).toBeNull();
    expect(member.messages()).toEqual([]);
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
    vi.mocked(getCollaborationRoomAccess).mockReturnValueOnce(read.promise);

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
