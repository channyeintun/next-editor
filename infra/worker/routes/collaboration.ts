import { Hono } from "hono";
import type { Context } from "hono";
import { COLLABORATION_BINARY_PROTOCOL_VERSION } from "../../../src/collaboration/binaryProtocol";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_SQLITE_PERSISTENCE_VERSION,
  MAX_ENCODED_YJS_SNAPSHOT_LENGTH,
  canPublishCollaborationUpdate,
  claimCollaborationInvitationInputSchema,
  collaborationAssetIdSchema,
  collaborationCreateRoomInputSchema,
  collaborationTeachingInitializationInputSchema,
  collaborationIdSchema,
  createCollaborationInvitationInputSchema,
  updateCollaborationMemberInputSchema,
  type CollaborationCreateRoomInput,
  type CollaborationRole,
} from "../../../src/collaboration/protocol";
import {
  createProvisioningCollaborationRoom,
  claimCollaborationInvitation,
  deleteCollaborationAssetRegistration,
  deleteCollaborationRoomAssetRegistrations,
  createCollaborationInvitation,
  getCollaborationAsset,
  getCollaborationRoomAccess,
  getCollaborationRoomById,
  getCollaborationInvitationByHash,
  listCollaborationInvitations,
  listCollaborationRoomMembers,
  listCollaborationRoomsForUser,
  removeCollaborationMember,
  markCollaborationRoomPurged,
  recordCollaborationAuditEvent,
  registerCollaborationAsset,
  revokeCollaborationInvitation,
  setCollaborationRoomStatus,
  updateCollaborationMemberRole,
  type CollaborationInvitationRow,
  type CollaborationRoomAccess,
  type CollaborationRoomRow,
  CollaborationRoomQuotaError,
  CollaborationAssetMetadataError,
  CollaborationAssetQuotaError,
} from "../../db/collaborationQueries";
import { getCurrentUser } from "../auth/session";
import {
  COLLABORATION_CLEANUP_DELAY,
  collaborationMaintenanceDestination,
  collaborationMaintenanceJobSchema,
  publishCollaborationMaintenanceJob,
  verifyQStashSignature,
} from "../collaboration/qstash";
import {
  collaborationAssetKey,
  deleteCollaborationRoomAssets,
  exactArrayBuffer,
  readCollaborationAsset,
} from "../collaboration/assetStore";
import type { Env } from "../env";
import {
  deleteCollaborationRoomSqliteDocument,
  exportCollaborationRoomSqliteDocument,
  forwardCollaborationWebSocket,
  hasCollaborationRoomBinding,
  initializeCollaborationRoomSqliteDocument,
  initializeCollaborationRoomTeachingDocument,
  notifyCollaborationRoomControl,
} from "../collaboration/roomDurableObject";
import { collaborationRoomLocationHint } from "../collaboration/roomLocation";
import {
  VOICE_CAPABILITY_HEADER,
  forwardCollaborationVoiceSfuRequest,
  forwardCollaborationVoiceWebSocket,
  isVoiceChatEnabled,
  notifyCollaborationVoiceRoomControl,
  type CanonicalVoiceSession,
} from "../collaboration/voiceDurableObject";
import {
  MAX_VOICE_SFU_REQUEST_BYTES,
  voiceCapabilitySchema,
} from "../../../src/collaboration/voiceProtocol";

const MAX_CREATE_ROOM_REQUEST_BYTES = MAX_ENCODED_YJS_SNAPSHOT_LENGTH + 2 * 1024;
const MAX_TEACHING_INITIALIZATION_REQUEST_BYTES = MAX_ENCODED_YJS_SNAPSHOT_LENGTH + 2 * 1024;
const MAX_MAINTENANCE_REQUEST_BYTES = 2 * 1024;
const CLOSED_ROOM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type CollaborationContext = Context<{ Bindings: Env }>;

type ParsedCreateRoomBody =
  | { ok: true; data: CollaborationCreateRoomInput }
  | { ok: false; status: 400 | 413; error: string };

