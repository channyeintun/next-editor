import { DurableObject } from "cloudflare:workers";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { z } from "zod";
import {
  COLLABORATION_BINARY_PROTOCOL_VERSION,
  decodeCollaborationBinaryFrame,
  encodeCollaborationServerUpdate,
  encodeCollaborationSyncStep2,
} from "../../../src/collaboration/binaryProtocol";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_SQLITE_PERSISTENCE_VERSION,
  MAX_ENCODED_YJS_UPDATE_LENGTH,
  MAX_YJS_UPDATE_BYTES,
  canPublishCollaborationUpdate,
  collaborationAwarenessEventSchema,
  collaborationDocumentUpdateEventSchema,
  collaborationIdSchema,
  collaborationPersistenceVersionSchema,
  collaborationRoleSchema,
  collaborationRoomControlCommandSchema,
  collaborationRoomDocumentBroadcastSchema,
  collaborationWebSocketClientMessageSchema,
  collaborationWebSocketServerMessageSchema,
  type CollaborationAwarenessEvent,
  type CollaborationBootstrapResponse,
  type CollaborationControlEvent,
  type CollaborationDocumentUpdateEvent,
  type CollaborationDocumentUpdateInput,
  type CollaborationRole,
  type CollaborationRoomControlCommand,
  type CollaborationWebSocketServerMessage,
} from "../../../src/collaboration/protocol";
import {
  applyEncodedYjsUpdate,
  decodeYjsUpdate,
  encodeYjsUpdate,
} from "../../../src/collaboration/yjsUpdates";
import { getCollaborationRoomAccess } from "../../db/collaborationQueries";
import {
  appendCollaborationUpdate,
  compactCollaborationDocument,
  getCollaborationSnapshotGeneration,
  shouldCompactCollaborationDocument,
} from "./documentStore";
import {
  CollaborationRoomSqliteQuotaError,
  RoomSqliteDocumentStore,
  type AppendRoomSqliteUpdateResult,
  type RoomSqliteStorage,
  type StoredAppendRoomSqliteUpdateResult,
} from "./roomSqliteDocumentStore";
import { COLLABORATION_AWARENESS_TTL_MS } from "./awarenessStore";
import { CollaborationRateLimitError } from "./rateLimits";
import { getCollaborationRedis } from "./realtime";
import { publishCollaborationMaintenanceJob } from "./qstash";
import type { Env } from "../env";

const ROOM_ORIGIN = "https://collaboration-room.internal";
const SESSION_HEADER = "X-Collaboration-Session";
const MAX_WEBSOCKET_MESSAGE_LENGTH = MAX_ENCODED_YJS_UPDATE_LENGTH + 16 * 1024;
const MAX_BINARY_WEBSOCKET_MESSAGE_LENGTH = MAX_YJS_UPDATE_BYTES + 1024;
const MAX_USER_UPDATES_PER_SECOND = 30;
const MAX_ROOM_UPDATES_PER_SECOND = 120;
const MAX_AWARENESS_UPDATES_PER_SECOND = 20;
const MAX_USER_CONNECTIONS_PER_MINUTE = 30;
const ACCESS_REVALIDATION_INTERVAL_MS = 5_000;

const canonicalSocketSessionSchema = z
  .object({
    roomId: collaborationIdSchema,
    userId: collaborationIdSchema,
    username: z.string().min(1).max(64),
    name: z.string().max(120).nullable(),
    avatarUrl: z.string().max(2048).nullable(),
    hostUserId: collaborationIdSchema,
    role: collaborationRoleSchema,
    roleVersion: z.number().int().positive(),
    sessionId: collaborationIdSchema,
    attemptId: collaborationIdSchema,
    persistenceVersion: collaborationPersistenceVersionSchema,
    binaryProtocolVersion: z.literal(COLLABORATION_BINARY_PROTOCOL_VERSION).nullable(),
  })
  .strict();

type CanonicalSocketSession = z.infer<typeof canonicalSocketSessionSchema>;

