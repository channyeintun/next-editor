import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  COLLABORATION_BINARY_PROTOCOL_VERSION,
  decodeCollaborationAwarenessProtocolUpdate,
  decodeCollaborationBinaryFrame,
  encodeCollaborationAwarenessProtocolUpdate,
  encodeCollaborationAwarenessUpdate,
  encodeCollaborationServerUpdate,
  encodeCollaborationSyncStep2,
} from "./binaryProtocol";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  collaborationAwarenessChannel,
  collaborationControlChannel,
  collaborationDocumentUpdateEventSchema,
  collaborationRoomChannel,
  collaborationWebSocketClientMessageSchema,
  type CollaborationBootstrapResponse,
  type CollaborationDocumentUpdateInput,
  type CollaborationRoomSession,
} from "./protocol";
import {
  applyEncodedYjsSnapshot,
  createCollaborationDocumentUpdate,
  encodeYjsDocument,
} from "./yjsUpdates";
import {
  UpstashRoomProvider,
  type CollaborationEventSource,
  type CollaborationRoomApi,
  type CollaborationWebSocket,
} from "./upstashRoomProvider";
import {
  flushPerformanceMetrics,
  resetPerformanceMetricsForTests,
} from "../utils/performanceMetrics";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const CLIENT_ID = "20000000-0000-4000-8000-000000000001";
const ACTOR_ID = "30000000-0000-4000-8000-000000000001";
const REMOTE_UPDATE_ID = "40000000-0000-4000-8000-000000000001";

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function roomSession(role: "owner" | "editor" | "viewer" = "editor"): CollaborationRoomSession {
  return {
    room: {
      id: ROOM_ID,
      ownerId: ACTOR_ID,
      hostUserId: ACTOR_ID,
      status: "active",
      transport: "upstash-realtime",
      persistenceVersion: 1,
      binaryProtocolVersion: null,
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

function bootstrap(doc: Y.Doc): CollaborationBootstrapResponse {
  return {
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
    snapshot: { generation: 1, streamCutoff: "0-0", update: encodeYjsDocument(doc) },
    updates: [],
    nextCursor: "0-0",
    hasMore: false,
  };
}

class FakeEventSource implements CollaborationEventSource {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  open() {
    this.onopen?.(new Event("open"));
  }

  message(value: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  error() {
    this.onerror?.(new Event("error"));
  }

  close() {
    this.closed = true;
  }
}

class FakeWebSocket implements CollaborationWebSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType?: BinaryType;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  readonly binarySent: ArrayBuffer[] = [];

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  message(value: unknown) {
    const data =
      typeof value === "string" || value instanceof ArrayBuffer ? value : JSON.stringify(value);
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  send(data: string | ArrayBuffer) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    if (typeof data === "string") this.sent.push(data);
    else this.binarySent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

class FakeApi implements CollaborationRoomApi {
  readonly published: CollaborationDocumentUpdateInput[] = [];
  session = roomSession();
  bootstrapResponse: CollaborationBootstrapResponse;
  bootstrapGate: Promise<void> | null = null;
  bootstrapCalls = 0;

  constructor(serverDoc: Y.Doc) {
    this.bootstrapResponse = bootstrap(serverDoc);
  }

  async getRoom() {
    return this.session;
  }

  async getBootstrap() {
    this.bootstrapCalls += 1;
    await this.bootstrapGate;
    return this.bootstrapResponse;
  }

  async publishUpdate(_roomId: string, update: CollaborationDocumentUpdateInput) {
    this.published.push(update);
    return { accepted: true as const, updateId: update.updateId, streamId: "2-0" };
  }

  publishAwareness: CollaborationRoomApi["publishAwareness"] = async () => {
    throw new Error("awareness is not used by this provider test");
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

function remoteMessage(update: Uint8Array, streamId = "1-0") {
  const event = collaborationDocumentUpdateEventSchema.parse({
    ...createCollaborationDocumentUpdate(
      update,
      "40000000-0000-4000-8000-000000000001",
      "50000000-0000-4000-8000-000000000001",
    ),
    roomId: ROOM_ID,
    actorId: ACTOR_ID,
    receivedAt: 1,
  });
  return {
    id: streamId,
    event: "document.update",
    channel: collaborationRoomChannel(ROOM_ID),
    data: event,
  };
}

describe("UpstashRoomProvider", () => {
  beforeEach(() => {
    resetPerformanceMetricsForTests();
  });

  afterEach(() => {
    resetPerformanceMetricsForTests();
  });

  it("uses state vectors and raw Yjs updates for negotiated binary rooms", async () => {
    const server = new Y.Doc();
    server.getText("source").insert(0, "start");
    const api = new FakeApi(server);
    const session = roomSession();
    api.session = {
      ...session,
      room: {
        ...session.room,
        transport: "cloudflare-websocket",
        persistenceVersion: 2,
        binaryProtocolVersion: COLLABORATION_BINARY_PROTOCOL_VERSION,
      },
    };
    const sockets: FakeWebSocket[] = [];
    const urls: string[] = [];
    const awarenessEvents: unknown[] = [];
    const provider = new UpstashRoomProvider({
      roomId: ROOM_ID,
      api,
      clientId: CLIENT_ID,
      batchWindowMs: 60_000,
      binaryProtocolEnabled: true,
      webSocketFactory: (url) => {
        urls.push(url);
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      eventSourceFactory: () => {
        throw new Error("Realtime must not open for a WebSocket room");
      },
      onAwarenessEvent: (event) => awarenessEvents.push(event),
    });

    await provider.start();
    sockets[0].open();
    await waitUntil(() => sockets[0].binarySent.length === 1);
    const syncRequest = decodeCollaborationBinaryFrame(sockets[0].binarySent[0]);
    if (syncRequest.kind !== "sync") throw new Error("state-vector sync was not requested");
    sockets[0].message(exactArrayBuffer(encodeCollaborationSyncStep2(server, syncRequest.payload)));
    await waitUntil(() => provider.connectionState === "live");

    expect(api.bootstrapCalls).toBe(0);
    expect(provider.doc.getText("source").toString()).toBe("start");
    expect(new URL(urls[0]).searchParams.get("binaryProtocolVersion")).toBe(
      String(COLLABORATION_BINARY_PROTOCOL_VERSION),
    );
    expect(sockets[0].binaryType).toBe("arraybuffer");

    await provider.publishAwareness({
      kind: "state",
      sessionId: provider.awarenessSessionId,
      revision: 1,
      activeFileNodeId: null,
      cursor: null,
      followingHost: false,
    });
    const localAwareness = sockets[0].binarySent
      .map((raw) => decodeCollaborationBinaryFrame(raw))
      .find((frame) => frame.kind === "awareness");
    if (!localAwareness || localAwareness.kind !== "awareness") {
      throw new Error("binary awareness update was not sent");
    }
    expect(decodeCollaborationAwarenessProtocolUpdate(localAwareness.update)).toEqual([
      {
        clientId: provider.awareness.clientID,
        clock: 1,
        state: {
          collaboration: {
            kind: "state",
            sessionId: provider.awarenessSessionId,
            revision: 1,
            activeFileNodeId: null,
            cursor: null,
            followingHost: false,
          },
        },
      },
    ]);

    const remoteAwarenessClientId = 42;
    const remoteAwarenessEvent = {
      kind: "state" as const,
      roomId: ROOM_ID,
      actorId: ACTOR_ID,
      sessionId: "60000000-0000-4000-8000-000000000001",
      revision: 1,
      role: "owner" as const,
      username: "host",
      name: null,
      avatarUrl: null,
      isHost: true,
      activeFileNodeId: null,
      cursor: null,
      followingHost: false,
      occurredAt: Date.now(),
      expiresAt: Date.now() + 45_000,
    };
    sockets[0].message(
      exactArrayBuffer(
        encodeCollaborationAwarenessUpdate(
          encodeCollaborationAwarenessProtocolUpdate([
            {
              clientId: remoteAwarenessClientId,
              clock: 1,
              state: { collaboration: remoteAwarenessEvent },
            },
          ]),
        ),
      ),
    );
    await waitUntil(() => awarenessEvents.length === 1);
    expect(awarenessEvents[0]).toEqual(remoteAwarenessEvent);
    expect(provider.awareness.getStates().get(remoteAwarenessClientId)).toEqual({
      collaboration: remoteAwarenessEvent,
    });
    sockets[0].message(
      exactArrayBuffer(
        encodeCollaborationAwarenessUpdate(
          encodeCollaborationAwarenessProtocolUpdate([
            { clientId: remoteAwarenessClientId, clock: 2, state: null },
          ]),
        ),
      ),
    );
    await waitUntil(() => awarenessEvents.length === 2);
    expect(awarenessEvents[1]).toMatchObject({
      kind: "leave",
      roomId: ROOM_ID,
      actorId: ACTOR_ID,
      sessionId: remoteAwarenessEvent.sessionId,
      revision: 2,
    });

    const source = provider.doc.getText("source");
    source.insert(source.length, "-one");
    source.insert(source.length, "-two");
    const flushing = provider.flushNow();
    let concurrentFlushResolved = false;
    const concurrentFlush = provider.flushNow().then(() => {
      concurrentFlushResolved = true;
    });
    await waitUntil(
      () =>
        sockets[0].binarySent
          .map((raw) => decodeCollaborationBinaryFrame(raw))
          .filter((frame) => frame.kind === "client-update").length === 1,
    );
    const clientUpdate = sockets[0].binarySent
      .map((raw) => decodeCollaborationBinaryFrame(raw))
      .find((frame) => frame.kind === "client-update");
    if (!clientUpdate || clientUpdate.kind !== "client-update") {
      throw new Error("binary document update was not sent");
    }
    expect(concurrentFlushResolved).toBe(false);
    expect(clientUpdate.clientId).toBe(CLIENT_ID);
    Y.applyUpdate(server, clientUpdate.update);
    expect(server.getText("source").toString()).toBe("start-one-two");
    sockets[0].message({
      type: "document.ack",
      updateId: clientUpdate.updateId,
      streamId: "2-0",
      duplicate: false,
    });
    await Promise.all([flushing, concurrentFlush]);
    expect(provider.hasPendingUpdates).toBe(false);

    const serverStateVector = Y.encodeStateVector(server);
    server.getText("source").insert(server.getText("source").length, "-remote");
    const remoteUpdate = Y.encodeStateAsUpdate(server, serverStateVector);
    sockets[0].message(
      exactArrayBuffer(
        encodeCollaborationServerUpdate({
          streamId: "3-0",
          updateId: REMOTE_UPDATE_ID,
          update: remoteUpdate,
        }),
      ),
    );
    await waitUntil(() => provider.doc.getText("source").toString().endsWith("-remote"));
    expect(provider.doc.getText("source").toString()).toBe("start-one-two-remote");
    provider.stop();
  });

  it("uses a duplex WebSocket for WebSocket rooms and waits for durable acknowledgements", async () => {
    const server = new Y.Doc();
    server.getText("source").insert(0, "start");
    const api = new FakeApi(server);
    api.session = {
      ...roomSession(),
      room: { ...roomSession().room, transport: "cloudflare-websocket" },
    };
    const sockets: FakeWebSocket[] = [];
    const awarenessEvents: unknown[] = [];
    const provider = new UpstashRoomProvider({
      roomId: ROOM_ID,
      api,
      clientId: CLIENT_ID,
      batchWindowMs: 60_000,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      eventSourceFactory: () => {
        throw new Error("Realtime must not open for a WebSocket room");
      },
      onAwarenessEvent: (event) => awarenessEvents.push(event),
    });

    await provider.start();
    sockets[0].open();
    await waitUntil(() => provider.connectionState === "live");

    provider.doc.getText("source").insert(5, "-local");
    const flushing = provider.flushNow();
    await waitUntil(() =>
      sockets[0].sent.some((raw) => {
        if (raw === "ping") return false;
        const result = collaborationWebSocketClientMessageSchema.safeParse(JSON.parse(raw));
        return result.success && result.data.type === "document.update";
      }),
    );
    const updateMessage = sockets[0].sent
      .filter((raw) => raw !== "ping")
      .map((raw) => collaborationWebSocketClientMessageSchema.safeParse(JSON.parse(raw)))
      .find((result) => result.success && result.data.type === "document.update");
    if (!updateMessage?.success || updateMessage.data.type !== "document.update") {
      throw new Error("document update was not sent");
    }
    sockets[0].message({
      type: "document.ack",
      updateId: updateMessage.data.data.updateId,
      streamId: "2-0",
      duplicate: false,
    });
    await flushing;

    expect(api.published).toEqual([]);
    expect(provider.hasPendingUpdates).toBe(false);
    expect(flushPerformanceMetrics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "collaboration.queue_to_send",
          dimensions: { transport: "cloudflare-websocket" },
          count: 1,
        }),
        expect.objectContaining({
          name: "collaboration.send_to_ack",
          dimensions: { outcome: "success", transport: "cloudflare-websocket" },
          count: 1,
        }),
        expect.objectContaining({
          name: "collaboration.enqueue_to_ack",
          dimensions: { transport: "cloudflare-websocket" },
          count: 1,
        }),
      ]),
    );

    await provider.publishAwareness({
      kind: "state",
      sessionId: provider.awarenessSessionId,
      revision: 1,
      activeFileNodeId: null,
      cursor: null,
      followingHost: false,
    });
    const awarenessMessage = sockets[0].sent
      .filter((raw) => raw !== "ping")
      .map((raw) => collaborationWebSocketClientMessageSchema.safeParse(JSON.parse(raw)))
      .find((result) => result.success && result.data.type === "awareness.state");
    expect(awarenessMessage?.success).toBe(true);
    sockets[0].message({
      type: "awareness.state",
      data: {
        kind: "state",
        roomId: ROOM_ID,
        actorId: ACTOR_ID,
        sessionId: provider.awarenessSessionId,
        revision: 1,
        role: "editor",
        username: "editor",
        name: null,
        avatarUrl: null,
        isHost: false,
        activeFileNodeId: null,
        cursor: null,
        followingHost: false,
        occurredAt: Date.now(),
        expiresAt: Date.now() + 45_000,
      },
    });
    expect(awarenessEvents).toHaveLength(1);
    provider.stop();
  });

  it("applies WebSocket role notifications without reconnecting", async () => {
    const server = new Y.Doc();
    const api = new FakeApi(server);
    const asWebSocketSession = (
      role: "owner" | "editor" | "viewer",
      roleVersion: number,
    ): CollaborationRoomSession => {
      const session = roomSession(role);
      return {
        ...session,
        room: { ...session.room, transport: "cloudflare-websocket", roleVersion },
      };
    };
    api.session = asWebSocketSession("viewer", 1);
    const socket = new FakeWebSocket();
    const provider = new UpstashRoomProvider({
      roomId: ROOM_ID,
      api,
      webSocketFactory: () => socket,
    });

    await provider.start();
    socket.open();
    await waitUntil(() => provider.connectionState === "live");
    expect(provider.canWrite).toBe(false);

    api.session = asWebSocketSession("editor", 2);
    socket.message({
      type: "control.room",
      data: {
        kind: "membership-changed",
        roomId: ROOM_ID,
        roleVersion: 2,
        targetUserId: ACTOR_ID,
        occurredAt: Date.now(),
      },
    });
    await waitUntil(() => provider.canWrite);

    expect(provider.session?.membership.role).toBe("editor");
    expect(provider.connectionState).toBe("live");
    provider.stop();
  });

  it("retains HTTP awareness publication for Realtime fallback rooms", async () => {
    const api = new FakeApi(new Y.Doc());
    const source = new FakeEventSource();
    const awarenessEvents: unknown[] = [];
    let publishedRoomId: string | null = null;
    api.publishAwareness = async (roomId, input) => {
      if (input.kind !== "state") throw new Error("expected state awareness");
      publishedRoomId = roomId;
      return {
        accepted: true,
        streamId: "2-0",
        event: {
          ...input,
          kind: "state",
          roomId,
          actorId: ACTOR_ID,
          role: "editor",
          username: "editor",
          name: null,
          avatarUrl: null,
          isHost: false,
          occurredAt: Date.now(),
          expiresAt: Date.now() + 45_000,
        },
      };
    };
    const provider = new UpstashRoomProvider({
      roomId: ROOM_ID,
      api,
      eventSourceFactory: () => source,
      webSocketFactory: () => {
        throw new Error("WebSocket must not open for a Realtime room");
      },
      onAwarenessEvent: (event) => awarenessEvents.push(event),
    });

    await provider.start();
    source.open();
    await waitUntil(() => provider.connectionState === "live");
    await provider.publishAwareness({
      kind: "state",
      sessionId: provider.awarenessSessionId,
      revision: 1,
      activeFileNodeId: null,
      cursor: null,
      followingHost: false,
    });

    expect(publishedRoomId).toBe(ROOM_ID);
    expect(awarenessEvents).toHaveLength(1);
    provider.stop();
  });

  it("buffers the SSE/bootstrap race and publishes batched local Yjs updates", async () => {
    const server = new Y.Doc();
    server.getText("source").insert(0, "start");
    const api = new FakeApi(server);
    let releaseBootstrap = () => {};
    api.bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const sources: FakeEventSource[] = [];
    const provider = new UpstashRoomProvider({
      roomId: ROOM_ID,
      api,
      clientId: CLIENT_ID,
      batchWindowMs: 60_000,
      eventSourceFactory: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
    });

    await provider.start();
    sources[0].open();
    const remote = new Y.Doc();
    applyEncodedYjsSnapshot(remote, encodeYjsDocument(server));
    remote.getText("source").insert(5, "-remote");
    sources[0].message(remoteMessage(Y.encodeStateAsUpdate(remote, Y.encodeStateVector(server))));
    releaseBootstrap();
    await waitUntil(() => provider.connectionState === "live");
    expect(provider.doc.getText("source").toString()).toBe("start-remote");

    provider.doc.getText("source").insert(provider.doc.getText("source").length, "-local");
    await provider.flushNow();
    expect(api.published).toHaveLength(1);
    expect(provider.actor.getSnapshot().context.hasOfflineChanges).toBe(false);
    provider.stop();
  });

  it("retains local changes through a disconnect and tears down obsolete sources", async () => {
    const server = new Y.Doc();
    server.getText("source").insert(0, "start");
    const api = new FakeApi(server);
    const sources: FakeEventSource[] = [];
    const provider = new UpstashRoomProvider({
      roomId: ROOM_ID,
      api,
      clientId: CLIENT_ID,
      batchWindowMs: 60_000,
      random: () => 0,
      eventSourceFactory: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
    });

    await provider.start();
    sources[0].open();
    await waitUntil(() => provider.connectionState === "live");
    sources[0].error();
    expect(provider.connectionState).toBe("reconnecting");
    provider.doc.getText("source").insert(5, "-offline");
    await provider.flushNow();
    expect(api.published).toHaveLength(0);

    await provider.retryNow();
    expect(sources[0].closed).toBe(true);
    sources[1].open();
    await waitUntil(() => provider.connectionState === "live");
    await provider.flushNow();
    expect(api.published).toHaveLength(1);
    expect(provider.doc.getText("source").toString()).toBe("start-offline");

    provider.stop();
    const before = provider.doc.getText("source").toString();
    sources[1].message(remoteMessage(Y.encodeStateAsUpdate(server), "9-0"));
    expect(provider.doc.getText("source").toString()).toBe(before);
  });

  it("never publishes document updates for a viewer", async () => {
    const server = new Y.Doc();
    server.getText("source").insert(0, "start");
    const api = new FakeApi(server);
    api.session = roomSession("viewer");
    const source = new FakeEventSource();
    const provider = new UpstashRoomProvider({
      roomId: ROOM_ID,
      api,
      eventSourceFactory: () => source,
    });

    await provider.start();
    source.open();
    await waitUntil(() => provider.connectionState === "live");
    provider.doc.getText("source").insert(0, "viewer-");
    await provider.flushNow();
    expect(api.published).toEqual([]);
    provider.stop();
  });

  it("subscribes to awareness and control channels and applies role changes", async () => {
    const server = new Y.Doc();
    const api = new FakeApi(server);
    const sources: FakeEventSource[] = [];
    const urls: string[] = [];
    const awarenessEvents: unknown[] = [];
    const controlEvents: unknown[] = [];
    const provider = new UpstashRoomProvider({
      roomId: ROOM_ID,
      api,
      onAwarenessEvent: (event) => awarenessEvents.push(event),
      onControlEvent: (event) => controlEvents.push(event),
      eventSourceFactory: (url) => {
        urls.push(url);
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
    });

    await provider.start();
    const channels = new URL(urls[0]).searchParams.getAll("channel");
    expect(channels).toEqual([
      collaborationRoomChannel(ROOM_ID),
      collaborationAwarenessChannel(ROOM_ID),
      collaborationControlChannel(ROOM_ID),
    ]);
    sources[0].open();
    await waitUntil(() => provider.connectionState === "live");

    const now = Date.now();
    sources[0].message({
      id: "2-0",
      event: "awareness.state",
      channel: collaborationAwarenessChannel(ROOM_ID),
      data: {
        kind: "state",
        roomId: ROOM_ID,
        actorId: ACTOR_ID,
        sessionId: "60000000-0000-4000-8000-000000000001",
        revision: 1,
        role: "owner",
        username: "host",
        name: null,
        avatarUrl: null,
        isHost: true,
        activeFileNodeId: null,
        cursor: null,
        followingHost: false,
        occurredAt: now,
        expiresAt: now + 45_000,
      },
    });
    expect(awarenessEvents).toHaveLength(1);

    api.session = {
      ...roomSession("viewer"),
      room: { ...roomSession("viewer").room, roleVersion: 2 },
    };
    sources[0].message({
      id: "3-0",
      event: "control.room",
      channel: collaborationControlChannel(ROOM_ID),
      data: {
        kind: "membership-changed",
        roomId: ROOM_ID,
        roleVersion: 2,
        targetUserId: ACTOR_ID,
        occurredAt: now,
      },
    });
    await waitUntil(() => provider.session?.membership.role === "viewer");
    expect(provider.canWrite).toBe(false);
    expect(controlEvents).toHaveLength(1);
    provider.stop();
  });

  it("applies the latest role while an earlier permission refresh is still pending", async () => {
    const server = new Y.Doc();
    const api = new FakeApi(server);
    const source = new FakeEventSource();
    const sessionAt = (
      role: "owner" | "editor" | "viewer",
      roleVersion: number,
    ): CollaborationRoomSession => {
      const session = roomSession(role);
      return { ...session, room: { ...session.room, roleVersion } };
    };
    let getRoomCalls = 0;
    let resolveFirstRefresh!: (session: CollaborationRoomSession) => void;
    api.getRoom = async () => {
      getRoomCalls += 1;
      if (getRoomCalls === 1) return sessionAt("viewer", 1);
      if (getRoomCalls === 2) {
        return new Promise<CollaborationRoomSession>((resolve) => {
          resolveFirstRefresh = resolve;
        });
      }
      return sessionAt("editor", 3);
    };
    const provider = new UpstashRoomProvider({
      roomId: ROOM_ID,
      api,
      eventSourceFactory: () => source,
    });

    await provider.start();
    source.open();
    await waitUntil(() => provider.connectionState === "live");
    expect(provider.canWrite).toBe(false);
    let writableNotifications = 0;
    const subscription = provider.subscribe(() => {
      if (provider.canWrite) writableNotifications += 1;
    });

    const sendRoleChange = (id: string, roleVersion: number) => {
      source.message({
        id,
        event: "control.room",
        channel: collaborationControlChannel(ROOM_ID),
        data: {
          kind: "membership-changed",
          roomId: ROOM_ID,
          roleVersion,
          targetUserId: ACTOR_ID,
          occurredAt: Date.now(),
        },
      });
    };
    sendRoleChange("2-0", 2);
    await waitUntil(() => getRoomCalls === 2);
    sendRoleChange("3-0", 3);
    resolveFirstRefresh(sessionAt("viewer", 2));

    await waitUntil(() => provider.canWrite);
    expect(provider.session?.membership.role).toBe("editor");
    expect(provider.session?.room.roleVersion).toBe(3);
    expect(getRoomCalls).toBe(3);
    expect(writableNotifications).toBeGreaterThan(0);

    subscription.unsubscribe();
    provider.stop();
  });

  it("fails closed when the host ends the room", async () => {
    const server = new Y.Doc();
    const api = new FakeApi(server);
    const source = new FakeEventSource();
    const provider = new UpstashRoomProvider({
      roomId: ROOM_ID,
      api,
      eventSourceFactory: () => source,
    });

    await provider.start();
    source.open();
    await waitUntil(() => provider.connectionState === "live");
    source.message({
      id: "4-0",
      event: "control.room",
      channel: collaborationControlChannel(ROOM_ID),
      data: {
        kind: "room-closed",
        roomId: ROOM_ID,
        roleVersion: 2,
        targetUserId: null,
        occurredAt: Date.now(),
      },
    });
    expect(provider.connectionState).toBe("failed");
    expect(provider.actor.getSnapshot().context.error).toContain("host ended");
    provider.stop();
  });
});