function roomResponse(room: CollaborationRoomRow, role: CollaborationRoomAccess["member_role"]) {
  return {
    room: {
      id: room.id,
      ownerId: room.owner_id,
      hostUserId: room.host_user_id,
      status: room.status,
      protocolVersion: room.protocol_version,
      documentSchemaVersion: room.document_schema_version,
      roleVersion: room.role_version,
      maxMembers: room.max_members,
      createdAt: room.created_at,
      updatedAt: room.updated_at,
    },
    membership: { role },
  };
}

function memberResponse(member: Awaited<ReturnType<typeof listCollaborationRoomMembers>>[number]) {
  return {
    userId: member.user_id,
    role: member.role,
    username: member.username,
    name: member.name,
    avatarUrl: member.avatar_url,
    joinedAt: member.joined_at,
    updatedAt: member.updated_at,
  };
}

function invitationResponse(invitation: CollaborationInvitationRow) {
  return {
    id: invitation.id,
    roomId: invitation.room_id,
    role: invitation.role,
    maxUses: invitation.max_uses,
    useCount: invitation.use_count,
    expiresAt: invitation.expires_at,
    revokedAt: invitation.revoked_at,
    createdAt: invitation.created_at,
  };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function createInvitationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBoundedJson(
  c: CollaborationContext,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 413 }> {
  const contentLengthHeader = c.req.header("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      return { ok: false, status: 400 };
    }
    if (contentLength > maxBytes) {
      return { ok: false, status: 413 };
    }
  }

  const stream = c.req.raw.body;
  if (!stream) return { ok: false, status: 400 };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

async function readBoundedText(
  c: CollaborationContext,
  maxBytes: number,
): Promise<{ ok: true; body: string } | { ok: false; status: 400 | 413 }> {
  const contentLengthHeader = c.req.header("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0) return { ok: false, status: 400 };
    if (contentLength > maxBytes) return { ok: false, status: 413 };
  }
  const stream = c.req.raw.body;
  if (!stream) return { ok: false, status: 400 };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, status: 400 };
  }
}

async function parseCreateRoomBody(c: CollaborationContext): Promise<ParsedCreateRoomBody> {
  const json = await readBoundedJson(c, MAX_CREATE_ROOM_REQUEST_BYTES);
  if (!json.ok) {
    return {
      ...json,
      error: json.status === 413 ? "snapshot payload too large" : "invalid collaboration snapshot",
    };
  }
  const result = collaborationCreateRoomInputSchema.safeParse(json.body);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, status: 400, error: "invalid collaboration snapshot" };
}