const socketAttachmentSchema = canonicalSocketSessionSchema
  .extend({
    awareness: collaborationAwarenessEventSchema.optional(),
    updateWindowSecond: z.number().int().nonnegative().optional(),
    updateWindowCount: z.number().int().nonnegative().optional(),
    awarenessWindowSecond: z.number().int().nonnegative().optional(),
    awarenessWindowCount: z.number().int().nonnegative().optional(),
    accessCheckedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

type SocketAttachment = z.infer<typeof socketAttachmentSchema>;

function encodeCanonicalSession(session: CanonicalSocketSession): string {
  return encodeURIComponent(JSON.stringify(canonicalSocketSessionSchema.parse(session)));
}

function decodeCanonicalSession(request: Request): CanonicalSocketSession | null {
  const encoded = request.headers.get(SESSION_HEADER);
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded)) as unknown;
    const result = canonicalSocketSessionSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function attachmentFor(socket: WebSocket): SocketAttachment | null {
  const result = socketAttachmentSchema.safeParse(socket.deserializeAttachment());
  return result.success ? result.data : null;
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === 1;
}

function sendMessage(socket: WebSocket, message: CollaborationWebSocketServerMessage): void {
  if (!isOpen(socket)) return;
  socket.send(JSON.stringify(collaborationWebSocketServerMessageSchema.parse(message)));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function sendBinary(socket: WebSocket, bytes: Uint8Array): void {
  if (!isOpen(socket)) return;
  socket.send(exactArrayBuffer(bytes));
}

function controlEvent(
  roomId: string,
  roleVersion: number,
  kind: CollaborationControlEvent["kind"],
  targetUserId: string | null,
): CollaborationControlEvent {
  return {
    kind,
    roomId,
    roleVersion,
    targetUserId,
    occurredAt: Date.now(),
  };
}

export function hasCollaborationRoomBinding(
  env: Env,
): env is Env & { COLLABORATION_ROOMS: DurableObjectNamespace } {
  return Boolean(env.COLLABORATION_ROOMS);
}

function roomStub(env: Env, roomId: string): DurableObjectStub | null {
  if (!hasCollaborationRoomBinding(env)) return null;
  return env.COLLABORATION_ROOMS.getByName(collaborationIdSchema.parse(roomId));
}

export async function forwardCollaborationWebSocket(
  env: Env,
  request: Request,
  session: CanonicalSocketSession,
): Promise<Response> {
  const stub = roomStub(env, session.roomId);
  if (!stub) return new Response("collaboration WebSocket unavailable", { status: 503 });
  const headers = new Headers(request.headers);
  headers.set(SESSION_HEADER, encodeCanonicalSession(session));
  return stub.fetch(new Request(request, { headers }));
}

export async function notifyCollaborationRoomControl(
  env: Env,
  roomId: string,
  command: CollaborationRoomControlCommand,
): Promise<boolean> {
  const stub = roomStub(env, roomId);
  if (!stub) return false;
  const response = await stub.fetch(`${ROOM_ORIGIN}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collaborationRoomControlCommandSchema.parse(command)),
  });
  if (!response.ok) throw new Error(`room control notification failed with ${response.status}`);
  return true;
}

export async function broadcastCollaborationRoomDocument(
  env: Env,
  roomId: string,
  input: { streamId: string; event: CollaborationDocumentUpdateEvent },
): Promise<boolean> {
  const stub = roomStub(env, roomId);
  if (!stub) return false;
  const response = await stub.fetch(`${ROOM_ORIGIN}/document`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collaborationRoomDocumentBroadcastSchema.parse(input)),
  });
  if (!response.ok) throw new Error(`room document broadcast failed with ${response.status}`);
  return true;
}

const sqliteDocumentInitializationSchema = z
  .object({ roomId: collaborationIdSchema, snapshot: z.string().min(1) })
  .strict();

const sqliteAppendResultSchema = z
  .object({
    streamId: z.string().regex(/^\d+-0$/),
    updateCount: z.number().int().nonnegative(),
    duplicate: z.boolean(),
    shouldCompact: z.boolean(),
  })
  .strict();

export async function initializeCollaborationRoomSqliteDocument(
  env: Env,
  roomId: string,
  snapshot: string,
): Promise<boolean> {
  const stub = roomStub(env, roomId);
  if (!stub) return false;
  const response = await stub.fetch(`${ROOM_ORIGIN}/sqlite/initialize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sqliteDocumentInitializationSchema.parse({ roomId, snapshot })),
  });
  if (!response.ok) throw new Error(`room SQLite initialization failed with ${response.status}`);
  return true;
}

export async function getCollaborationRoomSqliteBootstrap(
  env: Env,
  roomId: string,
  cursor?: string,
): Promise<CollaborationBootstrapResponse | null> {
  const stub = roomStub(env, roomId);
  if (!stub) return null;
  const url = new URL(`${ROOM_ORIGIN}/sqlite/bootstrap`);
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await stub.fetch(url);
  if (!response.ok) throw new Error(`room SQLite bootstrap failed with ${response.status}`);
  return (await response.json()) as CollaborationBootstrapResponse;
}

