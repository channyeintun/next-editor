import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
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
  voiceSfuSessionIdSchema,
  voiceSfuTrackNameSchema,
  voiceServerMessageSchema,
  type VoiceParticipant,
  type VoiceRoomClosedReason,
  type VoiceServerMessage,
} from "../../../src/collaboration/voiceProtocol";
import {
  VOICE_STUN_ICE_SERVERS,
  authorizeCloseTracks,
  authorizeCreateSession,
  authorizePullTracks,
  authorizePushTracks,
  authorizeSessionScoped,
  buildUpstreamSfuUrl,
  closeTracksRequestSchema,
  parseVoiceSfuOperation,
  pullTracksRequestSchema,
  pushTracksRequestSchema,
  renegotiateRequestSchema,
  sanitizeTracksResponse,
  upstreamNewSessionResponseSchema,
  upstreamRenegotiateResponseSchema,
  upstreamTracksResponseSchema,
  type ActivePublication,
  type ReceivingTrack,
  type VoiceConnectionSfuState,
  VoiceSfuRequestQueue,
} from "./realtimeSfuGateway";
import { getCollaborationRoomAccess } from "../../db/collaborationQueries";
import type { Env } from "../env";

const VOICE_ORIGIN = "https://collaboration-voice.internal";
export const VOICE_SESSION_HEADER = "X-Collaboration-Voice-Session";
export { VOICE_CAPABILITY_HEADER };
export const VOICE_CONNECTION_HEADER = "X-Voice-Connection";
const MAX_VOICE_CONNECTIONS_PER_USER_PER_MINUTE = 12;
const MAX_PENDING_SFU_REQUESTS_PER_CONNECTION = 4;
const ACCESS_REVALIDATION_INTERVAL_MS = 5_000;
const UPSTREAM_TIMEOUT_MS = 15_000;

// WebSocket close codes for the voice coordination socket.
const CLOSE_SUPERSEDED = 4000;
const CLOSE_ROOM_CLOSED = 4001;
const CLOSE_LEFT = 4002;
const CLOSE_REMOVED = 4003;
const CLOSE_PROTOCOL_ERROR = 1008;

export const canonicalVoiceSessionSchema = z
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
    receivingMids: z.array(z.string()).max(64),
    receivingTracks: z
      .array(
        z
          .object({
            sessionId: voiceSfuSessionIdSchema,
            trackName: voiceSfuTrackNameSchema,
            mid: z.string().regex(/^[!-~]{1,16}$/),
          })
          .strict(),
      )
      .max(64)
      .default([]),
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

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === 1;
}

function encodeCanonicalVoiceSession(session: CanonicalVoiceSession): string {
  return encodeURIComponent(JSON.stringify(canonicalVoiceSessionSchema.parse(session)));
}