async function dispatchControlEvent(
  c: CollaborationContext,
  event: {
    kind: "membership-changed" | "room-closed";
    roomId: string;
    roleVersion: number;
    targetUserId: string | null;
    targetRole?: CollaborationRole | null;
  },
): Promise<void> {
  const control = {
    kind: event.kind,
    roomId: event.roomId,
    roleVersion: event.roleVersion,
    targetUserId: event.targetUserId,
    occurredAt: Date.now(),
  } as const;
  const command = {
    event: control,
    ...(event.targetUserId ? { targetRole: event.targetRole ?? null } : {}),
  };
  const delivered = await notifyCollaborationRoomControl(c.env, event.roomId, command);
  if (!delivered) throw new Error("collaboration room coordinator unavailable");
  // Voice teardown must not block or fail the membership operation; the
  // voice room also revalidates D1 access on every SFU gateway call.
  if (c.env.COLLABORATION_VOICE_ROOMS) {
    c.executionCtx.waitUntil(
      notifyCollaborationVoiceRoomControl(c.env, event.roomId, command).then(
        () => undefined,
        (error: unknown) => {
          console.error("collaboration_voice_control_failed", {
            roomId: event.roomId,
            kind: event.kind,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      ),
    );
  }
}

function scheduleAuditEvent(
  c: CollaborationContext,
  input: Parameters<typeof recordCollaborationAuditEvent>[1],
): void {
  c.executionCtx.waitUntil(
    recordCollaborationAuditEvent(c.env.DB, input).catch((error) => {
      console.error("Failed to record collaboration audit event", {
        roomId: input.roomId,
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }),
  );
}

function scheduleClosedRoomCleanup(
  c: CollaborationContext,
  roomId: string,
  closedAt: number,
): void {
  c.executionCtx.waitUntil(
    (async () => {
      const result = await publishCollaborationMaintenanceJob(
        c.env,
        { kind: "cleanup-room", roomId, closedAt },
        { delay: COLLABORATION_CLEANUP_DELAY },
      );
      if (!result.queued) {
        console.error("collaboration_qstash_disabled", {
          kind: "cleanup-room",
          roomId,
          missing: result.missing,
          consequence: "cleanup-not-scheduled",
        });
        return;
      }
      console.log("collaboration_qstash_queued", {
        kind: "cleanup-room",
        roomId,
        messageId: result.messageId,
        deduplicated: result.deduplicated,
        delay: COLLABORATION_CLEANUP_DELAY,
      });
    })().catch((error) => {
      console.error("collaboration_qstash_publish_failed", {
        kind: "cleanup-room",
        roomId,
        consequence: "cleanup-not-scheduled",
        error: error instanceof Error ? error.message : String(error),
      });
    }),
  );
}

// Mounted at /api/collaboration in worker/index.ts. D1 owns room/access
// metadata; each room Durable Object owns its live socket and SQLite document.
export const collaborationRoute = new Hono<{ Bindings: Env }>();

collaborationRoute.post("/jobs/maintenance", async (c) => {
  if (!c.env.QSTASH_CURRENT_SIGNING_KEY || !c.env.QSTASH_NEXT_SIGNING_KEY) {
    return c.json({ error: "maintenance receiver unavailable" }, 503);
  }
  const raw = await readBoundedText(c, MAX_MAINTENANCE_REQUEST_BYTES);
  if (!raw.ok) return c.json({ error: "invalid maintenance job" }, raw.status);
  const signature = c.req.header("upstash-signature");
  const upstashRegion = c.req.header("upstash-region");
  if (
    !signature ||
    !(await verifyQStashSignature({
      signature,
      body: raw.body,
      url: collaborationMaintenanceDestination(c.env),
      currentSigningKey: c.env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: c.env.QSTASH_NEXT_SIGNING_KEY,
      ...(upstashRegion ? { upstashRegion } : {}),
    }))
  ) {
    return c.json({ error: "invalid maintenance signature" }, 401);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.body) as unknown;
  } catch {
    json = null;
  }
  const job = collaborationMaintenanceJobSchema.safeParse(json);
  if (!job.success) {
    return new Response(JSON.stringify({ error: "invalid maintenance job" }), {
      status: 489,
      headers: {
        "Content-Type": "application/json",
        "Upstash-NonRetryable-Error": "true",
      },
    });
  }

  const room = await getCollaborationRoomById(c.env.DB, job.data.roomId);
  if (!room || room.purged_at !== null) return c.body(null, 204);
  if (
    room.status !== "closed" ||
    room.closed_at !== job.data.closedAt ||
    Date.now() < job.data.closedAt + CLOSED_ROOM_RETENTION_MS
  ) {
    return c.body(null, 204);
  }
  const deleted = await deleteCollaborationRoomSqliteDocument(c.env, room.id);
  if (!deleted) throw new Error("collaboration room SQLite binding unavailable during purge");
  const deletedAssets = await deleteCollaborationRoomAssets(c.env.BUCKET, room.id);
  const deletedAssetRecords = await deleteCollaborationRoomAssetRegistrations(c.env.DB, room.id);
  const marked = await markCollaborationRoomPurged(c.env.DB, room.id, job.data.closedAt);
  if (marked) {
    scheduleAuditEvent(c, {
      roomId: room.id,
      actorUserId: null,
      action: "room.purged",
    });
  }
  console.log("collaboration_maintenance", {
    kind: job.data.kind,
    roomId: room.id,
    documentPurged: deleted,
    deletedAssets,
    deletedAssetRecords,
    marked,
  });
  return c.json({ purged: marked, documentPurged: deleted, deletedAssets, deletedAssetRecords });
});

collaborationRoute.get("/rooms", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);

  const rooms = await listCollaborationRoomsForUser(c.env.DB, user.id);
  return c.json({ rooms: rooms.map((room) => roomResponse(room, room.member_role)) });
});

collaborationRoute.post("/rooms", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);

  const parsed = await parseCreateRoomBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  if (!hasCollaborationRoomBinding(c.env)) {
    return c.json({ error: "collaboration transport unavailable" }, 503);
  }

  let room: CollaborationRoomRow;
  try {
    room = await createProvisioningCollaborationRoom(c.env.DB, {
      ownerId: user.id,
    });
  } catch (error) {
    if (error instanceof CollaborationRoomQuotaError) {
      return c.json({ error: "active collaboration room limit reached" }, 409);
    }
    throw error;
  }
  try {
    const initialized = await initializeCollaborationRoomSqliteDocument(
      c.env,
      room.id,
      parsed.data.snapshot,
      collaborationRoomLocationHint(c.req.raw),
    );
    if (!initialized) throw new Error("collaboration room SQLite binding unavailable");
  } catch (error) {
    await setCollaborationRoomStatus(c.env.DB, room.id, "failed");
    console.error("Failed to seed collaboration room", {
      roomId: room.id,
      updateId: parsed.data.updateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "failed to initialize collaboration room" }, 503);
  }

  const activeRoom = await setCollaborationRoomStatus(c.env.DB, room.id, "active");
  if (!activeRoom) {
    console.error("Failed to activate collaboration room", { roomId: room.id });
    return c.json({ error: "failed to activate collaboration room" }, 500);
  }

  scheduleAuditEvent(c, {
    roomId: activeRoom.id,
    actorUserId: user.id,
    action: "room.created",
  });

  return c.json(roomResponse(activeRoom, "owner"), 201);
});