export async function appendCollaborationRoomSqliteDocument(
  env: Env,
  roomId: string,
  event: CollaborationDocumentUpdateEvent,
): Promise<AppendRoomSqliteUpdateResult | null> {
  const stub = roomStub(env, roomId);
  if (!stub) return null;
  const response = await stub.fetch(`${ROOM_ORIGIN}/sqlite/append`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collaborationDocumentUpdateEventSchema.parse(event)),
  });
  if (response.status === 429) throw new CollaborationRateLimitError("update");
  if (response.status === 413) throw new CollaborationRoomSqliteQuotaError();
  if (!response.ok) throw new Error(`room SQLite append failed with ${response.status}`);
  return sqliteAppendResultSchema.parse(await response.json());
}

export async function exportCollaborationRoomSqliteDocument(
  env: Env,
  roomId: string,
): Promise<CollaborationBootstrapResponse | null> {
  const stub = roomStub(env, roomId);
  if (!stub) return null;
  const response = await stub.fetch(`${ROOM_ORIGIN}/sqlite/export`, { method: "POST" });
  if (!response.ok) throw new Error(`room SQLite export failed with ${response.status}`);
  return (await response.json()) as CollaborationBootstrapResponse;
}

export async function deleteCollaborationRoomSqliteDocument(
  env: Env,
  roomId: string,
): Promise<boolean> {
  const stub = roomStub(env, roomId);
  if (!stub) return false;
  const response = await stub.fetch(`${ROOM_ORIGIN}/sqlite/purge`, { method: "POST" });
  if (!response.ok) throw new Error(`room SQLite purge failed with ${response.status}`);
  return true;
}

export async function listCollaborationRoomSocketAwareness(
  env: Env,
  roomId: string,
): Promise<CollaborationAwarenessEvent[] | null> {
  const stub = roomStub(env, roomId);
  if (!stub) return null;
  const response = await stub.fetch(`${ROOM_ORIGIN}/participants`);
  if (!response.ok) throw new Error(`room participant lookup failed with ${response.status}`);
  const result = z
    .object({ participants: z.array(collaborationAwarenessEventSchema).max(50) })
    .safeParse(await response.json());
  if (!result.success) throw new Error("room participant response was invalid");
  return result.data.participants;
}