function decodeCanonicalVoiceSession(request: Request): CanonicalVoiceSession | null {
  const encoded = request.headers.get(VOICE_SESSION_HEADER);
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded)) as unknown;
    const result = canonicalVoiceSessionSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function sendVoiceMessage(socket: WebSocket, message: VoiceServerMessage): void {
  if (!isOpen(socket)) return;
  socket.send(JSON.stringify(voiceServerMessageSchema.parse(message)));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  headers.set(VOICE_SESSION_HEADER, encodeCanonicalVoiceSession(session));
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
  headers.set(VOICE_SESSION_HEADER, encodeCanonicalVoiceSession(input.session));
  headers.set(VOICE_CAPABILITY_HEADER, input.capability);
  headers.set(VOICE_CONNECTION_HEADER, input.voiceConnectionId);
  return stub.fetch(`${VOICE_ORIGIN}/sfu${input.subpath}`, {
    method: request.method,
    headers,
    body: request.method === "GET" ? null : request.body,
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

function noStoreJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Ephemeral per-room voice coordinator. All durable knowledge lives in the
// hibernating WebSocket attachments so a wake-up can reconstruct the joined
// roster and the session/track/mid ownership registry without any storage
// migration (plan §5.2).
export class CollaborationVoiceRoomDurableObject extends DurableObject<Env> {
  private roomRevision: number | null = null;
  private connectionWindowMinute = 0;
  private readonly connectionWindowCounts = new Map<string, number>();
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
      if (!this.isCurrentRoom(parsed.data.event.roomId)) {
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

  private isCurrentRoom(roomId: string): boolean {
    const objectName = this.ctx.id.name;
    return !objectName || objectName === roomId;
  }

  private consumeConnectionQuota(userId: string): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.connectionWindowMinute !== minute) {
      this.connectionWindowMinute = minute;
      this.connectionWindowCounts.clear();
    }
    const count = (this.connectionWindowCounts.get(userId) ?? 0) + 1;
    this.connectionWindowCounts.set(userId, count);
    return count <= MAX_VOICE_CONNECTIONS_PER_USER_PER_MINUTE;
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

  private broadcast(message: VoiceServerMessage, except?: WebSocket): void {
    for (const { socket } of this.activeSockets()) {
      if (socket === except) continue;
      sendVoiceMessage(socket, message);
    }
  }

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
    const session = decodeCanonicalVoiceSession(request);
    if (!session || !this.isCurrentRoom(session.roomId)) {
      return Response.json({ error: "invalid voice session" }, { status: 403 });
    }

    // Complete the only await before inspecting the active roster. Durable
    // Object events can interleave at awaits; scanning first would let two
    // simultaneous reconnects both miss and fail to supersede each other.
    const voiceConnectionId = crypto.randomUUID();
    const capabilityBytes = new Uint8Array(32);
    crypto.getRandomValues(capabilityBytes);
    const capability = encodeBase64Url(capabilityBytes);
    const capabilityDigest = await sha256Hex(capability);

    if (!this.consumeConnectionQuota(session.userId)) {
      return Response.json(
        { error: "voice connection rate limit exceeded" },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    }

    // A second socket for the same (userId, collaborationSessionId) is a
    // reconnect generation; anything else counts toward the room cap.
    const superseded: Array<{ socket: WebSocket; attachment: VoiceSocketAttachment }> = [];
    let occupied = 0;
    for (const entry of this.activeSockets()) {
      if (
        entry.attachment.userId === session.userId &&
        entry.attachment.collaborationSessionId === session.collaborationSessionId
      ) {
        superseded.push(entry);
      } else {
        occupied += 1;
      }
    }
    const capacity = Math.min(session.maxMembers, MAX_VOICE_ROSTER_SIZE);
    if (occupied >= capacity) {
      return Response.json({ error: "voice room is full" }, { status: 409 });
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
    const url = buildUpstreamSfuUrl(appId, `/sessions/${attachment.sfuSessionId}/tracks/close`);
    this.ctx.waitUntil(
      fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tracks: mids.map((mid) => ({ mid })), force: true }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      }).then(
        () => undefined,
        () => undefined,
      ),
    );
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
    const count =
      attachment.messageWindowSecond === second ? (attachment.messageWindowCount ?? 0) + 1 : 1;
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
    this.broadcastUpsert(updated, socket);
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
    if (roleChanged) this.broadcastUpsert(updated, socket);
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
      // D1 roleVersion is room-wide and monotonic. Ignore delayed control
      // deliveries so an old removal cannot close a member who rejoined at a
      // newer version.
      if (event.roleVersion <= attachment.roleVersion) continue;
      if (attachment.userId !== event.targetUserId) {
        this.serializeAttachment(socket, { ...attachment, roleVersion: event.roleVersion });
        continue;
      }
      if (targetRole === null) {
        this.retireSocket(socket, attachment, CLOSE_REMOVED, "removed from room", {
          reason: "member-removed",
        });
        continue;
      }
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

    const session = decodeCanonicalVoiceSession(request);
    const capability = voiceCapabilitySchema.safeParse(
      request.headers.get(VOICE_CAPABILITY_HEADER),
    );
    const voiceConnectionId = collaborationIdSchema.safeParse(
      request.headers.get(VOICE_CONNECTION_HEADER),
    );
    if (
      !session ||
      !this.isCurrentRoom(session.roomId) ||
      !capability.success ||
      !voiceConnectionId.success
    ) {
      return noStoreJson({ error: "unauthorized" }, 403);
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
      return noStoreJson({ error: "unauthorized" }, 403);
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
        return noStoreJson({ error: "unauthorized" }, 403);
      }

      if (session.roleVersion < attachment.roleVersion) {
        return noStoreJson({ error: "unauthorized" }, 403);
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
        if (roleChanged) this.broadcastUpsert(authorizedAttachment, socket);
      }

      const second = Math.floor(Date.now() / 1000);
      const count =
        authorizedAttachment.sfuWindowSecond === second
          ? (authorizedAttachment.sfuWindowCount ?? 0) + 1
          : 1;
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

      if (operation.kind === "ice-servers") {
        return noStoreJson({ iceServers: [...VOICE_STUN_ICE_SERVERS] });
      }

      let body: unknown = null;
      if (request.method !== "GET") {
        const raw = await request.text();
        if (raw.length > MAX_VOICE_SFU_REQUEST_BYTES) {
          return noStoreJson({ error: "payload too large" }, 413);
        }
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw) as unknown;
          } catch {
            return noStoreJson({ error: "invalid request" }, 400);
          }
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
      if (!refreshed) return noStoreJson({ error: "unauthorized" }, 403);
      current = refreshed;

      const stateFor = (attachment: VoiceSocketAttachment): VoiceConnectionSfuState => ({
        sfuSessionId: attachment.sfuSessionId,
        publishedTrackName: attachment.publishedTrackName,
        publishedMid: attachment.publishedMid,
        receivingMids: attachment.receivingMids,
        receivingTracks: attachment.receivingTracks,
      });
      let state = stateFor(current);

      const persist = (
        build: (latest: VoiceSocketAttachment) => VoiceSocketAttachment,
      ): VoiceSocketAttachment | null => {
        const latest = readLiveAttachment();
        if (!latest) return null;
        current = this.serializeAttachment(socket, build(latest));
        state = stateFor(current);
        return current;
      };

      const logOutcome = (kind: string, status: number) => {
        console.log("collaboration_voice_sfu", {
          roomId: current.roomId,
          kind,
          status,
          durationMs: Date.now() - startedAt,
        });
      };

      const upstreamAt = async (
        targetSubpath: string,
        method: string,
        upstreamBody: unknown,
      ): Promise<Response | null> => {
        try {
          return await fetch(buildUpstreamSfuUrl(appId, targetSubpath), {
            method,
            headers: {
              Authorization: `Bearer ${secret}`,
              "Content-Type": "application/json",
            },
            body: upstreamBody === null ? null : JSON.stringify(upstreamBody),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
        } catch {
          return null;
        }
      };
      const upstream = (upstreamBody: unknown) => upstreamAt(subpath, request.method, upstreamBody);

      const closeSfuMids = async (
        sfuSessionId: string,
        requestedMids: readonly string[],
      ): Promise<boolean> => {
        const mids = new Set(requestedMids);
        if (mids.size === 0) return true;
        const response = await upstreamAt(`/sessions/${sfuSessionId}/tracks/close`, "PUT", {
          tracks: [...mids].map((mid) => ({ mid })),
          force: true,
        });
        // Closing an already-collected session/track is idempotent cleanup.
        if (response?.status === 404) return true;
        if (!response?.ok) return false;
        const parsed = upstreamTracksResponseSchema.safeParse(
          await response
            .clone()
            .json()
            .catch(() => ({})),
        );
        if (!parsed.success || parsed.data.errorCode !== undefined) return false;
        const closedMids = new Set(
          parsed.data.tracks
            .filter((track) => track.mid != null && track.errorCode === undefined)
            .map((track) => track.mid as string),
        );
        return [...mids].every((mid) => closedMids.has(mid));
      };

      const closeRegisteredTracks = (
        attachment: VoiceSocketAttachment,
        additionalMids: readonly string[] = [],
      ): Promise<boolean> => {
        if (attachment.sfuSessionId === null) return Promise.resolve(true);
        return closeSfuMids(attachment.sfuSessionId, [
          ...(attachment.publishedMid === null ? [] : [attachment.publishedMid]),
          ...attachment.receivingMids,
          ...additionalMids,
        ]);
      };

      const upstreamFailure = (kind: string, status?: number) => {
        // Upstream bodies are never logged or forwarded (§6.3).
        console.error("collaboration_voice_sfu_upstream_failed", {
          roomId: current.roomId,
          kind,
          upstreamStatus: status ?? null,
        });
        return noStoreJson({ error: "sfu-unavailable" }, 502);
      };

      if (operation.kind === "create-session") {
        const authorized = authorizeCreateSession(state);
        if (!authorized.ok) {
          logOutcome(operation.kind, authorized.status);
          return noStoreJson({ error: authorized.error }, authorized.status);
        }
        // PartyTracks automatically creates a replacement PeerConnection/SFU
        // session after terminal media failure. Close every registered track
        // first, then clear the old ownership registry before creating the new
        // session. This preserves one active session without breaking library
        // recovery.
        if (current.sfuSessionId !== null) {
          const hadPublication = current.publishedTrackName !== null;
          if (!(await closeRegisteredTracks(current))) {
            return upstreamFailure("replace-session");
          }
          const cleared = persist((latest) => ({
            ...latest,
            sfuSessionId: null,
            publishedTrackName: null,
            publishedMid: null,
            receivingMids: [],
            receivingTracks: [],
            ...(hadPublication ? { participantRevision: this.nextRevision() } : {}),
          }));
          if (!cleared) return noStoreJson({ error: "unauthorized" }, 403);
          if (hadPublication) this.broadcastUpsert(cleared, socket);
        }
        const response = await upstream(null);
        if (!response || !response.ok) {
          return upstreamFailure(operation.kind, response?.status);
        }
        const parsed = upstreamNewSessionResponseSchema.safeParse(
          await response.json().catch(() => null),
        );
        if (!parsed.success) return upstreamFailure(operation.kind, response.status);
        const next = persist((latest) => ({ ...latest, sfuSessionId: parsed.data.sessionId }));
        if (!next) return noStoreJson({ error: "unauthorized" }, 403);
        logOutcome(operation.kind, 200);
        return noStoreJson({ sessionId: parsed.data.sessionId });
      }

      if (operation.kind === "push-tracks") {
        // tracks/new carries either a push (with an SDP offer) or a pull
        // (remote track list); disambiguate by shape, then authorize.
        const push = pushTracksRequestSchema.safeParse(body);
        const pull = push.success ? null : pullTracksRequestSchema.safeParse(body);
        if (push.success) {
          const requested = push.data.tracks[0];
          const authorized = authorizePushTracks(state, operation.sessionId, push.data);
          if (!authorized.ok) {
            logOutcome("push-tracks", authorized.status);
            return noStoreJson({ error: authorized.error }, authorized.status);
          }
          // A PartyTracks network retry can repeat tracks/new after Cloudflare
          // accepted the first request but before the browser received its
          // response. Replace that same stable track atomically within this
          // connection's queue; a differently named second publication was
          // rejected above.
          if (current.publishedTrackName === requested.trackName && current.publishedMid !== null) {
            const replacedMid = current.publishedMid;
            if (!(await closeSfuMids(operation.sessionId, [replacedMid]))) {
              return upstreamFailure("replace-published-track");
            }
            const cleared = persist((latest) => ({
              ...latest,
              publishedTrackName: null,
              publishedMid: null,
              participantRevision: this.nextRevision(),
            }));
            if (!cleared) return noStoreJson({ error: "unauthorized" }, 403);
            this.broadcastUpsert(cleared, socket);
          }
          const response = await upstream(push.data);
          if (!response || !response.ok) return upstreamFailure("push-tracks", response?.status);
          const parsed = upstreamTracksResponseSchema.safeParse(
            await response.json().catch(() => null),
          );
          if (!parsed.success) return upstreamFailure("push-tracks", response.status);
          if (parsed.data.errorCode === undefined && parsed.data.sessionDescription === undefined) {
            return upstreamFailure("push-tracks", response.status);
          }
          const accepted =
            parsed.data.errorCode === undefined
              ? parsed.data.tracks.find(
                  (track) => track.errorCode === undefined && track.mid === requested.mid,
                )
              : undefined;
          if (
            parsed.data.errorCode === undefined &&
            (parsed.data.tracks.length !== 1 ||
              (parsed.data.tracks[0]?.errorCode === undefined && !accepted))
          ) {
            await closeSfuMids(
              operation.sessionId,
              parsed.data.tracks.flatMap((track) =>
                track.errorCode === undefined && track.mid != null ? [track.mid] : [],
              ),
            );
            return upstreamFailure("push-tracks", response.status);
          }
          if (accepted) {
            const acceptedMid = accepted.mid as string;
            const next = persist((latest) => ({
              ...latest,
              publishedTrackName: requested.trackName,
              publishedMid: acceptedMid,
              participantRevision: this.nextRevision(),
            }));
            if (!next) {
              await closeSfuMids(operation.sessionId, [acceptedMid]);
              return noStoreJson({ error: "unauthorized" }, 403);
            }
            this.broadcastUpsert(next, socket);
          }
          logOutcome("push-tracks", 200);
          return noStoreJson(sanitizeTracksResponse(parsed.data));
        }
        if (pull && pull.success) {
          const authorized = authorizePullTracks(
            state,
            operation.sessionId,
            pull.data,
            current.voiceConnectionId,
            this.activePublications(),
          );
          if (!authorized.ok) {
            logOutcome("pull-tracks", authorized.status);
            return noStoreJson({ error: authorized.error }, authorized.status);
          }
          // Retry replacement mirrors the publication path: close only the
          // registered mids for requested stable remote track identities,
          // update the ownership registry, then forward the replacement pull.
          const requestedKeys = new Set(
            pull.data.tracks.map((track) => `${track.sessionId}\u0000${track.trackName}`),
          );
          const replacedTracks = current.receivingTracks.filter((track) =>
            requestedKeys.has(`${track.sessionId}\u0000${track.trackName}`),
          );
          if (replacedTracks.length > 0) {
            const replacedMids = new Set(replacedTracks.map((track) => track.mid));
            if (!(await closeSfuMids(operation.sessionId, [...replacedMids]))) {
              return upstreamFailure("replace-pulled-tracks");
            }
            const cleared = persist((latest) => ({
              ...latest,
              receivingMids: latest.receivingMids.filter((mid) => !replacedMids.has(mid)),
              receivingTracks: latest.receivingTracks.filter(
                (track) => !replacedMids.has(track.mid),
              ),
            }));
            if (!cleared) return noStoreJson({ error: "unauthorized" }, 403);
          }
          const response = await upstream(pull.data);
          if (!response || !response.ok) return upstreamFailure("pull-tracks", response?.status);
          const parsed = upstreamTracksResponseSchema.safeParse(
            await response.json().catch(() => null),
          );
          if (!parsed.success) return upstreamFailure("pull-tracks", response.status);
          const additions: ReceivingTrack[] = [];
          const successfulTracks = parsed.data.errorCode === undefined ? parsed.data.tracks : [];
          const acceptedKeys = new Set<string>();
          let malformedSuccess = false;
          for (const track of successfulTracks) {
            if (track.errorCode !== undefined) continue;
            if (
              track.mid == null ||
              track.sessionId === undefined ||
              track.trackName === undefined
            ) {
              malformedSuccess = true;
              continue;
            }
            const key = `${track.sessionId}\u0000${track.trackName}`;
            const requested = pull.data.tracks.find(
              (candidate) =>
                candidate.sessionId === track.sessionId && candidate.trackName === track.trackName,
            );
            if (!requested || acceptedKeys.has(key)) {
              malformedSuccess = true;
              continue;
            }
            acceptedKeys.add(key);
            additions.push({
              sessionId: requested.sessionId,
              trackName: requested.trackName,
              mid: track.mid,
            });
          }
          if (
            parsed.data.errorCode === undefined &&
            (malformedSuccess ||
              parsed.data.tracks.length === 0 ||
              (parsed.data.requiresImmediateRenegotiation === true &&
                parsed.data.sessionDescription === undefined))
          ) {
            await closeSfuMids(
              operation.sessionId,
              successfulTracks.flatMap((track) =>
                track.errorCode === undefined && track.mid != null ? [track.mid] : [],
              ),
            );
            return upstreamFailure("pull-tracks", response.status);
          }
          if (additions.length > 0) {
            const next = persist((latest) => {
              const byTrack = new Map(
                latest.receivingTracks.map((track) => [
                  `${track.sessionId}\u0000${track.trackName}`,
                  track,
                ]),
              );
              for (const addition of additions) {
                byTrack.set(`${addition.sessionId}\u0000${addition.trackName}`, addition);
              }
              const receivingTracks = [...byTrack.values()].slice(0, 64);
              // Preserve legacy owned mids that predate receivingTracks; they
              // must remain closable and count toward the per-session limit.
              const receivingMids = [
                ...new Set([...latest.receivingMids, ...additions.map((addition) => addition.mid)]),
              ].slice(0, 64);
              return {
                ...latest,
                receivingMids,
                receivingTracks,
              };
            });
            if (!next) {
              await closeSfuMids(
                operation.sessionId,
                additions.map((track) => track.mid),
              );
              return noStoreJson({ error: "unauthorized" }, 403);
            }
          }
          logOutcome("pull-tracks", 200);
          return noStoreJson(sanitizeTracksResponse(parsed.data));
        }
        logOutcome("push-tracks", 400);
        return noStoreJson({ error: "invalid request" }, 400);
      }

      if (operation.kind === "renegotiate") {
        const parsedBody = renegotiateRequestSchema.safeParse(body);
        if (!parsedBody.success) return noStoreJson({ error: "invalid request" }, 400);
        const authorized = authorizeSessionScoped(state, operation.sessionId);
        if (!authorized.ok) {
          logOutcome(operation.kind, authorized.status);
          return noStoreJson({ error: authorized.error }, authorized.status);
        }
        const response = await upstream(parsedBody.data);
        if (!response || !response.ok) return upstreamFailure(operation.kind, response?.status);
        const parsed = upstreamRenegotiateResponseSchema.safeParse(
          await response.json().catch(() => ({})),
        );
        if (!parsed.success) return upstreamFailure(operation.kind, response.status);
        if (!readLiveAttachment()) return noStoreJson({ error: "unauthorized" }, 403);
        logOutcome(operation.kind, 200);
        return noStoreJson(parsed.data);
      }

      // close-tracks
      const parsedBody = closeTracksRequestSchema.safeParse(body);
      if (!parsedBody.success) return noStoreJson({ error: "invalid request" }, 400);
      const authorized = authorizeCloseTracks(state, operation.sessionId, parsedBody.data);
      if (!authorized.ok) {
        logOutcome(operation.kind, authorized.status);
        return noStoreJson({ error: authorized.error }, authorized.status);
      }
      const response = await upstream(parsedBody.data);
      if (!response || !response.ok) return upstreamFailure(operation.kind, response?.status);
      const parsed = upstreamTracksResponseSchema.safeParse(
        await response.json().catch(() => ({})),
      );
      if (!parsed.success) return upstreamFailure(operation.kind, response.status);
      if (
        parsed.data.errorCode === undefined &&
        parsedBody.data.force !== true &&
        parsed.data.sessionDescription === undefined
      ) {
        return upstreamFailure(operation.kind, response.status);
      }
      const reportedTracks = parsed.data.tracks.filter((track) => track.mid != null);
      const closedMids = new Set(
        parsed.data.errorCode !== undefined
          ? []
          : reportedTracks
              .filter((track) => track.errorCode === undefined)
              .map((track) => track.mid as string),
      );
      let wasPublishing = false;
      const next = persist((latest) => {
        wasPublishing = latest.publishedMid !== null && closedMids.has(latest.publishedMid);
        return {
          ...latest,
          publishedMid: wasPublishing ? null : latest.publishedMid,
          publishedTrackName: wasPublishing ? null : latest.publishedTrackName,
          receivingMids: latest.receivingMids.filter((mid) => !closedMids.has(mid)),
          receivingTracks: latest.receivingTracks.filter((track) => !closedMids.has(track.mid)),
          ...(wasPublishing ? { participantRevision: this.nextRevision() } : {}),
        };
      });
      if (!next) return noStoreJson({ error: "unauthorized" }, 403);
      if (wasPublishing) this.broadcastUpsert(next, socket);
      logOutcome("close-tracks", 200);
      return noStoreJson(sanitizeTracksResponse(parsed.data));
    });
  }
}