collaborationRoute.get("/rooms/:roomId", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);

  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);

  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access) return c.json({ error: "not found" }, 404);

  return c.json(roomResponse(access, access.member_role), 200, {
    "Cache-Control": "private, no-store",
  });
});

collaborationRoute.post("/rooms/:roomId/teaching/initialize", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomId = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomId.success) return c.json({ error: "invalid room id" }, 400);
  const raw = await readBoundedJson(c, MAX_TEACHING_INITIALIZATION_REQUEST_BYTES);
  if (!raw.ok) return c.json({ error: "invalid teaching initialization" }, raw.status);
  const update = collaborationTeachingInitializationInputSchema.safeParse(raw.body);
  if (!update.success) return c.json({ error: "invalid teaching initialization" }, 400);
  const access = await getCollaborationRoomAccess(c.env.DB, roomId.data, user.id);
  if (!access || access.member_role !== "owner") return c.json({ error: "not found" }, 404);
  if (access.status !== "active") return c.json({ error: "room is not active" }, 409);
  const result = await initializeCollaborationRoomTeachingDocument(
    c.env,
    access.id,
    user.id,
    update.data,
  );
  if (!result.ok) {
    const status =
      result.status === 409 || result.status === 413 || result.status === 503 ? result.status : 400;
    return c.json({ error: result.error }, status);
  }
  return c.json({ initialized: true }, 201);
});