export class CollaborationRoomDurableObject extends DurableObject<Env> {
  private roomUpdateWindowSecond = 0;
  private roomUpdateWindowCount = 0;
  private internalUpdateWindowSecond = 0;
  private readonly internalUpdateWindowCounts = new Map<string, number>();
  private connectionWindowMinute = 0;
  private readonly connectionWindowCounts = new Map<string, number>();
  private sqliteCompactionScheduled = false;
  private readonly sqliteDocument: RoomSqliteDocumentStore;
  private binaryDocument: Y.Doc | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sqliteDocument = new RoomSqliteDocumentStore(ctx.storage as unknown as RoomSqliteStorage);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.acceptConnection(request);
    }
    if (request.method === "GET" && url.pathname === "/participants") {
      return Response.json({ participants: this.currentParticipants() });
    }
    if (request.method === "POST" && url.pathname === "/sqlite/initialize") {
      const parsed = sqliteDocumentInitializationSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        return Response.json({ error: "invalid SQLite document initialization" }, { status: 400 });
      }
      if (!this.isCurrentRoom(parsed.data.roomId)) {
        return Response.json({ error: "invalid collaboration room" }, { status: 403 });
      }
      try {
        this.sqliteDocument.initialize(parsed.data.snapshot);
        this.binaryDocument?.destroy();
        this.binaryDocument = null;
        return Response.json({ initialized: true });
      } catch (error) {
        if (error instanceof CollaborationRoomSqliteQuotaError) {
          return Response.json({ error: error.message }, { status: 413 });
        }
        throw error;
      }
    }
    if (request.method === "GET" && url.pathname === "/sqlite/bootstrap") {
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if (cursor && !/^\d+-0$/.test(cursor)) {
        return Response.json({ error: "invalid cursor" }, { status: 400 });
      }
      return Response.json(this.sqliteDocument.bootstrap(cursor));
    }
    if (request.method === "POST" && url.pathname === "/sqlite/append") {
      const parsed = collaborationDocumentUpdateEventSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        return Response.json({ error: "invalid SQLite document update" }, { status: 400 });
      }
      if (!this.isCurrentRoom(parsed.data.roomId)) {
        return Response.json({ error: "invalid collaboration room" }, { status: 403 });
      }
      try {
        if (!this.consumeInternalUpdateQuota(parsed.data.actorId)) {
          return Response.json(
            { error: "collaboration update rate limit exceeded" },
            { status: 429 },
          );
        }
        const stored = this.appendSqliteDocument(parsed.data);
        if (stored.event) {
          this.broadcastDocument(stored.streamId, stored.event);
        }
        if (stored.shouldCompact) this.scheduleSqliteCompaction();
        return Response.json({
          streamId: stored.streamId,
          updateCount: stored.updateCount,
          duplicate: stored.duplicate,
          shouldCompact: stored.shouldCompact,
        });
      } catch (error) {
        if (error instanceof CollaborationRoomSqliteQuotaError) {
          return Response.json({ error: error.message }, { status: 413 });
        }
        throw error;
      }
    }
    if (request.method === "POST" && url.pathname === "/sqlite/export") {
      return Response.json(this.sqliteDocument.exportDocument());
    }
    if (request.method === "POST" && url.pathname === "/sqlite/purge") {
      for (const socket of this.ctx.getWebSockets()) socket.close(4001, "room purged");
      this.binaryDocument?.destroy();
      this.binaryDocument = null;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return Response.json({ purged: true });
    }
    if (request.method === "POST" && url.pathname === "/control") {
      const parsed = collaborationRoomControlCommandSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success)
        return Response.json({ error: "invalid control command" }, { status: 400 });
      if (!this.isCurrentRoom(parsed.data.event.roomId)) {
        return Response.json({ error: "invalid collaboration room" }, { status: 403 });
      }
      this.applyControl(parsed.data);
      return Response.json({ delivered: true });
    }
    if (request.method === "POST" && url.pathname === "/document") {
      const parsed = collaborationRoomDocumentBroadcastSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        return Response.json({ error: "invalid document broadcast" }, { status: 400 });
      }
      if (!this.isCurrentRoom(parsed.data.event.roomId)) {
        return Response.json({ error: "invalid collaboration room" }, { status: 403 });
      }
      this.broadcast({
        type: "document.update",
        streamId: parsed.data.streamId,
        data: parsed.data.event,
      });
      return Response.json({ delivered: true });
    }
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") return;
    const attachment = attachmentFor(socket);
    if (!attachment) {
      this.rejectSocket(socket, "invalid-session", "Collaboration session is invalid", true, 1008);
      return;
    }
    if (message instanceof ArrayBuffer) {
      await this.acceptBinaryMessage(socket, attachment, message);
      return;
    }
    if (message.length > MAX_WEBSOCKET_MESSAGE_LENGTH) {
      this.rejectSocket(socket, "invalid-message", "Invalid collaboration message", true, 1009);
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(message) as unknown;
    } catch {
      this.rejectSocket(socket, "invalid-message", "Invalid collaboration message", true, 1008);
      return;
    }
    const parsed = collaborationWebSocketClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.rejectSocket(socket, "invalid-message", "Invalid collaboration message", true, 1008);
      return;
    }
    if (parsed.data.type === "awareness.state") {
      this.acceptAwareness(socket, attachment, parsed.data.data);
      return;
    }
    const refreshed = await this.refreshAccess(socket, attachment);
    if (!refreshed) return;
    await this.acceptDocumentUpdate(socket, refreshed, parsed.data.data);
  }

  private async acceptBinaryMessage(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: ArrayBuffer,
  ): Promise<void> {
    if (
      attachment.binaryProtocolVersion !== COLLABORATION_BINARY_PROTOCOL_VERSION ||
      attachment.persistenceVersion !== COLLABORATION_SQLITE_PERSISTENCE_VERSION
    ) {
      this.rejectSocket(
        socket,
        "invalid-message",
        "Binary collaboration protocol was not negotiated",
        true,
        1008,
      );
      return;
    }
    if (message.byteLength > MAX_BINARY_WEBSOCKET_MESSAGE_LENGTH) {
      this.rejectSocket(socket, "invalid-message", "Binary message is too large", true, 1009);
      return;
    }

    let frame;
    try {
      frame = decodeCollaborationBinaryFrame(message);
    } catch {
      this.rejectSocket(
        socket,
        "invalid-message",
        "Invalid binary collaboration message",
        true,
        1008,
      );
      return;
    }
    if (frame.kind === "sync") {
      if (frame.messageType !== syncProtocol.messageYjsSyncStep1) {
        this.rejectSocket(socket, "invalid-message", "Invalid Yjs sync request", true, 1008);
        return;
      }
      const refreshed = await this.refreshAccess(socket, attachment);
      if (!refreshed) return;
      sendBinary(socket, encodeCollaborationSyncStep2(this.getBinaryDocument(), frame.payload));
      return;
    }
    if (frame.kind !== "client-update" || frame.update.byteLength > MAX_YJS_UPDATE_BYTES) {
      this.rejectSocket(socket, "invalid-message", "Invalid binary document update", true, 1008);
      return;
    }
    const refreshed = await this.refreshAccess(socket, attachment);
    if (!refreshed) return;
    const input: CollaborationDocumentUpdateInput = {
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
      clientId: frame.clientId,
      updateId: frame.updateId,
      update: encodeYjsUpdate(frame.update),
    };
    await this.acceptDocumentUpdate(socket, refreshed, input);
  }

  webSocketClose(socket: WebSocket): void {
    this.broadcastLeave(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.broadcastLeave(socket);
  }

  alarm(): void {
    this.sqliteCompactionScheduled = false;
    const startedAt = performance.now();
    try {
      const result = this.sqliteDocument.compact();
      console.log("collaboration_sqlite_compaction", {
        roomId: this.ctx.id.name ?? null,
        ...result,
        durationMs: performance.now() - startedAt,
      });
    } catch (error) {
      console.error("collaboration_sqlite_compaction_failed", {
        roomId: this.ctx.id.name ?? null,
        durationMs: performance.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private acceptConnection(request: Request): Response {
    const session = decodeCanonicalSession(request);
    if (!session) return new Response("invalid collaboration session", { status: 403 });
    if (
      !this.isCurrentRoom(session.roomId) ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("invalid collaboration room", { status: 403 });
    }
    if (!this.consumeConnectionQuota(session.userId)) {
      return new Response("collaboration connection rate limit exceeded", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }

    for (const existing of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(existing);
      if (attachment?.userId === session.userId && attachment.sessionId === session.sessionId) {
        this.broadcastLeave(existing);
        existing.serializeAttachment({
          ...attachment,
          awareness: undefined,
        } satisfies SocketAttachment);
        existing.close(4000, "replaced by reconnect");
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: SocketAttachment = { ...session, accessCheckedAt: Date.now() };
    this.ctx.acceptWebSocket(server, [`room:${session.roomId}`, `user:${session.userId}`]);
    server.serializeAttachment(attachment);
    sendMessage(server, {
      type: "session.ready",
      sessionId: session.sessionId,
      attemptId: session.attemptId,
      binaryProtocolVersion: session.binaryProtocolVersion,
      participants: this.currentParticipants(),
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private isCurrentRoom(roomId: string): boolean {
    const objectName = this.ctx.id.name;
    return !objectName || objectName === roomId;
  }

  private currentParticipants(): CollaborationAwarenessEvent[] {
    const bySession = new Map<string, CollaborationAwarenessEvent>();
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      if (!isOpen(socket)) continue;
      const awareness = attachmentFor(socket)?.awareness;
      if (!awareness || awareness.kind !== "state" || awareness.expiresAt <= now) continue;
      const key = `${awareness.actorId}:${awareness.sessionId}`;
      const previous = bySession.get(key);
      if (!previous || previous.revision <= awareness.revision) bySession.set(key, awareness);
    }
    return Array.from(bySession.values());
  }

  private async refreshAccess(
    socket: WebSocket,
    attachment: SocketAttachment,
  ): Promise<SocketAttachment | null> {
    if (
      attachment.persistenceVersion === COLLABORATION_SQLITE_PERSISTENCE_VERSION &&
      attachment.accessCheckedAt !== undefined &&
      Date.now() - attachment.accessCheckedAt < ACCESS_REVALIDATION_INTERVAL_MS
    ) {
      return attachment;
    }
    const access = await getCollaborationRoomAccess(
      this.env.DB,
      attachment.roomId,
      attachment.userId,
    );
    if (
      !access ||
      access.transport !== "cloudflare-websocket" ||
      access.persistence_version !== attachment.persistenceVersion
    ) {
      this.rejectSocket(socket, "access-revoked", "Room access was revoked", true, 4003);
      return null;
    }
    if (access.status !== "active") {
      sendMessage(socket, {
        type: "control.room",
        data: controlEvent(access.id, access.role_version, "room-closed", null),
      });
      socket.close(4001, "room closed");
      return null;
    }
    if (access.member_role !== attachment.role || access.role_version !== attachment.roleVersion) {
      const next = this.withRole(
        { ...attachment, accessCheckedAt: Date.now() },
        access.member_role,
        access.role_version,
      );
      socket.serializeAttachment(next);
      sendMessage(socket, {
        type: "control.room",
        data: controlEvent(access.id, access.role_version, "membership-changed", attachment.userId),
      });
      return next;
    }
    const checkedAttachment = { ...attachment, accessCheckedAt: Date.now() };
    socket.serializeAttachment(checkedAttachment);
    return checkedAttachment;
  }

  private withRole(
    attachment: SocketAttachment,
    role: CollaborationRole,
    roleVersion: number,
  ): SocketAttachment {
    const awareness = attachment.awareness;
    return {
      ...attachment,
      role,
      roleVersion,
      accessCheckedAt: Date.now(),
      ...(awareness?.kind === "state"
        ? { awareness: { ...awareness, role, isHost: attachment.hostUserId === attachment.userId } }
        : {}),
    };
  }

  private acceptAwareness(
    socket: WebSocket,
    attachment: SocketAttachment,
    input: Extract<
      z.infer<typeof collaborationWebSocketClientMessageSchema>,
      { type: "awareness.state" }
    >["data"],
  ): void {
    if (input.sessionId !== attachment.sessionId) {
      this.rejectSocket(socket, "invalid-session", "Awareness session does not match", true, 1008);
      return;
    }
    const second = Math.floor(Date.now() / 1000);
    const count =
      attachment.awarenessWindowSecond === second ? (attachment.awarenessWindowCount ?? 0) + 1 : 1;
    if (count > MAX_AWARENESS_UPDATES_PER_SECOND) {
      this.rejectSocket(socket, "rate-limited", "Awareness rate limit exceeded", false);
      return;
    }
    const now = Date.now();
    const event: CollaborationAwarenessEvent =
      input.kind === "leave"
        ? {
            ...input,
            roomId: attachment.roomId,
            actorId: attachment.userId,
            occurredAt: now,
          }
        : {
            ...input,
            roomId: attachment.roomId,
            actorId: attachment.userId,
            role: attachment.role,
            username: attachment.username,
            name: attachment.name,
            avatarUrl: attachment.avatarUrl,
            isHost: attachment.hostUserId === attachment.userId,
            occurredAt: now,
            expiresAt: now + COLLABORATION_AWARENESS_TTL_MS,
          };
    socket.serializeAttachment({
      ...attachment,
      awarenessWindowSecond: second,
      awarenessWindowCount: count,
      ...(event.kind === "state" ? { awareness: event } : { awareness: undefined }),
    } satisfies SocketAttachment);
    this.broadcast({ type: "awareness.state", data: event });
  }

  private async acceptDocumentUpdate(
    socket: WebSocket,
    attachment: SocketAttachment,
    input: Extract<
      z.infer<typeof collaborationWebSocketClientMessageSchema>,
      { type: "document.update" }
    >["data"],
  ): Promise<void> {
    const handlerStartedAt = performance.now();
    if (!canPublishCollaborationUpdate(attachment.role)) {
      this.rejectSocket(
        socket,
        "read-only",
        "This collaboration room is read-only for your role",
        false,
        undefined,
        input.updateId,
      );
      return;
    }
    const second = Math.floor(Date.now() / 1000);
    const userCount =
      attachment.updateWindowSecond === second ? (attachment.updateWindowCount ?? 0) + 1 : 1;
    if (this.roomUpdateWindowSecond !== second) {
      this.roomUpdateWindowSecond = second;
      this.roomUpdateWindowCount = 0;
      this.internalUpdateWindowCounts.clear();
    }
    this.roomUpdateWindowCount += 1;
    if (
      userCount > MAX_USER_UPDATES_PER_SECOND ||
      this.roomUpdateWindowCount > MAX_ROOM_UPDATES_PER_SECOND
    ) {
      this.rejectSocket(
        socket,
        "rate-limited",
        "Collaboration update rate limit exceeded",
        false,
        undefined,
        input.updateId,
      );
      return;
    }
    socket.serializeAttachment({
      ...attachment,
      updateWindowSecond: second,
      updateWindowCount: userCount,
    } satisfies SocketAttachment);

    const event: CollaborationDocumentUpdateEvent = {
      ...input,
      roomId: attachment.roomId,
      actorId: attachment.userId,
      receivedAt: Date.now(),
    };
    try {
      if (attachment.persistenceVersion === COLLABORATION_SQLITE_PERSISTENCE_VERSION) {
        const persistenceStartedAt = performance.now();
        const result = this.appendSqliteDocument(event);
        const persistedAt = performance.now();
        sendMessage(socket, {
          type: "document.ack",
          updateId: event.updateId,
          streamId: result.streamId,
          duplicate: result.duplicate,
        });
        const acknowledgedAt = performance.now();
        if (result.event) {
          this.broadcastDocument(result.streamId, result.event, socket);
        }
        const broadcastAt = performance.now();
        if (result.shouldCompact) this.scheduleSqliteCompaction();
        console.log("collaboration_websocket_update", {
          roomId: attachment.roomId,
          actorId: attachment.userId,
          updateId: event.updateId,
          bytes: Math.floor((event.update.length * 3) / 4),
          duplicate: result.duplicate,
          updateCount: result.updateCount,
          persistence: "do-sqlite",
          durableInsertMs: persistedAt - persistenceStartedAt,
          acknowledgeMs: acknowledgedAt - persistedAt,
          broadcastMs: broadcastAt - acknowledgedAt,
          totalMs: broadcastAt - handlerStartedAt,
        });
        return;
      }

      const redis = getCollaborationRedis(this.env);
      const persistenceStartedAt = performance.now();
      const result = await appendCollaborationUpdate(redis, event, { publish: false });
      const persistedAt = performance.now();
      sendMessage(socket, {
        type: "document.ack",
        updateId: event.updateId,
        streamId: result.streamId,
        duplicate: result.duplicate,
      });
      const acknowledgedAt = performance.now();
      this.broadcast({ type: "document.update", streamId: result.streamId, data: event }, socket);
      const broadcastAt = performance.now();
      if (shouldCompactCollaborationDocument(result.updateCount)) {
        this.scheduleCompaction(attachment.roomId);
      }
      console.log("collaboration_websocket_update", {
        roomId: attachment.roomId,
        actorId: attachment.userId,
        updateId: event.updateId,
        bytes: Math.floor((event.update.length * 3) / 4),
        duplicate: result.duplicate,
        updateCount: result.updateCount,
        persistence: "upstash-redis",
        persistenceMs: persistedAt - persistenceStartedAt,
        acknowledgeMs: acknowledgedAt - persistedAt,
        broadcastMs: broadcastAt - acknowledgedAt,
        totalMs: broadcastAt - handlerStartedAt,
      });
    } catch (error) {
      console.error("collaboration_websocket_update_failed", {
        roomId: attachment.roomId,
        actorId: attachment.userId,
        updateId: event.updateId,
        totalMs: performance.now() - handlerStartedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      const quotaExceeded = error instanceof CollaborationRoomSqliteQuotaError;
      this.rejectSocket(
        socket,
        quotaExceeded ? "quota-exceeded" : "persistence-failed",
        quotaExceeded
          ? "Collaboration room document quota exceeded"
          : "Collaboration update could not be persisted",
        false,
        quotaExceeded ? undefined : 1011,
        event.updateId,
      );
    }
  }

  private scheduleCompaction(roomId: string): void {
    this.ctx.waitUntil(
      (async () => {
        const redis = getCollaborationRedis(this.env);
        const expectedGeneration = await getCollaborationSnapshotGeneration(redis, roomId);
        try {
          const result = await publishCollaborationMaintenanceJob(this.env, {
            kind: "compact-room",
            roomId,
            expectedGeneration,
          });
          if (result.queued) return;
        } catch (error) {
          console.error("collaboration_websocket_qstash_publish_failed", {
            roomId,
            expectedGeneration,
            fallback: "inline-compaction",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await compactCollaborationDocument(redis, roomId, expectedGeneration);
      })().catch((error) => {
        console.error("collaboration_websocket_compaction_failed", {
          roomId,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }

  private appendSqliteDocument(
    event: CollaborationDocumentUpdateEvent,
  ): StoredAppendRoomSqliteUpdateResult {
    const result = this.sqliteDocument.append(event);
    if (!result.duplicate && this.binaryDocument) {
      applyEncodedYjsUpdate(this.binaryDocument, event.update, "sqlite-live-update");
    }
    return result;
  }

  private getBinaryDocument(): Y.Doc {
    if (!this.binaryDocument) this.binaryDocument = this.sqliteDocument.createDocument();
    return this.binaryDocument;
  }

  private consumeInternalUpdateQuota(actorId: string): boolean {
    const second = Math.floor(Date.now() / 1_000);
    if (this.internalUpdateWindowSecond !== second) {
      this.internalUpdateWindowSecond = second;
      this.internalUpdateWindowCounts.clear();
    }
    if (this.roomUpdateWindowSecond !== second) {
      this.roomUpdateWindowSecond = second;
      this.roomUpdateWindowCount = 0;
    }
    const userCount = (this.internalUpdateWindowCounts.get(actorId) ?? 0) + 1;
    this.internalUpdateWindowCounts.set(actorId, userCount);
    this.roomUpdateWindowCount += 1;
    return (
      userCount <= MAX_USER_UPDATES_PER_SECOND &&
      this.roomUpdateWindowCount <= MAX_ROOM_UPDATES_PER_SECOND
    );
  }

  private consumeConnectionQuota(userId: string): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.connectionWindowMinute !== minute) {
      this.connectionWindowMinute = minute;
      this.connectionWindowCounts.clear();
    }
    const count = (this.connectionWindowCounts.get(userId) ?? 0) + 1;
    this.connectionWindowCounts.set(userId, count);
    return count <= MAX_USER_CONNECTIONS_PER_MINUTE;
  }

  private scheduleSqliteCompaction(): void {
    if (this.sqliteCompactionScheduled) return;
    this.sqliteCompactionScheduled = true;
    this.ctx.waitUntil(
      this.ctx.storage
        .getAlarm()
        .then((scheduledAt) =>
          scheduledAt === null ? this.ctx.storage.setAlarm(Date.now() + 1_000) : undefined,
        )
        .catch((error) => {
          this.sqliteCompactionScheduled = false;
          console.error("collaboration_sqlite_alarm_failed", {
            roomId: this.ctx.id.name ?? null,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    );
  }

  private applyControl(command: CollaborationRoomControlCommand): void {
    const { event } = command;
    if (event.kind === "room-closed") {
      this.broadcast({ type: "control.room", data: event });
      for (const socket of this.ctx.getWebSockets()) socket.close(4001, "room closed");
      return;
    }

    const changedAwareness: CollaborationAwarenessEvent[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(socket);
      if (!attachment || attachment.roomId !== event.roomId) continue;
      if (event.targetUserId && attachment.userId === event.targetUserId) {
        if (command.targetRole === null || command.targetRole === undefined) {
          sendMessage(socket, { type: "control.room", data: event });
          socket.close(4003, "room access revoked");
          continue;
        }
        const next = this.withRole(attachment, command.targetRole, event.roleVersion);
        socket.serializeAttachment(next);
        if (next.awareness) changedAwareness.push(next.awareness);
      } else if (attachment.roleVersion < event.roleVersion) {
        socket.serializeAttachment({ ...attachment, roleVersion: event.roleVersion });
      }
      sendMessage(socket, { type: "control.room", data: event });
    }
    for (const awareness of changedAwareness) {
      this.broadcast({ type: "awareness.state", data: awareness });
    }
  }

  private broadcastDocument(
    streamId: string,
    event: CollaborationDocumentUpdateEvent,
    except?: WebSocket,
  ): void {
    const json = JSON.stringify(
      collaborationWebSocketServerMessageSchema.parse({
        type: "document.update",
        streamId,
        data: event,
      }),
    );
    const binary = exactArrayBuffer(
      encodeCollaborationServerUpdate({
        streamId,
        updateId: event.updateId,
        update: decodeYjsUpdate(event.update),
      }),
    );
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except || !isOpen(socket)) continue;
      try {
        const attachment = attachmentFor(socket);
        socket.send(
          attachment?.binaryProtocolVersion === COLLABORATION_BINARY_PROTOCOL_VERSION
            ? binary
            : json,
        );
      } catch {
        socket.close(1011, "broadcast failed");
      }
    }
  }

  private broadcast(message: CollaborationWebSocketServerMessage, except?: WebSocket): void {
    const encoded = JSON.stringify(collaborationWebSocketServerMessageSchema.parse(message));
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except || !isOpen(socket)) continue;
      try {
        socket.send(encoded);
      } catch {
        socket.close(1011, "broadcast failed");
      }
    }
  }

  private broadcastLeave(socket: WebSocket): void {
    const attachment = attachmentFor(socket);
    if (!attachment?.awareness || attachment.awareness.kind !== "state") return;
    const event: CollaborationAwarenessEvent = {
      kind: "leave",
      roomId: attachment.roomId,
      actorId: attachment.userId,
      sessionId: attachment.sessionId,
      revision: attachment.awareness.revision + 1,
      occurredAt: Date.now(),
    };
    this.broadcast({ type: "awareness.state", data: event }, socket);
  }

  private rejectSocket(
    socket: WebSocket,
    code: string,
    message: string,
    fatal: boolean,
    closeCode?: number,
    updateId?: string,
  ): void {
    sendMessage(socket, {
      type: "error",
      code,
      message,
      fatal,
      ...(updateId ? { updateId } : {}),
    });
    if (closeCode) socket.close(closeCode, message.slice(0, 120));
  }
}
