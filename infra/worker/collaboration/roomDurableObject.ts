import { DurableObject } from "cloudflare:workers";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { z } from "zod";
import {
  decodeCollaborationAwarenessProtocolUpdate,
  decodeCollaborationBinaryFrame,
  encodeCollaborationAwarenessProtocolUpdate,
  encodeCollaborationAwarenessUpdate,
  encodeCollaborationServerUpdate,
  encodeCollaborationSyncStep2,
  type CollaborationAwarenessProtocolEntry,
  type CollaborationBinaryFrame,
} from "../../../src/collaboration/binaryProtocol";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_SQLITE_PERSISTENCE_VERSION,
  COLLABORATION_AWARENESS_TTL_MS,
  MAX_YJS_SNAPSHOT_BYTES,
  MAX_YJS_UPDATE_BYTES,
  canPublishCollaborationUpdate,
  collaborationAwarenessClientStateSchema,
  collaborationAwarenessEventSchema,
  collaborationAwarenessServerStateSchema,
  collaborationIdSchema,
  collaborationRoleSchema,
  collaborationRoomControlCommandSchema,
  collaborationTeachingInitializationInputSchema,
  collaborationWebSocketServerMessageSchema,
  type CollaborationAwarenessEvent,
  type CollaborationAwarenessInput,
  type CollaborationBootstrapResponse,
  type CollaborationControlEvent,
  type CollaborationDocumentUpdateEvent,
  type CollaborationTeachingInitializationInput,
  type CollaborationRole,
  type CollaborationRoomControlCommand,
  type CollaborationWebSocketServerMessage,
} from "../../../src/collaboration/protocol";
import {
  CollaborationTeachingError,
  assertCollaborationTeachingTransition,
  collaborationTransactionTouchesOnlyTeaching,
  collaborationTransactionTouchesTeaching,
  validateCollaborationTeachingDocument,
  type CollaborationTeachingIntegrity,
} from "../../../src/collaboration/teachingDocument";
import {
  CollaborationProjectError,
  assertCollaborationProjectStructure,
  projectCollaborationDocument,
} from "../../../src/collaboration/projectDocument";
import {
  decodeYjsSnapshot,
  decodeYjsUpdate,
  encodeYjsUpdate,
} from "../../../src/collaboration/yjsUpdates";
import { getCollaborationRoomAccess } from "../../db/collaborationQueries";
import { getCollaborationAsset } from "../../db/collaborationQueries";
import {
  CollaborationRoomSqliteQuotaError,
  RoomSqliteDocumentStore,
  type RoomSqliteStorage,
  type StoredAppendRoomSqliteUpdateResult,
} from "./roomSqliteDocumentStore";
import { collaborationAssetKey } from "./assetStore";
import { exactArrayBuffer } from "./bytes";
import type { CollaborationRoomLocationHint } from "./roomLocation";
import {
  ConnectionQuota,
  decodeHeaderJson,
  encodeHeaderJson,
  isCurrentRoom,
  isOpen,
} from "./socketSupport";
import type { Env } from "../env";

const ROOM_ORIGIN = "https://collaboration-room.internal";
const SESSION_HEADER = "X-Collaboration-Session";
const MAX_BINARY_WEBSOCKET_MESSAGE_LENGTH = MAX_YJS_UPDATE_BYTES + 1024;
const MAX_BINARY_AWARENESS_MESSAGE_LENGTH = 16 * 1024;
// Counted per socket (the window lives in its attachment), not per user.
const MAX_SOCKET_UPDATES_PER_SECOND = 30;
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
  })
  .strict();

type CanonicalSocketSession = z.infer<typeof canonicalSocketSessionSchema>;

