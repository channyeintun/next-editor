import { DurableObject } from "cloudflare:workers";
import * as z from "zod";
import {
  collaborationIdSchema,
  collaborationRoleSchema,
  collaborationRoomControlCommandSchema,
  type CollaborationRoomControlCommand,
} from "../../../src/collaboration/protocol";
import {
  COLLABORATION_VOICE_PROTOCOL_VERSION,
  MAX_VOICE_MESSAGES_PER_SECOND,
  MAX_VOICE_ROSTER_SIZE,
  MAX_VOICE_SFU_REQUESTS_PER_SECOND,
  MAX_VOICE_SFU_REQUEST_BYTES,
  VOICE_CAPABILITY_HEADER,
  parseVoiceClientMessage,
  voiceCapabilitySchema,
  voiceServerMessageSchema,
  type VoiceParticipant,
  type VoiceRoomClosedReason,
  type VoiceServerMessage,
} from "../../../src/voice/protocol";
import {
  MAX_VOICE_TRACKS_PER_CONNECTION,
  VOICE_STUN_ICE_SERVERS,
  parseVoiceSfuOperation,
  RealtimeSfuUpstream,
  receivingTrackSchema,
  type ActivePublication,
  VoiceSfuRequestQueue,
} from "./realtimeSfuGateway";
import {
  closeTracks,
  createSession,
  noStoreJson,
  pushOrPullTracks,
  renegotiate,
  unauthorized,
  type VoiceSfuConnection,
} from "./voiceSfuOperations";
import { getCollaborationRoomAccess } from "../../db/collaborationQueries";
import type { Env } from "../env";
import { readBodyWithLimit } from "../httpBody";
import { sha256Hex } from "../../../src/shared/sha256Hex";
import { randomToken } from "./bytes";
import {
  ACCESS_REVALIDATION_INTERVAL_MS,
  ConnectionQuota,
  decodeHeaderJson,
  encodeHeaderJson,
  isCurrentRoom,
  isOpen,
  rateWindowCount,
} from "./socketSupport";

const VOICE_ORIGIN = "https://collaboration-voice.internal";
const VOICE_SESSION_HEADER = "X-Collaboration-Voice-Session";
const VOICE_CONNECTION_HEADER = "X-Voice-Connection";
const MAX_VOICE_CONNECTIONS_PER_USER_PER_MINUTE = 12;
/**
 * Concurrent voice sockets one account may hold. Seats are counted per user, so
 * this is not a seat limit — it only stops a single member from growing the
 * socket table (and the fan-out cost of every roster broadcast) without bound.
 * Generous enough for a laptop plus a phone, plus a lingering socket that has
 * not yet been reaped.
 */
const MAX_VOICE_SOCKETS_PER_USER = 4;
const MAX_PENDING_SFU_REQUESTS_PER_CONNECTION = 4;

// WebSocket close codes for the voice coordination socket.
const CLOSE_SUPERSEDED = 4000;
const CLOSE_ROOM_CLOSED = 4001;
const CLOSE_LEFT = 4002;
const CLOSE_REMOVED = 4003;
const CLOSE_PROTOCOL_ERROR = 1008;

const canonicalVoiceSessionSchema = z
  .object({
    roomId: collaborationIdSchema,
    userId: collaborationIdSchema,
    displayName: z.string().min(1).max(120),
    role: collaborationRoleSchema,
    roleVersion: z.number().int().positive(),
    collaborationSessionId: collaborationIdSchema,
    maxMembers: z.number().int().min(1).max(MAX_VOICE_ROSTER_SIZE),
  })
  .strict();

export type CanonicalVoiceSession = z.infer<typeof canonicalVoiceSessionSchema>;