collaborationRoute.put("/rooms/:roomId/assets/:assetId", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomId = collaborationIdSchema.safeParse(c.req.param("roomId"));
  const assetId = collaborationAssetIdSchema.safeParse(c.req.param("assetId"));
  if (!roomId.success || !assetId.success) return c.json({ error: "invalid asset id" }, 400);

  const access = await getCollaborationRoomAccess(c.env.DB, roomId.data, user.id);
  if (!access) return c.json({ error: "not found" }, 404);
  if (access.status !== "active") return c.json({ error: "room is not active" }, 409);
  if (!canPublishCollaborationUpdate(access.member_role)) {
    return c.json({ error: "room is read-only" }, 403);
  }

  const body = await readCollaborationAsset(c.req.raw);
  if (!body.ok) return c.json({ error: body.error }, body.status);
  if (body.descriptor.id !== assetId.data) {
    return c.json({ error: "asset digest does not match its URL" }, 400);
  }

  let registration: Awaited<ReturnType<typeof registerCollaborationAsset>>;
  try {
    registration = await registerCollaborationAsset(c.env.DB, {
      roomId: access.id,
      uploadedBy: user.id,
      asset: body.descriptor,
    });
  } catch (error) {
    if (error instanceof CollaborationAssetQuotaError) {
      return c.json({ error: "collaboration room asset quota exceeded" }, 413);
    }
    if (error instanceof CollaborationAssetMetadataError) {
      return c.json({ error: "asset metadata conflicts with its content digest" }, 409);
    }
    throw error;
  }

  try {
    await c.env.BUCKET.put(
      collaborationAssetKey(access.id, assetId.data),
      exactArrayBuffer(body.bytes),
      {
        httpMetadata: { contentType: registration.row.mime_type },
        customMetadata: { roomId: access.id, sha256: assetId.data },
      },
    );
  } catch (error) {
    if (registration.created) {
      await deleteCollaborationAssetRegistration(c.env.DB, access.id, assetId.data).catch(() => {});
    }
    console.error("Failed to store collaboration asset", {
      roomId: access.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "failed to store collaboration asset" }, 503);
  }

  if (registration.created) {
    scheduleAuditEvent(c, {
      roomId: access.id,
      actorUserId: user.id,
      action: "asset.uploaded",
    });
  }
  return c.json(
    {
      id: registration.row.asset_id,
      mimeType: registration.row.mime_type,
      size: registration.row.size,
    },
    registration.created ? 201 : 200,
  );
});

collaborationRoute.get("/rooms/:roomId/assets/:assetId", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomId = collaborationIdSchema.safeParse(c.req.param("roomId"));
  const assetId = collaborationAssetIdSchema.safeParse(c.req.param("assetId"));
  if (!roomId.success || !assetId.success) return c.json({ error: "invalid asset id" }, 400);

  const access = await getCollaborationRoomAccess(c.env.DB, roomId.data, user.id);
  if (
    !access ||
    access.purged_at !== null ||
    (access.status !== "active" && access.status !== "closed")
  ) {
    return c.json({ error: "not found" }, 404);
  }
  const asset = await getCollaborationAsset(c.env.DB, access.id, assetId.data);
  if (!asset) return c.json({ error: "not found" }, 404);
  const object = await c.env.BUCKET.get(collaborationAssetKey(access.id, assetId.data));
  if (!object) return c.json({ error: "asset is unavailable" }, 404);

  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${asset.asset_id}"`,
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Content-Type": "application/octet-stream",
    "Content-Length": String(asset.size),
    "X-Content-Type-Options": "nosniff",
  });
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
});