const socketAttachmentSchema = canonicalSocketSessionSchema
  .extend({
    awareness: collaborationAwarenessEventSchema.optional(),
    awarenessClientId: z.number().int().nonnegative().max(0xffff_ffff).optional(),
    awarenessClock: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    awarenessState: collaborationAwarenessServerStateSchema.optional(),
    updateWindowSecond: z.number().int().nonnegative().optional(),
    updateWindowCount: z.number().int().nonnegative().optional(),
    awarenessWindowSecond: z.number().int().nonnegative().optional(),
    awarenessWindowCount: z.number().int().nonnegative().optional(),
    accessCheckedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

type SocketAttachment = z.infer<typeof socketAttachmentSchema>;

type ClientUpdateFrame = Extract<CollaborationBinaryFrame, { kind: "client-update" }>;

function attachmentFor(socket: WebSocket): SocketAttachment | null {
  const result = socketAttachmentSchema.safeParse(socket.deserializeAttachment());
  return result.success ? result.data : null;
}

function sendMessage(socket: WebSocket, message: CollaborationWebSocketServerMessage): void {
  if (!isOpen(socket)) return;
  socket.send(JSON.stringify(collaborationWebSocketServerMessageSchema.parse(message)));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
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

function roomStub(
  env: Env,
  roomId: string,
  locationHint?: CollaborationRoomLocationHint,
): DurableObjectStub | null {
  if (!hasCollaborationRoomBinding(env)) return null;
  return env.COLLABORATION_ROOMS.getByName(
    collaborationIdSchema.parse(roomId),
    locationHint ? { locationHint } : undefined,
  );
}

export async function forwardCollaborationWebSocket(
  env: Env,
  request: Request,
  session: CanonicalSocketSession,
): Promise<Response> {
  const stub = roomStub(env, session.roomId);
  if (!stub) return new Response("collaboration WebSocket unavailable", { status: 503 });
  const headers = new Headers(request.headers);
  headers.set(SESSION_HEADER, encodeHeaderJson(canonicalSocketSessionSchema, session));
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

const sqliteDocumentInitializationSchema = z
  .object({ roomId: collaborationIdSchema, snapshot: z.string().min(1) })
  .strict();

const teachingDocumentInitializationSchema = z
  .object({
    roomId: collaborationIdSchema,
    actorId: collaborationIdSchema,
    update: collaborationTeachingInitializationInputSchema,
  })
  .strict();

export async function initializeCollaborationRoomSqliteDocument(
  env: Env,
  roomId: string,
  snapshot: string,
  locationHint?: CollaborationRoomLocationHint,
): Promise<boolean> {
  // Location hints affect only first placement. Passing the creator's region
  // here keeps the room near its host; Cloudflare ignores it for an existing ID.
  const stub = roomStub(env, roomId, locationHint);
  if (!stub) return false;
  const response = await stub.fetch(`${ROOM_ORIGIN}/sqlite/initialize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sqliteDocumentInitializationSchema.parse({ roomId, snapshot })),
  });
  if (!response.ok) throw new Error(`room SQLite initialization failed with ${response.status}`);
  return true;
}

export async function initializeCollaborationRoomTeachingDocument(
  env: Env,
  roomId: string,
  actorId: string,
  update: CollaborationTeachingInitializationInput,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const stub = roomStub(env, roomId);
  if (!stub) return { ok: false, status: 503, error: "collaboration transport unavailable" };
  const response = await stub.fetch(`${ROOM_ORIGIN}/sqlite/teaching/initialize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(teachingDocumentInitializationSchema.parse({ roomId, actorId, update })),
  });
  if (response.ok) return { ok: true };
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return {
    ok: false,
    status: response.status,
    error: typeof body?.error === "string" ? body.error : "teaching initialization failed",
  };
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

export class CollaborationRoomDurableObject extends DurableObject<Env> {
  private roomUpdateWindowSecond = 0;
  private roomUpdateWindowCount = 0;
  private readonly connectionQuota = new ConnectionQuota(MAX_USER_CONNECTIONS_PER_MINUTE);
  private sqliteCompactionScheduled = false;
  private readonly sqliteDocument: RoomSqliteDocumentStore;
  private binaryDocument: Y.Doc | null = null;
  private binaryTeachingIntegrity: CollaborationTeachingIntegrity | null = null;
  private teachingInitializationTail: Promise<void> = Promise.resolve();

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
    if (request.method === "POST" && url.pathname === "/sqlite/initialize") {
      const parsed = sqliteDocumentInitializationSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        return Response.json({ error: "invalid SQLite document initialization" }, { status: 400 });
      }
      if (!isCurrentRoom(this.ctx, parsed.data.roomId)) {
        return Response.json({ error: "invalid collaboration room" }, { status: 403 });
      }
      this.sqliteDocument.initialize(parsed.data.snapshot);
      this.resetBinaryDocument();
      return Response.json({ initialized: true });
    }
    if (request.method === "POST" && url.pathname === "/sqlite/export") {
      return Response.json(this.sqliteDocument.exportDocument());
    }
    if (request.method === "POST" && url.pathname === "/sqlite/teaching/initialize") {
      const parsed = teachingDocumentInitializationSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success || !isCurrentRoom(this.ctx, parsed.data.roomId)) {
        return Response.json({ error: "invalid teaching initialization" }, { status: 400 });
      }
      return this.initializeTeachingDocument(parsed.data);
    }
    if (request.method === "POST" && url.pathname === "/sqlite/purge") {
      for (const socket of this.ctx.getWebSockets()) socket.close(4001, "room purged");
      this.resetBinaryDocument();
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
      if (!isCurrentRoom(this.ctx, parsed.data.event.roomId)) {
        return Response.json({ error: "invalid collaboration room" }, { status: 403 });
      }
      this.applyControl(parsed.data);
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
    if (typeof message === "string") {
      this.rejectSocket(
        socket,
        "invalid-message",
        "Binary collaboration message required",
        true,
        1008,
      );
      return;
    }
    await this.acceptBinaryMessage(socket, attachment, message);
  }

  private async acceptBinaryMessage(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: ArrayBuffer,
  ): Promise<void> {
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
    if (frame.kind === "awareness") {
      if (frame.update.byteLength > MAX_BINARY_AWARENESS_MESSAGE_LENGTH) {
        this.rejectSocket(socket, "invalid-message", "Awareness message is too large", true, 1009);
        return;
      }
      // A member who only watches sends no document frames but renews
      // awareness every 15 s, so this is where a missed revocation surfaces.
      const refreshed = await this.refreshAccess(socket, attachment);
      if (!refreshed) return;
      this.acceptBinaryAwareness(socket, refreshed, frame.update);
      return;
    }
    if (frame.kind === "sync") {
      if (frame.messageType !== syncProtocol.messageYjsSyncStep1) {
        this.rejectSocket(socket, "invalid-message", "Invalid Yjs sync request", true, 1008);
        return;
      }
      const refreshed = await this.refreshAccess(socket, attachment);
      if (!refreshed) return;
      const document = this.getBinaryDocument();
      let stepTwo: Uint8Array;
      try {
        // The envelope decoder leaves the state vector opaque; Yjs reads it here.
        stepTwo = encodeCollaborationSyncStep2(document, frame.payload);
      } catch {
        this.rejectSocket(socket, "invalid-message", "Invalid Yjs sync request", true, 1008);
        return;
      }
      sendBinary(socket, stepTwo);
      return;
    }
    if (frame.kind !== "client-update" || frame.update.byteLength > MAX_YJS_UPDATE_BYTES) {
      this.rejectSocket(socket, "invalid-message", "Invalid binary document update", true, 1008);
      return;
    }
    const refreshed = await this.refreshAccess(socket, attachment);
    if (!refreshed) return;
    this.acceptDocumentUpdate(socket, refreshed, frame);
  }

  webSocketClose(socket: WebSocket): void {
    this.broadcastLeave(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.broadcastLeave(socket);
  }

  async alarm(): Promise<void> {
    this.sqliteCompactionScheduled = false;
    const startedAt = performance.now();
    try {
      const result = this.sqliteDocument.compact();
      console.log("collaboration_sqlite_compaction", {
        roomId: this.ctx.id.name ?? null,
        ...result,
        durationMs: performance.now() - startedAt,
      });
      // A pass folds at most one batch; run the next one right away.
      if (result.hasMore) await this.ctx.storage.setAlarm(Date.now());
    } catch (error) {
      console.error("collaboration_sqlite_compaction_failed", {
        roomId: this.ctx.id.name ?? null,
        durationMs: performance.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private acceptConnection(request: Request): Response {
    const session = decodeHeaderJson(canonicalSocketSessionSchema, request, SESSION_HEADER);
    if (!session) return new Response("invalid collaboration session", { status: 403 });
    if (!isCurrentRoom(this.ctx, session.roomId)) {
      return new Response("invalid collaboration room", { status: 403 });
    }
    if (!this.connectionQuota.consume(session.userId)) {
      return new Response("collaboration connection rate limit exceeded", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }

    for (const existing of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(existing);
      if (attachment?.sessionId !== session.sessionId) continue;
      if (attachment.userId !== session.userId) {
        return new Response("collaboration session is already in use", { status: 409 });
      }
      this.broadcastLeave(existing);
      existing.serializeAttachment({
        ...attachment,
        awareness: undefined,
        awarenessState: undefined,
      } satisfies SocketAttachment);
      existing.close(4000, "replaced by reconnect");
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
    });
    const now = Date.now();
    for (const existing of this.ctx.getWebSockets()) {
      if (existing === server || !isOpen(existing)) continue;
      const existingAttachment = attachmentFor(existing);
      if (
        existingAttachment?.awareness?.kind !== "state" ||
        existingAttachment.awareness.expiresAt <= now ||
        existingAttachment.awarenessClientId === undefined ||
        existingAttachment.awarenessClock === undefined ||
        !existingAttachment.awarenessState
      ) {
        continue;
      }
      sendBinary(
        server,
        encodeCollaborationAwarenessUpdate(
          encodeCollaborationAwarenessProtocolUpdate([
            {
              clientId: existingAttachment.awarenessClientId,
              clock: existingAttachment.awarenessClock,
              state: existingAttachment.awarenessState,
            },
          ]),
        ),
      );
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private awarenessClientIdInUse(clientId: number, except?: WebSocket): boolean {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except || !isOpen(socket)) continue;
      if (attachmentFor(socket)?.awarenessClientId === clientId) return true;
    }
    return false;
  }

  private async refreshAccess(
    socket: WebSocket,
    attachment: SocketAttachment,
  ): Promise<SocketAttachment | null> {
    if (
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
    // D1 is not this object's storage, so other events ran while it answered:
    // /control may have changed the role or closed the socket, and awareness
    // frames may have updated the attachment. Build on what is stored now.
    const latest = attachmentFor(socket);
    if (!latest || !isOpen(socket)) return null;
    // A control command that landed during the read is newer than this row;
    // keep it and let a later frame revalidate.
    if (latest.roleVersion !== attachment.roleVersion) return latest;
    if (
      !access ||
      access.transport !== "cloudflare-websocket" ||
      access.persistence_version !== COLLABORATION_SQLITE_PERSISTENCE_VERSION
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
    if (access.member_role !== latest.role || access.role_version !== latest.roleVersion) {
      const next = this.withRole(
        { ...latest, accessCheckedAt: Date.now() },
        access.member_role,
        access.role_version,
      );
      socket.serializeAttachment(next);
      sendMessage(socket, {
        type: "control.room",
        data: controlEvent(access.id, access.role_version, "membership-changed", latest.userId),
      });
      return next;
    }
    const checkedAttachment = { ...latest, accessCheckedAt: Date.now() };
    socket.serializeAttachment(checkedAttachment);
    return checkedAttachment;
  }

  private withRole(
    attachment: SocketAttachment,
    role: CollaborationRole,
    roleVersion: number,
  ): SocketAttachment {
    const awareness = attachment.awareness;
    const updatedAwareness =
      awareness?.kind === "state"
        ? { ...awareness, role, isHost: attachment.hostUserId === attachment.userId }
        : undefined;
    const awarenessState =
      updatedAwareness && attachment.awarenessState
        ? collaborationAwarenessServerStateSchema.parse({
            ...attachment.awarenessState,
            collaboration: updatedAwareness,
          })
        : attachment.awarenessState;
    return {
      ...attachment,
      role,
      roleVersion,
      accessCheckedAt: Date.now(),
      awarenessState,
      ...(updatedAwareness ? { awareness: updatedAwareness } : {}),
    };
  }

  private acceptBinaryAwareness(
    socket: WebSocket,
    attachment: SocketAttachment,
    update: Uint8Array,
  ): void {
    let entries: CollaborationAwarenessProtocolEntry[];
    try {
      entries = decodeCollaborationAwarenessProtocolUpdate(update);
    } catch {
      this.rejectSocket(socket, "invalid-message", "Invalid awareness update", true, 1008);
      return;
    }
    const entry = entries[0];
    if (
      !entry ||
      entries.length !== 1 ||
      entry.clientId > 0xffff_ffff ||
      entry.clock > Number.MAX_SAFE_INTEGER
    ) {
      this.rejectSocket(socket, "invalid-message", "Invalid awareness update", true, 1008);
      return;
    }
    if (
      (attachment.awarenessClientId !== undefined &&
        attachment.awarenessClientId !== entry.clientId) ||
      (attachment.awarenessClientId === undefined &&
        this.awarenessClientIdInUse(entry.clientId, socket))
    ) {
      this.rejectSocket(socket, "invalid-session", "Awareness client identity changed", true, 1008);
      return;
    }
    if (attachment.awarenessClock !== undefined && entry.clock <= attachment.awarenessClock) return;

    if (entry.state === null) {
      if (!attachment.awareness || attachment.awareness.kind !== "state") {
        socket.serializeAttachment({
          ...attachment,
          awarenessClientId: entry.clientId,
          awarenessClock: entry.clock,
          awareness: undefined,
          awarenessState: undefined,
        } satisfies SocketAttachment);
        return;
      }
      this.acceptAwareness(
        socket,
        attachment,
        {
          kind: "leave",
          sessionId: attachment.sessionId,
          revision: Math.min(attachment.awareness.revision + 1, Number.MAX_SAFE_INTEGER),
        },
        entry,
      );
      return;
    }

    const state = collaborationAwarenessClientStateSchema.safeParse(entry.state);
    if (!state.success || state.data.collaboration.kind !== "state") {
      this.rejectSocket(socket, "invalid-message", "Invalid awareness state", true, 1008);
      return;
    }
    this.acceptAwareness(socket, attachment, state.data.collaboration, {
      ...entry,
      state: state.data,
    });
  }

  private acceptAwareness(
    socket: WebSocket,
    attachment: SocketAttachment,
    input: CollaborationAwarenessInput,
    binaryEntry: CollaborationAwarenessProtocolEntry,
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
    const previous = attachment.awareness?.kind === "state" ? attachment.awareness : null;
    if (previous) {
      if (input.revision < previous.revision) {
        socket.serializeAttachment({
          ...attachment,
          awarenessWindowSecond: second,
          awarenessWindowCount: count,
          awarenessClientId: binaryEntry.clientId,
          awarenessClock: binaryEntry.clock,
        } satisfies SocketAttachment);
        return;
      }
      if (
        input.kind === "state" &&
        input.revision === previous.revision &&
        (JSON.stringify(input.surface) !== JSON.stringify(previous.surface) ||
          JSON.stringify(input.cursor) !== JSON.stringify(previous.cursor))
      ) {
        this.rejectSocket(
          socket,
          "invalid-message",
          "Awareness revision cannot change an existing view state",
          true,
          1008,
        );
        return;
      }
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
    const awarenessClientId = binaryEntry.clientId;
    const awarenessClock = binaryEntry.clock;
    const selection = binaryEntry.state?.selection;
    const awarenessState =
      event.kind === "state"
        ? collaborationAwarenessServerStateSchema.parse({
            collaboration: event,
            ...(selection === undefined ? {} : { selection }),
          })
        : undefined;
    socket.serializeAttachment({
      ...attachment,
      awarenessWindowSecond: second,
      awarenessWindowCount: count,
      awarenessClientId,
      awarenessClock,
      ...(event.kind === "state"
        ? { awareness: event, awarenessState }
        : { awareness: undefined, awarenessState: undefined }),
    } satisfies SocketAttachment);
    this.broadcastAwareness(
      {
        clientId: awarenessClientId,
        clock: awarenessClock,
        state: awarenessState ?? null,
      },
      socket,
    );
  }

  private acceptDocumentUpdate(
    socket: WebSocket,
    attachment: SocketAttachment,
    frame: ClientUpdateFrame,
  ): void {
    const handlerStartedAt = performance.now();
    if (!canPublishCollaborationUpdate(attachment.role)) {
      this.rejectSocket(
        socket,
        "read-only",
        "This collaboration room is read-only for your role",
        false,
        undefined,
        frame.updateId,
      );
      return;
    }
    const second = Math.floor(Date.now() / 1000);
    const socketCount =
      attachment.updateWindowSecond === second ? (attachment.updateWindowCount ?? 0) + 1 : 1;
    if (this.roomUpdateWindowSecond !== second) {
      this.roomUpdateWindowSecond = second;
      this.roomUpdateWindowCount = 0;
    }
    // Only updates within the socket's own limit spend the room budget, so
    // one flooding socket cannot rate-limit everyone else.
    if (
      socketCount > MAX_SOCKET_UPDATES_PER_SECOND ||
      this.roomUpdateWindowCount >= MAX_ROOM_UPDATES_PER_SECOND
    ) {
      this.rejectSocket(
        socket,
        "rate-limited",
        "Collaboration update rate limit exceeded",
        false,
        undefined,
        frame.updateId,
      );
      return;
    }
    this.roomUpdateWindowCount += 1;
    socket.serializeAttachment({
      ...attachment,
      updateWindowSecond: second,
      updateWindowCount: socketCount,
    } satisfies SocketAttachment);

    const validationDocument = this.getBinaryDocument();
    try {
      const before =
        this.binaryTeachingIntegrity ?? validateCollaborationTeachingDocument(validationDocument);
      this.binaryTeachingIntegrity = before;
      let teachingTouched = false;
      const observeTransaction = (transaction: Y.Transaction) => {
        if (collaborationTransactionTouchesTeaching(validationDocument, transaction)) {
          teachingTouched = true;
        }
      };
      validationDocument.on("afterTransaction", observeTransaction);
      try {
        Y.applyUpdate(validationDocument, frame.update, "server-teaching-validation");
      } finally {
        validationDocument.off("afterTransaction", observeTransaction);
      }
      // Runs on EVERY update, not only teaching ones. `schemaVersion` and the
      // nodes/texts/metadata maps are ordinary CRDT keys on the project root,
      // and nothing else guarded them: an `editor` could set schemaVersion to a
      // value that makes every participant's projection throw, persisted to
      // SQLite and rebroadcast, leaving the room permanently unusable for
      // everyone including its owner. Cheap — a few root reads.
      assertCollaborationProjectStructure(validationDocument);
      if (teachingTouched) {
        const after = validateCollaborationTeachingDocument(validationDocument);
        assertCollaborationTeachingTransition(before, after);
        if (Y.encodeStateAsUpdate(validationDocument).byteLength > MAX_YJS_SNAPSHOT_BYTES) {
          throw new Error("the room teaching state exceeds the snapshot limit");
        }
        this.binaryTeachingIntegrity = after;
      }
    } catch {
      this.resetBinaryDocument();
      this.rejectSocket(
        socket,
        "invalid-message",
        "Invalid document update",
        true,
        1008,
        frame.updateId,
      );
      return;
    }

    const event: CollaborationDocumentUpdateEvent = {
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
      clientId: frame.clientId,
      updateId: frame.updateId,
      update: encodeYjsUpdate(frame.update),
      roomId: attachment.roomId,
      actorId: attachment.userId,
      receivedAt: Date.now(),
    };
    try {
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
        // A retry fans out the stored update, whatever bytes it was resent with.
        const update = result.duplicate ? decodeYjsUpdate(result.event.update) : frame.update;
        this.broadcastDocument(result.streamId, event.updateId, update, socket);
      }
      const broadcastAt = performance.now();
      if (result.shouldCompact) this.scheduleSqliteCompaction();
      console.log("collaboration_websocket_update", {
        roomId: attachment.roomId,
        updateId: event.updateId,
        bytes: frame.update.byteLength,
        duplicate: result.duplicate,
        updateCount: result.updateCount,
        persistence: "do-sqlite",
        durableInsertMs: persistedAt - persistenceStartedAt,
        acknowledgeMs: acknowledgedAt - persistedAt,
        broadcastMs: broadcastAt - acknowledgedAt,
        totalMs: broadcastAt - handlerStartedAt,
      });
    } catch (error) {
      this.resetBinaryDocument();
      console.error("collaboration_websocket_update_failed", {
        roomId: attachment.roomId,
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

  private appendSqliteDocument(
    event: CollaborationDocumentUpdateEvent,
  ): StoredAppendRoomSqliteUpdateResult {
    const result = this.sqliteDocument.append(event);
    // Validation applied the submitted bytes to the shadow document, which is
    // right for a new update. A retry with an already-used update ID may carry
    // different bytes, so rematerialize from the authoritative SQLite state.
    if (result.duplicate) this.resetBinaryDocument();
    return result;
  }

  private async initializeTeachingDocument(
    input: z.infer<typeof teachingDocumentInitializationSchema>,
  ): Promise<Response> {
    const result = this.teachingInitializationTail.then(() =>
      this.performTeachingInitialization(input),
    );
    this.teachingInitializationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async performTeachingInitialization(
    input: z.infer<typeof teachingDocumentInitializationSchema>,
  ): Promise<Response> {
    const current = this.getBinaryDocument();
    const candidate = new Y.Doc();
    try {
      const beforeTeaching = validateCollaborationTeachingDocument(current);
      const beforeProject = projectCollaborationDocument(current).project;
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(current), "teaching-initialization-base");
      const initializationUpdate = decodeYjsSnapshot(input.update.update);
      let initializationTouchesTeaching = false;
      let initializationTouchesOnlyTeaching = true;
      const observeInitialization = (transaction: Y.Transaction) => {
        if (transaction.changed.size === 0) return;
        initializationTouchesTeaching ||= collaborationTransactionTouchesTeaching(
          candidate,
          transaction,
        );
        if (!collaborationTransactionTouchesOnlyTeaching(candidate, transaction)) {
          initializationTouchesOnlyTeaching = false;
        }
      };
      candidate.on("afterTransaction", observeInitialization);
      try {
        Y.applyUpdate(candidate, initializationUpdate, "teaching-initialization");
      } finally {
        candidate.off("afterTransaction", observeInitialization);
      }
      const afterProject = projectCollaborationDocument(candidate).project;
      const afterTeaching = validateCollaborationTeachingDocument(candidate);
      if (beforeTeaching.projection.initialized) {
        const isExactRetry =
          bytesEqual(Y.encodeStateVector(current), Y.encodeStateVector(candidate)) &&
          JSON.stringify(beforeProject) === JSON.stringify(afterProject) &&
          beforeTeaching.immutableFingerprint === afterTeaching.immutableFingerprint &&
          beforeTeaching.mutableFingerprint === afterTeaching.mutableFingerprint;
        return isExactRetry
          ? Response.json({ initialized: true })
          : Response.json(
              { error: "room teaching surfaces are already initialized" },
              { status: 409 },
            );
      }
      if (!initializationTouchesTeaching || !initializationTouchesOnlyTeaching) {
        return Response.json(
          { error: "teaching initialization must contain only teaching-surface state" },
          { status: 400 },
        );
      }
      if (JSON.stringify(beforeProject) !== JSON.stringify(afterProject)) {
        return Response.json(
          { error: "teaching initialization cannot change the shared workspace" },
          { status: 400 },
        );
      }
      const teaching = afterTeaching.projection;
      if (!teaching.initialized) {
        return Response.json({ error: "teaching initialization is incomplete" }, { status: 400 });
      }
      try {
        for (const manifest of teaching.slides.values()) {
          const assetKey = collaborationAssetKey(input.roomId, manifest.asset.id);
          const asset = await getCollaborationAsset(this.env.DB, input.roomId, manifest.asset.id);
          const object = await this.env.BUCKET.head(assetKey);
          if (
            !asset ||
            asset.mime_type !== manifest.asset.mimeType ||
            asset.size !== manifest.asset.size ||
            !object ||
            object.size !== manifest.asset.size ||
            object.customMetadata?.roomId !== input.roomId ||
            object.customMetadata?.sha256 !== manifest.asset.id ||
            object.httpMetadata?.contentType !== manifest.asset.mimeType
          ) {
            return Response.json(
              { error: "a teaching slide asset is unavailable" },
              { status: 409 },
            );
          }
        }
      } catch {
        return Response.json(
          { error: "teaching slide asset verification is temporarily unavailable" },
          { status: 503 },
        );
      }

      // Asset checks await external services, so workspace updates may have
      // landed since `candidate` was built. Rebase the teaching-only update on
      // the latest durable shadow immediately before the synchronous snapshot
      // replacement; this prevents the replacement cutoff from swallowing an
      // interleaved workspace update that is absent from the snapshot.
      const snapshot = this.rebaseTeachingInitialization(
        this.getBinaryDocument(),
        initializationUpdate,
        afterTeaching,
      );
      if (snapshot instanceof Response) return snapshot;
      try {
        const result = this.sqliteDocument.replaceSnapshot(
          snapshot,
          initializationUpdate.byteLength,
        );
        this.resetBinaryDocument();
        this.broadcastDocument(result.streamId, input.update.updateId, initializationUpdate);
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof CollaborationRoomSqliteQuotaError
                ? "the room teaching state exceeds the persistence quota"
                : "teaching initialization persistence is temporarily unavailable",
          },
          { status: error instanceof CollaborationRoomSqliteQuotaError ? 413 : 503 },
        );
      }
      return Response.json({ initialized: true });
    } catch (error) {
      // The document validators' messages are written for the owner. Anything
      // else (mostly Yjs failing to read the submitted bytes) gets a generic
      // answer rather than library or storage internals.
      const reason =
        error instanceof CollaborationTeachingError || error instanceof CollaborationProjectError
          ? error.message
          : "invalid teaching initialization";
      return Response.json({ error: reason }, { status: 400 });
    } finally {
      candidate.destroy();
    }
  }

  /**
   * The snapshot to store: `latest` plus the teaching initialization, which
   * must still leave the shared workspace alone and produce the teaching state
   * validated before the asset checks. A Response is the refusal to send.
   */
  private rebaseTeachingInitialization(
    latest: Y.Doc,
    initializationUpdate: Uint8Array,
    expected: CollaborationTeachingIntegrity,
  ): Uint8Array | Response {
    const finalCandidate = new Y.Doc();
    try {
      const latestProject = projectCollaborationDocument(latest).project;
      Y.applyUpdate(
        finalCandidate,
        Y.encodeStateAsUpdate(latest),
        "teaching-initialization-rebase",
      );
      Y.applyUpdate(finalCandidate, initializationUpdate, "teaching-initialization-final");
      const finalProject = projectCollaborationDocument(finalCandidate).project;
      const finalTeaching = validateCollaborationTeachingDocument(finalCandidate);
      if (
        JSON.stringify(latestProject) !== JSON.stringify(finalProject) ||
        !finalTeaching.projection.initialized ||
        finalTeaching.immutableFingerprint !== expected.immutableFingerprint ||
        finalTeaching.mutableFingerprint !== expected.mutableFingerprint
      ) {
        return Response.json(
          { error: "teaching initialization conflicted with the shared room" },
          { status: 409 },
        );
      }
      const snapshot = Y.encodeStateAsUpdate(finalCandidate);
      if (snapshot.byteLength > MAX_YJS_SNAPSHOT_BYTES) {
        return Response.json(
          { error: "the room teaching state exceeds the snapshot limit" },
          { status: 413 },
        );
      }
      return snapshot;
    } finally {
      finalCandidate.destroy();
    }
  }

  private getBinaryDocument(): Y.Doc {
    if (!this.binaryDocument) {
      this.binaryDocument = this.sqliteDocument.createDocument();
      this.binaryTeachingIntegrity = validateCollaborationTeachingDocument(this.binaryDocument);
    }
    return this.binaryDocument;
  }

  private resetBinaryDocument(): void {
    this.binaryDocument?.destroy();
    this.binaryDocument = null;
    this.binaryTeachingIntegrity = null;
  }

  private scheduleSqliteCompaction(): void {
    if (this.sqliteCompactionScheduled) return;
    this.sqliteCompactionScheduled = true;
    // Not awaited: a Durable Object stays alive for pending I/O on its own,
    // so this needs no waitUntil (which has no effect in one).
    void this.ctx.storage
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
      });
  }

  private applyControl(command: CollaborationRoomControlCommand): void {
    const { event } = command;
    if (event.kind === "room-closed") {
      this.broadcast({ type: "control.room", data: event });
      for (const socket of this.ctx.getWebSockets()) socket.close(4001, "room closed");
      return;
    }

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(socket);
      if (!attachment || attachment.roomId !== event.roomId) continue;
      const isTarget = event.targetUserId !== null && attachment.userId === event.targetUserId;
      // A removal closes the member's sockets whatever their role version: the
      // version is room-wide, so another member's later change may already
      // have raised it here, and a repeated removal carries the current one.
      if (isTarget && (command.targetRole === null || command.targetRole === undefined)) {
        sendMessage(socket, { type: "control.room", data: event });
        socket.close(4003, "room access revoked");
        continue;
      }
      // Each route POSTs /control on its own, so commands can arrive out of
      // order; an older role change must not restore a replaced role. (A
      // skipped one is corrected by the next access recheck.)
      if (event.roleVersion <= attachment.roleVersion) continue;
      if (isTarget && command.targetRole) {
        const next = this.withRole(attachment, command.targetRole, event.roleVersion);
        socket.serializeAttachment(next);
      } else {
        socket.serializeAttachment({ ...attachment, roleVersion: event.roleVersion });
      }
      sendMessage(socket, { type: "control.room", data: event });
    }
  }

  private broadcastDocument(
    streamId: string,
    updateId: string,
    update: Uint8Array,
    except?: WebSocket,
  ): void {
    const binary = exactArrayBuffer(
      encodeCollaborationServerUpdate({ streamId, updateId, update }),
    );
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except || !isOpen(socket)) continue;
      try {
        socket.send(binary);
      } catch {
        socket.close(1011, "broadcast failed");
      }
    }
  }

  private broadcastAwareness(entry: CollaborationAwarenessProtocolEntry, except?: WebSocket): void {
    const binary = exactArrayBuffer(
      encodeCollaborationAwarenessUpdate(encodeCollaborationAwarenessProtocolUpdate([entry])),
    );
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except || !isOpen(socket)) continue;
      try {
        socket.send(binary);
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
    if (attachment.awarenessClientId === undefined || attachment.awarenessClock === undefined)
      return;
    // y-protocols removes a state on a null update at the same clock. The
    // next clock belongs to the client, which republishes with it after a
    // reconnect; spending it here would make peers ignore that republish.
    this.broadcastAwareness(
      { clientId: attachment.awarenessClientId, clock: attachment.awarenessClock, state: null },
      socket,
    );
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