const voiceSocketAttachmentSchema = canonicalVoiceSessionSchema
  .extend({
    voiceConnectionId: collaborationIdSchema,
    capabilityDigest: z.string().regex(/^[0-9a-f]{64}$/),
    muted: z.boolean(),
    muteRevision: z.number().int().nonnegative(),
    participantRevision: z.number().int().nonnegative(),
    // The latest room-wide revision observed by this attachment. Departure
    // revisions do not belong to a participant, so this separate watermark
    // prevents revision regression after hibernation.
    roomRevision: z.number().int().nonnegative().optional(),
    sfuSessionId: z.string().nullable(),
    publishedTrackName: z.string().nullable(),
    publishedMid: z.string().nullable(),
    receivingMids: z.array(z.string()).max(MAX_VOICE_TRACKS_PER_CONNECTION),
    receivingTracks: z.array(receivingTrackSchema).max(MAX_VOICE_TRACKS_PER_CONNECTION).default([]),
    accessCheckedAt: z.number().int().nonnegative().optional(),
    superseded: z.boolean().optional(),
    messageWindowSecond: z.number().int().nonnegative().optional(),
    messageWindowCount: z.number().int().nonnegative().optional(),
    sfuWindowSecond: z.number().int().nonnegative().optional(),
    sfuWindowCount: z.number().int().nonnegative().optional(),
  })
  .strict();

type VoiceSocketAttachment = z.infer<typeof voiceSocketAttachmentSchema>;

function attachmentFor(socket: WebSocket): VoiceSocketAttachment | null {
  const result = voiceSocketAttachmentSchema.safeParse(socket.deserializeAttachment());
  return result.success ? result.data : null;
}

function encodeVoiceMessage(message: VoiceServerMessage): string {
  return JSON.stringify(voiceServerMessageSchema.parse(message));
}

function sendVoiceMessage(socket: WebSocket, message: VoiceServerMessage): void {
  if (!isOpen(socket)) return;
  socket.send(encodeVoiceMessage(message));
}

export function isVoiceChatEnabled(env: Env): boolean {
  return (
    env.VOICE_CHAT_ENABLED === "true" &&
    Boolean(env.COLLABORATION_VOICE_ROOMS) &&
    Boolean(env.REALTIME_SFU_APP_ID) &&
    Boolean(env.REALTIME_SFU_APP_SECRET)
  );
}

function voiceRoomStub(env: Env, roomId: string): DurableObjectStub | null {
  if (!env.COLLABORATION_VOICE_ROOMS) return null;
  return env.COLLABORATION_VOICE_ROOMS.getByName(collaborationIdSchema.parse(roomId));
}

export async function forwardCollaborationVoiceWebSocket(
  env: Env,
  request: Request,
  session: CanonicalVoiceSession,
): Promise<Response> {
  const stub = voiceRoomStub(env, session.roomId);
  if (!stub) return Response.json({ error: "voice chat unavailable" }, { status: 503 });
  const headers = new Headers(request.headers);
  headers.set(VOICE_SESSION_HEADER, encodeHeaderJson(canonicalVoiceSessionSchema, session));
  return stub.fetch(new Request(request, { headers }));
}

export async function forwardCollaborationVoiceSfuRequest(
  env: Env,
  request: Request,
  input: {
    session: CanonicalVoiceSession;
    subpath: string;
    capability: string;
    voiceConnectionId: string;
  },
): Promise<Response> {
  const stub = voiceRoomStub(env, input.session.roomId);
  if (!stub) return Response.json({ error: "voice chat unavailable" }, { status: 503 });
  const headers = new Headers();
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  headers.set(VOICE_SESSION_HEADER, encodeHeaderJson(canonicalVoiceSessionSchema, input.session));
  headers.set(VOICE_CAPABILITY_HEADER, input.capability);
  headers.set(VOICE_CONNECTION_HEADER, input.voiceConnectionId);
  return stub.fetch(`${VOICE_ORIGIN}/sfu${input.subpath}`, {
    method: request.method,
    headers,
    body: request.body,
  });
}

