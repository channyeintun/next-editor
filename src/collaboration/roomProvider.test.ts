import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  type CollaborationRoomSession,
} from "./protocol";
import {
  CollaborationRoomProvider,
  type CollaborationRoomApi,
  type CollaborationWebSocket,
} from "./roomProvider";
import { resetPerformanceMetricsForTests } from "../utils/performanceMetrics";
import {
  projectCollaborationTeachingDocument,
  seedCollaborationTeachingDocument,
  setCollaborationCurrentSlide,
} from "./teachingDocument";
import type { Slide } from "../types/slides";

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
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
      roleVersion: 1,
      maxMembers: 10,
      createdAt: 1,
      updatedAt: 1,
    },
    membership: { role },
  };
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

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  message(value: unknown): void {
    const data =
      typeof value === "string" || value instanceof ArrayBuffer ? value : JSON.stringify(value);
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    if (typeof data === "string") this.sent.push(data);
    else this.binarySent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

class FakeApi implements CollaborationRoomApi {
  session = roomSession();

  async getRoom(): Promise<CollaborationRoomSession> {
    return this.session;
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

describe("CollaborationRoomProvider", () => {
  beforeEach(() => resetPerformanceMetricsForTests());
  afterEach(() => resetPerformanceMetricsForTests());

  it("always synchronizes, publishes awareness, and exchanges updates over binary v3", async () => {
    const server = new Y.Doc();
    server.getText("source").insert(0, "start");
    const socket = new FakeWebSocket();
    let socketUrl = "";
    const awarenessEvents: unknown[] = [];
    const provider = new CollaborationRoomProvider({
      roomId: ROOM_ID,
      api: new FakeApi(),
      clientId: CLIENT_ID,
      batchWindowMs: 60_000,
      webSocketFactory: (url) => {
        socketUrl = url;
        return socket;
      },
      onAwarenessEvent: (event) => awarenessEvents.push(event),
    });

    await provider.start();
    socket.open();
    await waitUntil(() => socket.binarySent.length === 1);
    const syncRequest = decodeCollaborationBinaryFrame(socket.binarySent[0]);
    if (syncRequest.kind !== "sync") throw new Error("state-vector sync was not requested");
    socket.message(exactArrayBuffer(encodeCollaborationSyncStep2(server, syncRequest.payload)));
    await waitUntil(() => provider.connectionState === "live");

    expect(new URL(socketUrl).searchParams.get("binaryProtocolVersion")).toBe(
      String(COLLABORATION_BINARY_PROTOCOL_VERSION),
    );
    expect(socket.binaryType).toBe("arraybuffer");
    expect(provider.doc.getText("source").toString()).toBe("start");

    await provider.publishAwareness({
      kind: "state",
      sessionId: provider.awarenessSessionId,
      revision: 1,
      surface: { kind: "editor", fileNodeId: null, viewport: null },
      cursor: null,
    });
    const awarenessFrame = socket.binarySent
      .map((raw) => decodeCollaborationBinaryFrame(raw))
      .find((frame) => frame.kind === "awareness");
    if (!awarenessFrame || awarenessFrame.kind !== "awareness") {
      throw new Error("binary awareness update was not sent");
    }
    expect(decodeCollaborationAwarenessProtocolUpdate(awarenessFrame.update)).toHaveLength(1);

    const standardPosition = { type: null, tname: "source", item: null, assoc: 0 };
    provider.setAwarenessPublicationSuppressed(true);
    const beforeSuppressedSelection = socket.binarySent.length;
    provider.awareness.setLocalStateField("selection", {
      anchor: standardPosition,
      head: standardPosition,
    });
    expect(socket.binarySent).toHaveLength(beforeSuppressedSelection);
    await provider.publishAwareness({
      kind: "state",
      sessionId: provider.awarenessSessionId,
      revision: 2,
      surface: { kind: "editor", fileNodeId: null, viewport: null },
      cursor: null,
    });
    const suppressedHeartbeat = decodeCollaborationBinaryFrame(socket.binarySent.at(-1)!);
    if (suppressedHeartbeat.kind !== "awareness") {
      throw new Error("suppressed awareness heartbeat was not sent");
    }
    expect(
      decodeCollaborationAwarenessProtocolUpdate(suppressedHeartbeat.update)[0]?.state,
    ).toEqual(expect.objectContaining({ selection: null }));
    provider.setAwarenessPublicationSuppressed(false);
    provider.awareness.setLocalStateField("selection", {
      anchor: { ...standardPosition, assoc: 1 },
      head: { ...standardPosition, assoc: 1 },
    });
    expect(socket.binarySent.length).toBeGreaterThan(beforeSuppressedSelection + 1);

    await provider.publishAwareness({
      kind: "state",
      sessionId: provider.awarenessSessionId,
      revision: 3,
      surface: { kind: "slides", isMaximized: false },
      cursor: null,
    });
    const slideAwarenessFrame = decodeCollaborationBinaryFrame(socket.binarySent.at(-1)!);
    if (slideAwarenessFrame.kind !== "awareness") {
      throw new Error("slide awareness update was not sent");
    }
    expect(
      decodeCollaborationAwarenessProtocolUpdate(slideAwarenessFrame.update)[0]?.state,
    ).toEqual(
      expect.objectContaining({
        collaboration: expect.objectContaining({
          surface: { kind: "slides", isMaximized: false },
        }),
        selection: null,
      }),
    );

    await provider.publishAwareness({
      kind: "state",
      sessionId: provider.awarenessSessionId,
      revision: 4,
      surface: {
        kind: "whiteboard",
        isMaximized: true,
        viewport: { scrollX: 20, scrollY: -10, zoom: 2 },
      },
      cursor: null,
    });
    const whiteboardAwarenessFrame = decodeCollaborationBinaryFrame(socket.binarySent.at(-1)!);
    if (whiteboardAwarenessFrame.kind !== "awareness") {
      throw new Error("whiteboard awareness update was not sent");
    }
    expect(
      decodeCollaborationAwarenessProtocolUpdate(whiteboardAwarenessFrame.update)[0]?.state,
    ).toEqual(
      expect.objectContaining({
        collaboration: expect.objectContaining({
          surface: {
            kind: "whiteboard",
            isMaximized: true,
            viewport: { scrollX: 20, scrollY: -10, zoom: 2 },
          },
        }),
        selection: null,
      }),
    );

    const beforeEditorReturn = socket.binarySent.length;
    provider.awareness.setLocalStateField("selection", {
      anchor: standardPosition,
      head: { ...standardPosition, assoc: 1 },
    });
    expect(socket.binarySent).toHaveLength(beforeEditorReturn);
    await provider.publishAwareness({
      kind: "state",
      sessionId: provider.awarenessSessionId,
      revision: 5,
      surface: { kind: "editor", fileNodeId: null, viewport: null },
      cursor: null,
    });
    const returnedEditorFrame = decodeCollaborationBinaryFrame(socket.binarySent.at(-1)!);
    if (returnedEditorFrame.kind !== "awareness") {
      throw new Error("returned editor awareness update was not sent");
    }
    expect(
      decodeCollaborationAwarenessProtocolUpdate(returnedEditorFrame.update)[0]?.state,
    ).toEqual(
      expect.objectContaining({
        collaboration: expect.objectContaining({
          surface: { kind: "editor", fileNodeId: null, viewport: null },
        }),
        selection: { anchor: standardPosition, head: { ...standardPosition, assoc: 1 } },
      }),
    );

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
      surface: { kind: "editor", fileNodeId: null, viewport: null },
      cursor: null,
      occurredAt: Date.now(),
      expiresAt: Date.now() + 45_000,
    };
    socket.message(
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

    const source = provider.doc.getText("source");
    source.insert(source.length, "-local");
    const flushing = provider.flushNow();
    await waitUntil(() =>
      socket.binarySent
        .map((raw) => decodeCollaborationBinaryFrame(raw))
        .some((frame) => frame.kind === "client-update"),
    );
    const clientUpdate = socket.binarySent
      .map((raw) => decodeCollaborationBinaryFrame(raw))
      .find((frame) => frame.kind === "client-update");
    if (!clientUpdate || clientUpdate.kind !== "client-update") {
      throw new Error("binary document update was not sent");
    }
    // The Durable Object applies an accepted update before acknowledging it. Mirror that
    // causal ordering so the next server change is not concurrent with this local insert.
    Y.applyUpdate(server, clientUpdate.update);
    socket.message({
      type: "document.ack",
      updateId: clientUpdate.updateId,
      streamId: "2-0",
      duplicate: false,
    });
    await flushing;

    const stateVector = Y.encodeStateVector(server);
    server.getText("source").insert(server.getText("source").length, "-remote");
    socket.message(
      exactArrayBuffer(
        encodeCollaborationServerUpdate({
          streamId: "3-0",
          updateId: REMOTE_UPDATE_ID,
          update: Y.encodeStateAsUpdate(server, stateVector),
        }),
      ),
    );
    await waitUntil(() => provider.doc.getText("source").toString().endsWith("-remote"));
    expect(socket.sent.every((message) => message === "ping")).toBe(true);
    provider.stop();
  });

  it("lets a viewer receive shared slide state without publishing local document changes", async () => {
    const server = new Y.Doc();
    const slides: Slide[] = [
      { id: "one", order: 0, content: "one", contentType: "html" },
      { id: "two", order: 1, content: "two", contentType: "html" },
    ];
    seedCollaborationTeachingDocument(server, {
      slides: slides.map((slide, index) => ({
        slide,
        asset: {
          id: (index === 0 ? "a" : "b").repeat(64),
          mimeType: "application/vnd.next-editor.slide+json",
          size: 32,
        },
      })),
      whiteboardElements: [],
    });
    const socket = new FakeWebSocket();
    const api = new FakeApi();
    api.session = roomSession("viewer");
    const provider = new CollaborationRoomProvider({
      roomId: ROOM_ID,
      api,
      clientId: CLIENT_ID,
      batchWindowMs: 60_000,
      webSocketFactory: () => socket,
    });

    await provider.start();
    socket.open();
    await waitUntil(() => socket.binarySent.length === 1);
    const syncRequest = decodeCollaborationBinaryFrame(socket.binarySent[0]);
    if (syncRequest.kind !== "sync") throw new Error("state-vector sync was not requested");
    socket.message(exactArrayBuffer(encodeCollaborationSyncStep2(server, syncRequest.payload)));
    await waitUntil(() => provider.connectionState === "live");

    provider.doc.getText("viewer-local").insert(0, "must stay local");
    await provider.flushNow();
    expect(
      socket.binarySent
        .map((raw) => decodeCollaborationBinaryFrame(raw))
        .filter((frame) => frame.kind === "client-update"),
    ).toHaveLength(0);

    const stateVector = Y.encodeStateVector(server);
    setCollaborationCurrentSlide(server, "two");
    socket.message(
      exactArrayBuffer(
        encodeCollaborationServerUpdate({
          streamId: "2-0",
          updateId: REMOTE_UPDATE_ID,
          update: Y.encodeStateAsUpdate(server, stateVector),
        }),
      ),
    );
    await waitUntil(
      () => projectCollaborationTeachingDocument(provider.doc).currentSlideId === "two",
    );
    expect(projectCollaborationTeachingDocument(provider.doc).currentSlideId).toBe("two");

    provider.stop();
    server.destroy();
  });
});

function socketRecorder() {
  const sockets: FakeWebSocket[] = [];
  return {
    sockets,
    factory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
  };
}

function sentFrames(socket: FakeWebSocket) {
  return socket.binarySent.map((raw) => decodeCollaborationBinaryFrame(raw));
}

async function openAndSync(
  provider: CollaborationRoomProvider,
  socket: FakeWebSocket,
  server: Y.Doc,
): Promise<void> {
  socket.open();
  await waitUntil(() => socket.binarySent.length >= 1);
  const request = decodeCollaborationBinaryFrame(socket.binarySent[0]!);
  if (request.kind !== "sync") throw new Error("state-vector sync was not requested");
  socket.message(exactArrayBuffer(encodeCollaborationSyncStep2(server, request.payload)));
  await waitUntil(() => provider.connectionState === "live");
}

async function nextClientUpdate(socket: FakeWebSocket) {
  await waitUntil(() => sentFrames(socket).some((frame) => frame.kind === "client-update"));
  const frame = sentFrames(socket).findLast((candidate) => candidate.kind === "client-update");
  if (frame?.kind !== "client-update") throw new Error("no client update was sent");
  return frame;
}

describe("CollaborationRoomProvider connection lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetPerformanceMetricsForTests();
  });

  it("backs off between reconnect attempts and fails once they are exhausted", async () => {
    vi.useFakeTimers();
    const { sockets, factory } = socketRecorder();
    const provider = new CollaborationRoomProvider({
      roomId: ROOM_ID,
      api: new FakeApi(),
      clientId: CLIENT_ID,
      maxReconnectAttempts: 2,
      random: () => 0,
      webSocketFactory: factory,
    });

    await provider.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.close(1006, "network");
    expect(provider.connectionState).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(499);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    expect(provider.connectionState).toBe("connecting");

    sockets[1]!.close(1006, "network");
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    sockets[2]!.close(1006, "network");
    expect(provider.connectionState).toBe("failed");
    expect(provider.actor.getSnapshot().context.error).toBe(
      "Collaboration reconnect attempts were exhausted",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(3);
    provider.stop();
  });

  it("stays failed with the host's reason after a 4001 close, even with an update in flight", async () => {
    const { sockets, factory } = socketRecorder();
    const provider = new CollaborationRoomProvider({
      roomId: ROOM_ID,
      api: new FakeApi(),
      clientId: CLIENT_ID,
      batchWindowMs: 0,
      random: () => 0,
      webSocketFactory: factory,
    });
    await provider.start();
    await openAndSync(provider, sockets[0]!, new Y.Doc());

    provider.doc.getText("source").insert(0, "in flight");
    await nextClientUpdate(sockets[0]!);
    sockets[0]!.close(4001, "room closed");
    // The close rejects the pending ack; that rejection must not schedule a
    // reconnect that would clear the fatal state and its message.
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(provider.connectionState).toBe("failed");
    expect(provider.actor.getSnapshot().context.error).toBe(
      "The host ended this live collaboration room",
    );
    expect(sockets).toHaveLength(1);
    provider.stop();
  });

  it("opens no socket when stopped while the room request is in flight", async () => {
    const { sockets, factory } = socketRecorder();
    let resolveRoom: (session: CollaborationRoomSession) => void = () => {};
    const provider = new CollaborationRoomProvider({
      roomId: ROOM_ID,
      api: { getRoom: () => new Promise((resolve) => (resolveRoom = resolve)) },
      clientId: CLIENT_ID,
      webSocketFactory: factory,
    });

    const starting = provider.start();
    provider.stop();
    resolveRoom(roomSession());
    await starting;

    expect(sockets).toHaveLength(0);
    expect(provider.connectionState).toBe("disconnected");
  });

  it("applies server updates that arrive during synchronization after the snapshot", async () => {
    const { sockets, factory } = socketRecorder();
    const provider = new CollaborationRoomProvider({
      roomId: ROOM_ID,
      api: new FakeApi(),
      clientId: CLIENT_ID,
      webSocketFactory: factory,
    });
    const server = new Y.Doc();
    server.getText("source").insert(0, "snapshot");
    await provider.start();
    const socket = sockets[0]!;
    socket.open();
    await waitUntil(() => socket.binarySent.length === 1);
    const request = decodeCollaborationBinaryFrame(socket.binarySent[0]!);
    if (request.kind !== "sync") throw new Error("state-vector sync was not requested");
    const snapshot = encodeCollaborationSyncStep2(server, request.payload);

    const beforeRemote = Y.encodeStateVector(server);
    server.getText("source").insert(8, "+remote");
    socket.message(
      exactArrayBuffer(
        encodeCollaborationServerUpdate({
          streamId: "2-0",
          updateId: REMOTE_UPDATE_ID,
          update: Y.encodeStateAsUpdate(server, beforeRemote),
        }),
      ),
    );
    expect(provider.doc.getText("source").toString()).toBe("");

    socket.message(exactArrayBuffer(snapshot));
    await waitUntil(() => provider.connectionState === "live");
    expect(provider.doc.getText("source").toString()).toBe("snapshot+remote");
    provider.stop();
  });

  it("reports offline edits it can no longer send after a downgrade while offline", async () => {
    const { sockets, factory } = socketRecorder();
    const api = new FakeApi();
    const rejected: string[] = [];
    const provider = new CollaborationRoomProvider({
      roomId: ROOM_ID,
      api,
      clientId: CLIENT_ID,
      batchWindowMs: 0,
      random: () => 0,
      webSocketFactory: factory,
      onRejectedLocalChanges: (message) => rejected.push(message),
    });
    await provider.start();
    await openAndSync(provider, sockets[0]!, new Y.Doc());

    sockets[0]!.close(1006, "network");
    provider.doc.getText("source").insert(0, "offline work");
    await waitUntil(() => provider.hasPendingUpdates);
    api.session = { ...roomSession("viewer"), room: { ...roomSession().room, roleVersion: 2 } };
    await provider.retryNow();

    expect(rejected).toHaveLength(1);
    expect(provider.connectionState).toBe("failed");
    expect(provider.hasPendingUpdates).toBe(false);
    expect(sockets).toHaveLength(1);
    provider.stop();
  });

  it("drops edits the server rejects as read-only, reports them and fails", async () => {
    const { sockets, factory } = socketRecorder();
    const api = new FakeApi();
    const rejected: string[] = [];
    const provider = new CollaborationRoomProvider({
      roomId: ROOM_ID,
      api,
      clientId: CLIENT_ID,
      batchWindowMs: 0,
      webSocketFactory: factory,
      onRejectedLocalChanges: (message) => rejected.push(message),
    });
    await provider.start();
    await openAndSync(provider, sockets[0]!, new Y.Doc());

    provider.doc.getText("source").insert(0, "mine");
    const update = await nextClientUpdate(sockets[0]!);
    api.session = { ...roomSession("viewer"), room: { ...roomSession().room, roleVersion: 2 } };
    sockets[0]!.message({
      type: "error",
      code: "read-only",
      message: "This collaboration room is read-only for your role",
      fatal: false,
      updateId: update.updateId,
    });
    await waitUntil(() => provider.connectionState === "failed");

    expect(rejected).toHaveLength(1);
    expect(provider.hasPendingUpdates).toBe(false);
    expect(provider.canWrite).toBe(false);
    provider.stop();
  });
});