collaborationRoute.get("/rooms/:roomId/export", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);
  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access || access.member_role !== "owner") return c.json({ error: "not found" }, 404);
  if (access.purged_at !== null) return c.json({ error: "room document has expired" }, 410);
  try {
    const document = await exportCollaborationRoomSqliteDocument(c.env, access.id);
    if (!document) return c.json({ error: "collaboration unavailable" }, 503);
    scheduleAuditEvent(c, {
      roomId: access.id,
      actorUserId: user.id,
      action: "room.exported",
    });
    return c.json(
      {
        exportedAt: Date.now(),
        room: roomResponse(access, access.member_role).room,
        document,
      },
      200,
      {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="collaboration-${access.id}.json"`,
      },
    );
  } catch (error) {
    console.error("Failed to export collaboration room", {
      roomId: access.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "failed to export collaboration room" }, 503);
  }
});

collaborationRoute.get("/rooms/:roomId/members", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);

  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access) return c.json({ error: "not found" }, 404);
  const members = await listCollaborationRoomMembers(c.env.DB, access.id);
  return c.json({ members: members.map(memberResponse), roleVersion: access.role_version });
});

collaborationRoute.get("/rooms/:roomId/invitations", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);

  const invitations = await listCollaborationInvitations(c.env.DB, roomIdResult.data, user.id);
  if (!invitations) return c.json({ error: "not found" }, 404);
  return c.json({ invitations: invitations.map(invitationResponse) });
});

collaborationRoute.post("/rooms/:roomId/invitations", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);
  const body = await c.req.json<unknown>().catch(() => null);
  const input = createCollaborationInvitationInputSchema.safeParse(body);
  if (!input.success) return c.json({ error: "invalid invitation" }, 400);

  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access || access.member_role !== "owner" || access.status !== "active") {
    return c.json({ error: "not found" }, 404);
  }
  const token = createInvitationToken();
  const invitation = await createCollaborationInvitation(c.env.DB, {
    roomId: access.id,
    createdBy: user.id,
    tokenHash: await hashInvitationToken(token),
    role: input.data.role,
    maxUses: input.data.maxUses,
    expiresAt: Date.now() + input.data.expiresInHours * 60 * 60 * 1000,
  });
  scheduleAuditEvent(c, {
    roomId: access.id,
    actorUserId: user.id,
    action: "invitation.created",
  });
  return c.json({ ...invitationResponse(invitation), token }, 201);
});

collaborationRoute.delete("/rooms/:roomId/invitations/:invitationId", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  const invitationIdResult = collaborationIdSchema.safeParse(c.req.param("invitationId"));
  if (!roomIdResult.success || !invitationIdResult.success) {
    return c.json({ error: "invalid id" }, 400);
  }
  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access || access.member_role !== "owner") return c.json({ error: "not found" }, 404);
  const revoked = await revokeCollaborationInvitation(
    c.env.DB,
    roomIdResult.data,
    invitationIdResult.data,
    user.id,
  );
  if (!revoked) return c.json({ error: "not found" }, 404);
  scheduleAuditEvent(c, {
    roomId: roomIdResult.data,
    actorUserId: user.id,
    action: "invitation.revoked",
  });
  return c.body(null, 204);
});

collaborationRoute.patch("/rooms/:roomId/members/:userId", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  const userIdResult = collaborationIdSchema.safeParse(c.req.param("userId"));
  const body = await c.req.json<unknown>().catch(() => null);
  const input = updateCollaborationMemberInputSchema.safeParse(body);
  if (!roomIdResult.success || !userIdResult.success || !input.success) {
    return c.json({ error: "invalid member update" }, 400);
  }
  const member = await updateCollaborationMemberRole(
    c.env.DB,
    roomIdResult.data,
    user.id,
    userIdResult.data,
    input.data.role,
  );
  if (!member) return c.json({ error: "not found" }, 404);
  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (access) {
    await dispatchControlEvent(c, {
      kind: "membership-changed",
      roomId: access.id,
      roleVersion: access.role_version,
      targetUserId: member.user_id,
      targetRole: member.role,
    });
  }
  scheduleAuditEvent(c, {
    roomId: roomIdResult.data,
    actorUserId: user.id,
    action: "member.role_changed",
    targetUserId: member.user_id,
  });
  return c.json({ member: memberResponse(member) });
});

collaborationRoute.delete("/rooms/:roomId/members/:userId", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  const userIdResult = collaborationIdSchema.safeParse(c.req.param("userId"));
  if (!roomIdResult.success || !userIdResult.success) return c.json({ error: "invalid id" }, 400);
  const removed = await removeCollaborationMember(
    c.env.DB,
    roomIdResult.data,
    user.id,
    userIdResult.data,
  );
  if (!removed) return c.json({ error: "not found" }, 404);
  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (access) {
    await dispatchControlEvent(c, {
      kind: "membership-changed",
      roomId: access.id,
      roleVersion: access.role_version,
      targetUserId: userIdResult.data,
      targetRole: null,
    });
  }
  scheduleAuditEvent(c, {
    roomId: roomIdResult.data,
    actorUserId: user.id,
    action: "member.removed",
    targetUserId: userIdResult.data,
  });
  return c.body(null, 204);
});

collaborationRoute.post("/rooms/:roomId/close", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);
  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access || access.member_role !== "owner") return c.json({ error: "not found" }, 404);
  if (access.status === "closed") return c.json(roomResponse(access, access.member_role));
  const room = await setCollaborationRoomStatus(c.env.DB, access.id, "closed");
  if (!room) return c.json({ error: "not found" }, 404);
  await dispatchControlEvent(c, {
    kind: "room-closed",
    roomId: room.id,
    roleVersion: room.role_version,
    targetUserId: null,
  });
  scheduleAuditEvent(c, {
    roomId: room.id,
    actorUserId: user.id,
    action: "room.closed",
  });
  if (room.closed_at !== null) scheduleClosedRoomCleanup(c, room.id, room.closed_at);
  return c.json(roomResponse(room, "owner"));
});

collaborationRoute.post("/invitations/claim", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json<unknown>().catch(() => null);
  const input = claimCollaborationInvitationInputSchema.safeParse(body);
  if (!input.success) return c.json({ error: "invalid invitation" }, 400);
  const invitation = await getCollaborationInvitationByHash(
    c.env.DB,
    await hashInvitationToken(input.data.token),
  );
  if (!invitation) return c.json({ error: "invitation is invalid or expired" }, 404);
  const access = await claimCollaborationInvitation(c.env.DB, invitation, user.id);
  if (!access) return c.json({ error: "room is full or invitation is unavailable" }, 409);
  await dispatchControlEvent(c, {
    kind: "membership-changed",
    roomId: access.id,
    roleVersion: access.role_version,
    targetUserId: user.id,
    targetRole: access.member_role,
  });
  scheduleAuditEvent(c, {
    roomId: access.id,
    actorUserId: user.id,
    action: "invitation.claimed",
    targetUserId: user.id,
  });
  return c.json(roomResponse(access, access.member_role));
});

collaborationRoute.get("/rooms/:roomId/websocket", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "expected WebSocket upgrade" }, 426);
  }
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomId = collaborationIdSchema.safeParse(c.req.param("roomId"));
  const sessionId = collaborationIdSchema.safeParse(c.req.query("sessionId"));
  const attemptId = collaborationIdSchema.safeParse(c.req.query("attemptId"));
  if (!roomId.success || !sessionId.success || !attemptId.success) {
    return c.json({ error: "invalid collaboration session" }, 400);
  }
  const access = await getCollaborationRoomAccess(c.env.DB, roomId.data, user.id);
  if (!access) return c.json({ error: "not found" }, 404);
  if (access.status !== "active") return c.json({ error: "room is not active" }, 409);
  if (
    access.transport !== "cloudflare-websocket" ||
    access.persistence_version !== COLLABORATION_SQLITE_PERSISTENCE_VERSION ||
    access.protocol_version !== COLLABORATION_PROTOCOL_VERSION ||
    access.document_schema_version !== COLLABORATION_DOCUMENT_SCHEMA_VERSION
  ) {
    return c.json({ error: "room uses an unsupported collaboration protocol" }, 409);
  }
  if (!hasCollaborationRoomBinding(c.env)) {
    return c.json({ error: "collaboration WebSocket unavailable" }, 503);
  }
  const requestedBinaryProtocol = c.req.query("binaryProtocolVersion");
  if (requestedBinaryProtocol !== String(COLLABORATION_BINARY_PROTOCOL_VERSION)) {
    return c.json(
      {
        error: `binary collaboration protocol v${COLLABORATION_BINARY_PROTOCOL_VERSION} is required`,
      },
      409,
    );
  }
  return forwardCollaborationWebSocket(c.env, c.req.raw, {
    roomId: access.id,
    userId: user.id,
    username: user.username,
    name: user.name,
    avatarUrl: user.avatar_url,
    hostUserId: access.host_user_id,
    role: access.member_role,
    roleVersion: access.role_version,
    sessionId: sessionId.data,
    attemptId: attemptId.data,
  });
});

// Origins allowed to open voice transports. Browsers always send Origin on
// WebSocket upgrades and on non-GET fetches; a mismatch is rejected. Local
// development uses the Vite proxy, so loopback origins are also accepted.
function isAllowedVoiceOrigin(c: CollaborationContext): boolean {
  const origin = c.req.header("Origin");
  if (!origin) return c.req.method === "GET";
  try {
    const parsed = new URL(origin);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return true;
    if (origin === new URL(c.env.PUBLIC_URL).origin) return true;
    return origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
}

// Loads the caller's canonical voice identity for an active room, or maps the
// failure to a sanitized response. Voice must fail closed while the document
// collaboration endpoints continue normally.
async function resolveVoiceAccess(
  c: CollaborationContext,
  collaborationSessionId: string,
): Promise<{ ok: true; session: CanonicalVoiceSession } | { ok: false; response: Response }> {
  if (!isVoiceChatEnabled(c.env)) {
    return { ok: false, response: c.json({ error: "voice chat unavailable" }, 503) };
  }
  if (!isAllowedVoiceOrigin(c)) {
    return { ok: false, response: c.json({ error: "unauthorized" }, 403) };
  }
  const user = await getCurrentUser(c);
  if (!user) return { ok: false, response: c.json({ error: "not signed in" }, 401) };
  const roomId = collaborationIdSchema.safeParse(c.req.param("roomId"));
  const sessionId = collaborationIdSchema.safeParse(collaborationSessionId);
  if (!roomId.success || !sessionId.success) {
    return { ok: false, response: c.json({ error: "invalid voice session" }, 400) };
  }
  const access = await getCollaborationRoomAccess(c.env.DB, roomId.data, user.id);
  if (!access) return { ok: false, response: c.json({ error: "not found" }, 404) };
  if (access.status !== "active") {
    return { ok: false, response: c.json({ error: "room is not active" }, 409) };
  }
  return {
    ok: true,
    session: {
      roomId: access.id,
      userId: user.id,
      displayName: user.name?.trim() || user.username,
      role: access.member_role,
      collaborationSessionId: sessionId.data,
      maxMembers: access.max_members,
    },
  };
}

collaborationRoute.get("/rooms/:roomId/voice/websocket", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "expected WebSocket upgrade" }, 426);
  }
  const resolved = await resolveVoiceAccess(c, c.req.query("collaborationSessionId") ?? "");
  if (!resolved.ok) return resolved.response;
  return forwardCollaborationVoiceWebSocket(c.env, c.req.raw, resolved.session);
});

// Secured SFU gateway used by the partytracks client. The Worker
// re-authenticates the application session and D1 membership; the voice
// Durable Object then verifies the connection capability and the full
// session/track/mid ownership matrix before proxying upstream.
collaborationRoute.all("/rooms/:roomId/voice/sfu/*", async (c) => {
  if (c.req.method !== "GET" && c.req.method !== "POST" && c.req.method !== "PUT") {
    return c.json({ error: "unsupported operation" }, 403, { "Cache-Control": "no-store" });
  }
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength > MAX_VOICE_SFU_REQUEST_BYTES) {
    return c.json({ error: "payload too large" }, 413, { "Cache-Control": "no-store" });
  }
  const capability = voiceCapabilitySchema.safeParse(c.req.header(VOICE_CAPABILITY_HEADER));
  const voiceConnectionId = collaborationIdSchema.safeParse(c.req.query("voiceConnectionId"));
  const collaborationSessionId = c.req.query("collaborationSessionId") ?? "";
  if (!capability.success || !voiceConnectionId.success) {
    return c.json({ error: "unauthorized" }, 403, { "Cache-Control": "no-store" });
  }
  const resolved = await resolveVoiceAccess(c, collaborationSessionId);
  if (!resolved.ok) return resolved.response;
  const path = new URL(c.req.url).pathname;
  const marker = "/voice/sfu";
  const subpath = path.slice(path.indexOf(marker) + marker.length);
  return forwardCollaborationVoiceSfuRequest(c.env, c.req.raw, {
    session: resolved.session,
    subpath,
    capability: capability.data,
    voiceConnectionId: voiceConnectionId.data,
  });
});
