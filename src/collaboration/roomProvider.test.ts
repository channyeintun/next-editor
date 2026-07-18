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