// Mirrors notifyCollaborationRoomControl: routes push room-close/member
// removal/role changes so voice tears down promptly even while the document
// socket is independently reconnecting. Best-effort by design.
export async function notifyCollaborationVoiceRoomControl(
  env: Env,
  roomId: string,
  command: CollaborationRoomControlCommand,
): Promise<boolean> {
  const stub = voiceRoomStub(env, roomId);
  if (!stub) return false;
  const response = await stub.fetch(`${VOICE_ORIGIN}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collaborationRoomControlCommandSchema.parse(command)),
  });
  return response.ok;
}

// Ephemeral per-room voice coordinator. All durable knowledge lives in the
// hibernating WebSocket attachments so a wake-up can reconstruct the joined
// roster and the session/track/mid ownership registry without any storage
// migration (plan §5.2).
export class CollaborationVoiceRoomDurableObject extends DurableObject<Env> {
  private roomRevision: number | null = null;
  private readonly connectionQuota = new ConnectionQuota(MAX_VOICE_CONNECTIONS_PER_USER_PER_MINUTE);
  private readonly sfuRequestQueue = new VoiceSfuRequestQueue();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.acceptConnection(request);
    }
    if (request.method === "POST" && url.pathname === "/control") {
      const parsed = collaborationRoomControlCommandSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        return Response.json({ error: "invalid control command" }, { status: 400 });
      }
      if (!isCurrentRoom(this.ctx, parsed.data.event.roomId)) {
        return Response.json({ error: "invalid collaboration room" }, { status: 403 });
      }
      this.applyControl(parsed.data);
      return Response.json({ delivered: true });
    }
    if (url.pathname.startsWith("/sfu/")) {
      return this.handleSfuRequest(request, url);
    }
    return new Response("not found", { status: 404 });
  }

  private nextRevision(): number {
    if (this.roomRevision === null) {
      let restored = 0;
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = attachmentFor(socket);
        if (attachment) {
          restored = Math.max(
            restored,
            attachment.roomRevision ?? attachment.participantRevision,
            attachment.participantRevision,
          );
        }
      }
      this.roomRevision = restored;
    }
    this.roomRevision = Math.min(this.roomRevision + 1, Number.MAX_SAFE_INTEGER);
    // Persist the room-wide watermark on every live attachment. Without
    // this, a participant-left revision exists only in memory and can be
    // reused after the Durable Object hibernates.
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(socket);
      if (attachment) this.serializeAttachment(socket, attachment);
    }
    return this.roomRevision;
  }

  private serializeAttachment(
    socket: WebSocket,
    attachment: VoiceSocketAttachment,
  ): VoiceSocketAttachment {
    const next = {
      ...attachment,
      ...(this.roomRevision === null ? {} : { roomRevision: this.roomRevision }),
    };
    socket.serializeAttachment(next);
    return next;
  }

  private participantFrom(attachment: VoiceSocketAttachment): VoiceParticipant {
    return {
      voiceConnectionId: attachment.voiceConnectionId,
      collaborationSessionId: attachment.collaborationSessionId,
      userId: attachment.userId,
      displayName: attachment.displayName,
      role: attachment.role,
      muted: attachment.muted,
      publishedTrack:
        attachment.sfuSessionId !== null && attachment.publishedTrackName !== null
          ? {
              sessionId: attachment.sfuSessionId,
              trackName: attachment.publishedTrackName,
              location: "remote",
            }
          : null,
      revision: attachment.participantRevision,
    };
  }

  private activeSockets(): Array<{ socket: WebSocket; attachment: VoiceSocketAttachment }> {
    const active: Array<{ socket: WebSocket; attachment: VoiceSocketAttachment }> = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (!isOpen(socket)) continue;
      const attachment = attachmentFor(socket);
      if (!attachment || attachment.superseded) continue;
      active.push({ socket, attachment });
    }
    return active;
  }

  private activePublications(): ActivePublication[] {
    const publications: ActivePublication[] = [];
    for (const { attachment } of this.activeSockets()) {
      if (attachment.sfuSessionId !== null && attachment.publishedTrackName !== null) {
        publications.push({
          ownerVoiceConnectionId: attachment.voiceConnectionId,
          sessionId: attachment.sfuSessionId,
          trackName: attachment.publishedTrackName,
        });
      }
    }
    return publications;
  }

  // Validated and encoded once, then the same frame goes to every member.
  private broadcast(message: VoiceServerMessage, except?: WebSocket): void {
    const encoded = encodeVoiceMessage(message);
    for (const { socket } of this.activeSockets()) {
      if (socket === except || !isOpen(socket)) continue;
      try {
        socket.send(encoded);
      } catch {
        socket.close(1011, "broadcast failed");
      }
    }
  }

  // The socket whose change caused the upsert receives it too, so its own
  // roster row shows the server's mute and publishing state; the engine never
  // pulls audio for itself. Only a joining socket is excluded, because its
  // snapshot already carries the same revision.
  private broadcastUpsert(attachment: VoiceSocketAttachment, except?: WebSocket): void {
    this.broadcast(
      {
        type: "voice.participant-upsert",
        version: COLLABORATION_VOICE_PROTOCOL_VERSION,
        revision: attachment.participantRevision,
        participant: this.participantFrom(attachment),
      },
      except,
    );
  }

  private async acceptConnection(request: Request): Promise<Response> {
    const session = decodeHeaderJson(canonicalVoiceSessionSchema, request, VOICE_SESSION_HEADER);
    if (!session || !isCurrentRoom(this.ctx, session.roomId)) {
      return Response.json({ error: "invalid voice session" }, { status: 403 });
    }

    // Complete the only await before inspecting the active roster. Durable
    // Object events can interleave at awaits; scanning first would let two
    // simultaneous reconnects both miss and fail to supersede each other.
    const voiceConnectionId = crypto.randomUUID();
    const capability = randomToken();
    const capabilityDigest = await sha256Hex(capability);

    if (!this.connectionQuota.consume(session.userId)) {
      return Response.json(
        { error: "voice connection rate limit exceeded" },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    }

    // A second socket for the same (userId, collaborationSessionId) is a
    // reconnect generation and replaces the old one.
    //
    // Seats are counted by DISTINCT USER, not per socket. They used to be
    // per-socket keyed on (userId, collaborationSessionId), and
    // collaborationSessionId is a client-chosen query parameter validated only
    // for UUID shape — so one member could open `maxMembers` sockets with a
    // fresh UUID each time, fill the roster with phantom participants, and lock
    // every other member (including the room owner) out of voice with a 409.
    const superseded: Array<{ socket: WebSocket; attachment: VoiceSocketAttachment }> = [];
    const occupiedUserIds = new Set<string>();
    let ownConcurrentSockets = 0;
    for (const entry of this.activeSockets()) {
      if (entry.attachment.userId === session.userId) {
        if (entry.attachment.collaborationSessionId === session.collaborationSessionId) {
          superseded.push(entry);
        } else {
          // A genuine second tab/device for the same person. It shares their
          // seat, but is still bounded so sockets cannot grow without limit.
          ownConcurrentSockets += 1;
        }
        continue;
      }
      occupiedUserIds.add(entry.attachment.userId);
    }
    const capacity = Math.min(session.maxMembers, MAX_VOICE_ROSTER_SIZE);
    // The joining user is not in the set, so an existing seat of theirs never
    // costs a second one.
    if (occupiedUserIds.size >= capacity) {
      return Response.json({ error: "voice room is full" }, { status: 409 });
    }
    if (ownConcurrentSockets >= MAX_VOICE_SOCKETS_PER_USER) {
      return Response.json({ error: "too many concurrent voice connections" }, { status: 409 });
    }

    const attachment: VoiceSocketAttachment = {
      ...session,
      voiceConnectionId,
      capabilityDigest,
      muted: true,
      muteRevision: 0,
      // Allocate the visible participant revision only after every previous
      // generation has emitted its newer participant-left revision.
      participantRevision: 0,
      sfuSessionId: null,
      publishedTrackName: null,
      publishedMid: null,
      receivingMids: [],
      receivingTracks: [],
      accessCheckedAt: Date.now(),
    };

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [
      `conn:${voiceConnectionId}`,
      `user:${session.userId}`,
      `session:${session.collaborationSessionId}`,
    ]);
    this.serializeAttachment(server, attachment);

    // Retire the previous generation only after the replacement socket is
    // registered so the roster never shows a gap for the same person.
    for (const entry of superseded) {
      this.retireSocket(entry.socket, entry.attachment, CLOSE_SUPERSEDED, "superseded");
    }

    const readyAttachment = this.serializeAttachment(server, {
      ...attachment,
      participantRevision: this.nextRevision(),
    });

    sendVoiceMessage(server, {
      type: "voice.ready",
      version: COLLABORATION_VOICE_PROTOCOL_VERSION,
      voiceConnectionId,
      capability,
      limits: {
        maxParticipants: capacity,
        iceServers: [...VOICE_STUN_ICE_SERVERS],
      },
    });
    sendVoiceMessage(server, {
      type: "voice.snapshot",
      version: COLLABORATION_VOICE_PROTOCOL_VERSION,
      revision: readyAttachment.participantRevision,
      participants: this.activeSockets().map(({ attachment: entry }) =>
        this.participantFrom(entry),
      ),
    });
    this.broadcastUpsert(readyAttachment, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Marks the socket as no longer part of the roster, announces the
  // departure, schedules best-effort upstream cleanup, and closes it.
  private retireSocket(
    socket: WebSocket,
    attachment: VoiceSocketAttachment,
    closeCode: number,
    closeReason: string,
    notify?: { reason: VoiceRoomClosedReason },
  ): void {
    if (!attachment.superseded) {
      try {
        this.serializeAttachment(socket, { ...attachment, superseded: true });
      } catch {
        // The socket may already be closing; local state below still runs.
      }
      this.scheduleUpstreamRelease(attachment);
      this.broadcast(
        {
          type: "voice.participant-left",
          version: COLLABORATION_VOICE_PROTOCOL_VERSION,
          revision: this.nextRevision(),
          voiceConnectionId: attachment.voiceConnectionId,
        },
        socket,
      );
    }
    if (notify) {
      sendVoiceMessage(socket, {
        type: "voice.room-closed",
        version: COLLABORATION_VOICE_PROTOCOL_VERSION,
        reason: notify.reason,
      });
    }
    if (isOpen(socket)) socket.close(closeCode, closeReason);
  }

  // Cloudflare garbage-collects inactive tracks after ~30s; this close is
  // only an acceleration and must not block roster cleanup.
  private scheduleUpstreamRelease(attachment: VoiceSocketAttachment): void {
    const appId = this.env.REALTIME_SFU_APP_ID;
    const secret = this.env.REALTIME_SFU_APP_SECRET;
    if (!appId || !secret || attachment.sfuSessionId === null) return;
    const mids = [
      ...(attachment.publishedMid !== null ? [attachment.publishedMid] : []),
      ...attachment.receivingMids,
    ];
    if (mids.length === 0) return;
    new RealtimeSfuUpstream(appId, secret).releaseTracks(attachment.sfuSessionId, mids);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") return;
    const attachment = attachmentFor(socket);
    if (!attachment || attachment.superseded) {
      if (isOpen(socket)) socket.close(CLOSE_PROTOCOL_ERROR, "invalid voice session");
      return;
    }
    if (!isVoiceChatEnabled(this.env)) {
      this.retireSocket(socket, attachment, CLOSE_ROOM_CLOSED, "voice disabled", {
        reason: "feature-disabled",
      });
      return;
    }
    if (typeof message !== "string") {
      this.rejectSocket(socket, attachment, "invalid-message");
      return;
    }
    const parsed = parseVoiceClientMessage(message);
    if (!parsed) {
      this.rejectSocket(socket, attachment, "invalid-message");
      return;
    }

    const second = Math.floor(Date.now() / 1000);
    const count = rateWindowCount(
      attachment.messageWindowSecond,
      attachment.messageWindowCount,
      second,
    );
    if (count > MAX_VOICE_MESSAGES_PER_SECOND) {
      sendVoiceMessage(socket, {
        type: "voice.error",
        version: COLLABORATION_VOICE_PROTOCOL_VERSION,
        code: "rate-limited",
        recoverable: true,
        message: "Voice message rate limit exceeded",
      });
      return;
    }
    const counted: VoiceSocketAttachment = {
      ...attachment,
      messageWindowSecond: second,
      messageWindowCount: count,
    };
    this.serializeAttachment(socket, counted);

    const checked =
      parsed.type === "voice.leave" ? counted : await this.refreshAccess(socket, counted);
    if (!checked) return;

    if (parsed.type === "voice.ping") {
      sendVoiceMessage(socket, {
        type: "voice.pong",
        version: COLLABORATION_VOICE_PROTOCOL_VERSION,
        nonce: parsed.nonce,
      });
      return;
    }
    if (parsed.type === "voice.leave") {
      this.retireSocket(socket, checked, CLOSE_LEFT, "left voice");
      return;
    }
    // voice.mute-changed: monotonic client revisions (starting at 1) so
    // reordered frames cannot restore stale state (§6.3). Publishing state
    // still derives only from SFU gateway operations.
    if (parsed.revision <= checked.muteRevision) return;
    const updated: VoiceSocketAttachment = {
      ...checked,
      muted: parsed.muted,
      muteRevision: parsed.revision,
      participantRevision: this.nextRevision(),
    };
    this.serializeAttachment(socket, updated);
    this.broadcastUpsert(updated);
  }

  private async refreshAccess(
    socket: WebSocket,
    attachment: VoiceSocketAttachment,
  ): Promise<VoiceSocketAttachment | null> {
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
    const latest = attachmentFor(socket);
    if (
      !latest ||
      latest.superseded ||
      latest.voiceConnectionId !== attachment.voiceConnectionId ||
      !isOpen(socket)
    ) {
      return null;
    }
    // A newer control event won the await interleaving race; preserve it and
    // let the next heartbeat revalidate instead of applying an older read.
    if (latest.roleVersion !== attachment.roleVersion) return latest;
    if (!access) {
      this.retireSocket(socket, latest, CLOSE_REMOVED, "removed from room", {
        reason: "member-removed",
      });
      return null;
    }
    if (access.status !== "active") {
      this.retireSocket(socket, latest, CLOSE_ROOM_CLOSED, "room closed", {
        reason: "room-closed",
      });
      return null;
    }
    if (access.role_version < latest.roleVersion) return latest;
    const roleChanged = access.member_role !== latest.role;
    const updated = this.serializeAttachment(socket, {
      ...latest,
      role: access.member_role,
      roleVersion: access.role_version,
      accessCheckedAt: Date.now(),
      ...(roleChanged ? { participantRevision: this.nextRevision() } : {}),
    });
    if (roleChanged) this.broadcastUpsert(updated);
    return updated;
  }

  private rejectSocket(
    socket: WebSocket,
    attachment: VoiceSocketAttachment,
    code: "invalid-message",
  ): void {
    sendVoiceMessage(socket, {
      type: "voice.error",
      version: COLLABORATION_VOICE_PROTOCOL_VERSION,
      code,
      recoverable: false,
      message: "Invalid voice message",
    });
    this.retireSocket(socket, attachment, CLOSE_PROTOCOL_ERROR, "invalid voice message");
  }

  webSocketClose(socket: WebSocket): void {
    const attachment = attachmentFor(socket);
    if (attachment) this.retireSocket(socket, attachment, CLOSE_LEFT, "disconnected");
  }

  webSocketError(socket: WebSocket): void {
    const attachment = attachmentFor(socket);
    if (attachment) this.retireSocket(socket, attachment, CLOSE_LEFT, "disconnected");
  }

  private applyControl(command: CollaborationRoomControlCommand): void {
    const { event } = command;
    if (event.kind === "room-closed") {
      for (const { socket, attachment } of this.activeSockets()) {
        this.retireSocket(socket, attachment, CLOSE_ROOM_CLOSED, "room closed", {
          reason: "room-closed",
        });
      }
      return;
    }
    // membership-changed
    if (event.targetUserId === null) return;
    if (command.targetRole === undefined) return;
    const targetRole = command.targetRole;
    for (const { socket, attachment } of this.activeSockets()) {
      // D1 roleVersion is room-wide and monotonic; a delayed command must not
      // move a socket's version or role backwards.
      if (attachment.userId !== event.targetUserId) {
        if (event.roleVersion > attachment.roleVersion) {
          this.serializeAttachment(socket, { ...attachment, roleVersion: event.roleVersion });
        }
        continue;
      }
      // A removal retires the member's sockets whatever their role version:
      // another member's later change may already have raised it here, and a
      // repeated removal carries the current one. Nothing else revalidates a
      // member who stays silent.
      if (targetRole === null) {
        this.retireSocket(socket, attachment, CLOSE_REMOVED, "removed from room", {
          reason: "member-removed",
        });
        continue;
      }
      if (event.roleVersion <= attachment.roleVersion) continue;
      if (attachment.role !== targetRole) {
        const updated: VoiceSocketAttachment = {
          ...attachment,
          role: targetRole,
          roleVersion: event.roleVersion,
          participantRevision: this.nextRevision(),
        };
        this.serializeAttachment(socket, updated);
        this.broadcastUpsert(updated);
      } else {
        this.serializeAttachment(socket, { ...attachment, roleVersion: event.roleVersion });
      }
    }
  }

  private async handleSfuRequest(request: Request, url: URL): Promise<Response> {
    const startedAt = Date.now();
    if (!isVoiceChatEnabled(this.env)) {
      return noStoreJson({ error: "voice chat unavailable" }, 503);
    }
    const appId = this.env.REALTIME_SFU_APP_ID;
    const secret = this.env.REALTIME_SFU_APP_SECRET;
    if (!appId || !secret) return noStoreJson({ error: "voice chat unavailable" }, 503);
    const sfuUpstream = new RealtimeSfuUpstream(appId, secret);

    const session = decodeHeaderJson(canonicalVoiceSessionSchema, request, VOICE_SESSION_HEADER);
    const capability = voiceCapabilitySchema.safeParse(
      request.headers.get(VOICE_CAPABILITY_HEADER),
    );
    const voiceConnectionId = collaborationIdSchema.safeParse(
      request.headers.get(VOICE_CONNECTION_HEADER),
    );
    if (
      !session ||
      !isCurrentRoom(this.ctx, session.roomId) ||
      !capability.success ||
      !voiceConnectionId.success
    ) {
      return unauthorized();
    }

    const capabilityDigest = await sha256Hex(capability.data);
    const preflightSocket = this.ctx.getWebSockets(`conn:${voiceConnectionId.data}`).find(isOpen);
    const preflightAttachment = preflightSocket ? attachmentFor(preflightSocket) : null;
    if (
      !preflightAttachment ||
      preflightAttachment.superseded ||
      preflightAttachment.userId !== session.userId ||
      preflightAttachment.roomId !== session.roomId ||
      preflightAttachment.collaborationSessionId !== session.collaborationSessionId ||
      preflightAttachment.capabilityDigest !== capabilityDigest
    ) {
      return unauthorized();
    }
    // A valid participant must not be able to retain an unbounded chain of
    // request bodies while an upstream call is slow. PartyTracks retries 429
    // responses, so a small bound preserves recovery without risking the
    // Durable Object's memory ceiling.
    if (
      this.sfuRequestQueue.pendingCount(voiceConnectionId.data) >=
      MAX_PENDING_SFU_REQUESTS_PER_CONNECTION
    ) {
      return noStoreJson({ error: "rate-limited" }, 429);
    }
    return this.sfuRequestQueue.run(voiceConnectionId.data, async () => {
      // The capability proves the caller owns a live socket in this room; the
      // Worker has already re-authenticated the application session and D1
      // membership on this same request.
      const sockets = this.ctx.getWebSockets(`conn:${voiceConnectionId.data}`);
      const socket = sockets.find(isOpen);
      const attachment = socket ? attachmentFor(socket) : null;
      if (
        !socket ||
        !attachment ||
        attachment.superseded ||
        attachment.userId !== session.userId ||
        attachment.roomId !== session.roomId ||
        attachment.collaborationSessionId !== session.collaborationSessionId ||
        attachment.capabilityDigest !== capabilityDigest
      ) {
        return unauthorized();
      }

      if (session.roleVersion < attachment.roleVersion) {
        return unauthorized();
      }
      let authorizedAttachment = attachment;
      if (session.roleVersion > attachment.roleVersion || session.role !== attachment.role) {
        const roleChanged = session.role !== attachment.role;
        authorizedAttachment = this.serializeAttachment(socket, {
          ...attachment,
          role: session.role,
          roleVersion: session.roleVersion,
          ...(roleChanged ? { participantRevision: this.nextRevision() } : {}),
        });
        if (roleChanged) this.broadcastUpsert(authorizedAttachment);
      }

      const second = Math.floor(Date.now() / 1000);
      const count = rateWindowCount(
        authorizedAttachment.sfuWindowSecond,
        authorizedAttachment.sfuWindowCount,
        second,
      );
      if (count > MAX_VOICE_SFU_REQUESTS_PER_SECOND) {
        return noStoreJson({ error: "rate-limited" }, 429);
      }
      let current: VoiceSocketAttachment = {
        ...authorizedAttachment,
        sfuWindowSecond: second,
        sfuWindowCount: count,
      };
      current = this.serializeAttachment(socket, current);

      const subpath = url.pathname.slice("/sfu".length);
      const operation = parseVoiceSfuOperation(request.method, subpath);
      if (!operation) return noStoreJson({ error: "unsupported operation" }, 403);

      // Bounded while streaming, not after: `await request.text()` would
      // buffer a chunked request whole before any length check and could
      // exhaust this Durable Object's memory, killing voice for every
      // participant in the room.
      const raw = await readBodyWithLimit(request, MAX_VOICE_SFU_REQUEST_BYTES);
      if (raw.status === "too-large") {
        return noStoreJson({ error: "payload too large" }, 413);
      }
      if (raw.status === "read-error") {
        return noStoreJson({ error: "invalid request" }, 400);
      }
      let body: unknown = null;
      if (raw.text.length > 0) {
        try {
          body = JSON.parse(raw.text) as unknown;
        } catch {
          return noStoreJson({ error: "invalid request" }, 400);
        }
      }

      const readLiveAttachment = (): VoiceSocketAttachment | null => {
        if (!isOpen(socket)) return null;
        const latest = attachmentFor(socket);
        if (
          !latest ||
          latest.superseded ||
          latest.capabilityDigest !== capabilityDigest ||
          latest.userId !== session.userId ||
          latest.roomId !== session.roomId ||
          latest.collaborationSessionId !== session.collaborationSessionId
        ) {
          return null;
        }
        return latest;
      };

      const refreshed = readLiveAttachment();
      if (!refreshed) return unauthorized();
      current = refreshed;

      const connection: VoiceSfuConnection = {
        upstream: sfuUpstream,
        subpath,
        method: request.method,
        current: () => current,
        readLive: readLiveAttachment,
        persist: (update) => {
          const latest = readLiveAttachment();
          if (!latest) return null;
          current = this.serializeAttachment(socket, { ...latest, ...update(latest) });
          return current;
        },
        activePublications: () => this.activePublications(),
        nextRevision: () => this.nextRevision(),
        broadcastUpsert: () => this.broadcastUpsert(current),
        logOutcome: (kind, status) => {
          console.log("collaboration_voice_sfu", {
            roomId: current.roomId,
            kind,
            status,
            durationMs: Date.now() - startedAt,
          });
        },
      };

      switch (operation.kind) {
        case "create-session":
          return createSession(connection);
        case "push-tracks":
          return pushOrPullTracks(connection, operation.sessionId, body);
        case "renegotiate":
          return renegotiate(connection, operation.sessionId, body);
        default:
          // close-tracks: parseVoiceSfuOperation never yields pull-tracks,
          // which tracks/new carries and pushOrPullTracks tells apart.
          return closeTracks(connection, operation.sessionId, body);
      }
    });
  }
}
