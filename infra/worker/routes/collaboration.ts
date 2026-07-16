import { handle } from "@upstash/realtime";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  MAX_ENCODED_YJS_SNAPSHOT_LENGTH,
  MAX_ENCODED_YJS_UPDATE_LENGTH,
  canPublishCollaborationUpdate,
  claimCollaborationInvitationInputSchema,
  collaborationAwarenessInputSchema,
  collaborationAssetIdSchema,
  collaborationCreateRoomInputSchema,
  collaborationDocumentUpdateEventSchema,
  collaborationDocumentUpdateInputSchema,
  collaborationIdSchema,
  collaborationRoomChannel,
  createCollaborationInvitationInputSchema,
  parseCollaborationChannel,
  updateCollaborationMemberInputSchema,
  type CollaborationDocumentUpdateInput,
  type CollaborationCreateRoomInput,
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
  CollaborationAssetQuotaError,
} from "../../db/collaborationQueries";
import { getCurrentUser } from "../auth/session";
import {
  CollaborationConfigurationError,
  createCollaborationRealtime,
  getCollaborationRedis,
} from "../collaboration/realtime";
import {
  appendCollaborationUpdate,
  CollaborationDocumentQuotaError,
  compactCollaborationDocument,
  deleteCollaborationDocument,
  exportCollaborationDocument,
  getCollaborationBootstrap,
  getCollaborationSnapshotGeneration,
  initializeCollaborationDocument,
  shouldCompactCollaborationDocument,
} from "../collaboration/documentStore";
import {
  COLLABORATION_AWARENESS_TTL_MS,
  CollaborationAwarenessRateLimitError,
  listCollaborationAwareness,
  publishCollaborationAwareness,
  publishCollaborationControl,
} from "../collaboration/awarenessStore";
import {
  CollaborationRateLimitError,
  enforceCollaborationConnectionRateLimit,
  enforceCollaborationUpdateRateLimit,
} from "../collaboration/rateLimits";
import {
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

const MAX_UPDATE_REQUEST_BYTES = MAX_ENCODED_YJS_UPDATE_LENGTH + 2 * 1024;
const MAX_CREATE_ROOM_REQUEST_BYTES = MAX_ENCODED_YJS_SNAPSHOT_LENGTH + 2 * 1024;
const MAX_AWARENESS_REQUEST_BYTES = 8 * 1024;
const MAX_MAINTENANCE_REQUEST_BYTES = 2 * 1024;
const MAX_CHANNELS_PER_CONNECTION = 4;
const CLOSED_ROOM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type CollaborationContext = Context<{ Bindings: Env }>;

type ParsedUpdateBody =
  | { ok: true; data: CollaborationDocumentUpdateInput }
  | { ok: false; status: 400 | 413; error: string };

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
    channel: collaborationRoomChannel(room.id),
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

async function parseUpdateBody(c: CollaborationContext): Promise<ParsedUpdateBody> {
  const json = await readBoundedJson(c, MAX_UPDATE_REQUEST_BYTES);
  if (!json.ok) {
    return {
      ...json,
      error: json.status === 413 ? "update payload too large" : "invalid collaboration update",
    };
  }

  const result = collaborationDocumentUpdateInputSchema.safeParse(json.body);
  if (!result.success) {
    return { ok: false, status: 400, error: "invalid collaboration update" };
  }
  return { ok: true, data: result.data };
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

function getRealtime(c: CollaborationContext) {
  try {
    return { ok: true as const, realtime: createCollaborationRealtime(c.env) };
  } catch (error) {
    if (error instanceof CollaborationConfigurationError) {
      return { ok: false as const, response: c.json({ error: "collaboration unavailable" }, 503) };
    }
    throw error;
  }
}

function eventFor(input: CollaborationDocumentUpdateInput, roomId: string, actorId: string) {
  return collaborationDocumentUpdateEventSchema.parse({
    ...input,
    roomId,
    actorId,
    receivedAt: Date.now(),
  });
}

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function scheduleControlEvent(
  c: CollaborationContext,
  event: {
    kind: "membership-changed" | "room-closed";
    roomId: string;
    roleVersion: number;
    targetUserId: string | null;
  },
): void {
  try {
    c.executionCtx.waitUntil(
      publishCollaborationControl(getCollaborationRedis(c.env), {
        ...event,
        occurredAt: Date.now(),
      }).catch((error) => {
        console.error("Failed to publish collaboration control event", {
          roomId: event.roomId,
          kind: event.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  } catch (error) {
    if (!(error instanceof CollaborationConfigurationError)) throw error;
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

function scheduleCompaction(
  c: CollaborationContext,
  roomId: string,
  expectedGeneration: number,
): void {
  c.executionCtx.waitUntil(
    (async () => {
      const queued = await publishCollaborationMaintenanceJob(c.env, {
        kind: "compact-room",
        roomId,
        expectedGeneration,
      });
      if (!queued) {
        await compactCollaborationDocument(getCollaborationRedis(c.env), roomId, expectedGeneration);
      }
    })().catch((error) => {
      console.error("Failed to schedule collaboration compaction", {
        roomId,
        expectedGeneration,
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
    publishCollaborationMaintenanceJob(
      c.env,
      { kind: "cleanup-room", roomId, closedAt },
      { delay: "8d" },
    ).catch((error) => {
      console.error("Failed to schedule collaboration cleanup", {
        roomId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }),
  );
}

// Mounted at /api/collaboration in worker/index.ts. D1 is the room/role
// control plane; Redis Streams and Realtime are the document data plane.
export const collaborationRoute = new Hono<{ Bindings: Env }>();

collaborationRoute.post("/jobs/maintenance", async (c) => {
  if (!c.env.QSTASH_CURRENT_SIGNING_KEY || !c.env.QSTASH_NEXT_SIGNING_KEY) {
    return c.json({ error: "maintenance receiver unavailable" }, 503);
  }
  const raw = await readBoundedText(c, MAX_MAINTENANCE_REQUEST_BYTES);
  if (!raw.ok) return c.json({ error: "invalid maintenance job" }, raw.status);
  const signature = c.req.header("upstash-signature");
  if (
    !signature ||
    !(await verifyQStashSignature({
      signature,
      body: raw.body,
      url: collaborationMaintenanceDestination(c.env),
      currentSigningKey: c.env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: c.env.QSTASH_NEXT_SIGNING_KEY,
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
  const redis = getCollaborationRedis(c.env);
  if (job.data.kind === "compact-room") {
    if (room.status !== "active" && room.status !== "closed") return c.body(null, 204);
    const result = await compactCollaborationDocument(
      redis,
      room.id,
      job.data.expectedGeneration,
    );
    if (result.compacted) {
      scheduleAuditEvent(c, {
        roomId: room.id,
        actorUserId: null,
        action: "room.compacted",
      });
    }
    console.log("collaboration_maintenance", {
      kind: job.data.kind,
      roomId: room.id,
      compacted: result.compacted,
      generation: result.generation ?? null,
    });
    return c.json(result);
  }

  if (
    room.status !== "closed" ||
    room.closed_at !== job.data.closedAt ||
    Date.now() < job.data.closedAt + CLOSED_ROOM_RETENTION_MS
  ) {
    return c.body(null, 204);
  }
  const deletedKeys = await deleteCollaborationDocument(redis, room.id);
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
    deletedKeys,
    deletedAssets,
    deletedAssetRecords,
    marked,
  });
  return c.json({ purged: marked, deletedKeys, deletedAssets, deletedAssetRecords });
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

  let redis;
  try {
    redis = getCollaborationRedis(c.env);
  } catch (error) {
    if (error instanceof CollaborationConfigurationError) {
      return c.json({ error: "collaboration unavailable" }, 503);
    }
    throw error;
  }

  let room: CollaborationRoomRow;
  try {
    room = await createProvisioningCollaborationRoom(c.env.DB, {
      ownerId: user.id,
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
    });
  } catch (error) {
    if (error instanceof CollaborationRoomQuotaError) {
      return c.json({ error: "active collaboration room limit reached" }, 409);
    }
    throw error;
  }
  try {
    await initializeCollaborationDocument(redis, room.id, parsed.data.snapshot);
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

collaborationRoute.get("/rooms/:roomId/bootstrap", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);
  const cursor = c.req.query("cursor");
  if (cursor && !/^\d+-\d+$/.test(cursor)) return c.json({ error: "invalid cursor" }, 400);

  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access) return c.json({ error: "not found" }, 404);
  if (access.status !== "active") return c.json({ error: "room is not active" }, 409);
  try {
    return c.json(await getCollaborationBootstrap(getCollaborationRedis(c.env), access.id, cursor));
  } catch (error) {
    if (error instanceof CollaborationConfigurationError) {
      return c.json({ error: "collaboration unavailable" }, 503);
    }
    console.error("Failed to bootstrap collaboration room", {
      roomId: access.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "failed to synchronize collaboration room" }, 503);
  }
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
      assetId: assetId.data,
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
    const document = await exportCollaborationDocument(
      getCollaborationRedis(c.env),
      access.id,
    );
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
    if (error instanceof CollaborationConfigurationError) {
      return c.json({ error: "collaboration unavailable" }, 503);
    }
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

collaborationRoute.get("/rooms/:roomId/awareness", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);
  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access || access.status !== "active") return c.json({ error: "not found" }, 404);
  try {
    const participants = await listCollaborationAwareness(
      getCollaborationRedis(c.env),
      access.id,
    );
    return c.json({ participants });
  } catch (error) {
    if (error instanceof CollaborationConfigurationError) {
      return c.json({ error: "collaboration unavailable" }, 503);
    }
    throw error;
  }
});

collaborationRoute.post("/rooms/:roomId/awareness", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);
  const json = await readBoundedJson(c, MAX_AWARENESS_REQUEST_BYTES);
  if (!json.ok) {
    return c.json(
      { error: json.status === 413 ? "awareness payload too large" : "invalid awareness" },
      json.status,
    );
  }
  const input = collaborationAwarenessInputSchema.safeParse(json.body);
  if (!input.success) return c.json({ error: "invalid awareness" }, 400);
  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access || access.status !== "active") return c.json({ error: "not found" }, 404);

  const now = Date.now();
  const event =
    input.data.kind === "leave"
      ? {
          ...input.data,
          roomId: access.id,
          actorId: user.id,
          occurredAt: now,
        }
      : {
          ...input.data,
          roomId: access.id,
          actorId: user.id,
          role: access.member_role,
          username: user.username,
          name: user.name,
          avatarUrl: user.avatar_url,
          isHost: access.host_user_id === user.id,
          occurredAt: now,
          expiresAt: now + COLLABORATION_AWARENESS_TTL_MS,
        };
  try {
    const streamId = await publishCollaborationAwareness(getCollaborationRedis(c.env), event);
    return c.json({ accepted: true, streamId, event }, 202);
  } catch (error) {
    if (error instanceof CollaborationAwarenessRateLimitError) {
      return c.json({ error: "awareness rate limit exceeded" }, 429);
    }
    if (error instanceof CollaborationConfigurationError) {
      return c.json({ error: "collaboration unavailable" }, 503);
    }
    throw error;
  }
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
    scheduleControlEvent(c, {
      kind: "membership-changed",
      roomId: access.id,
      roleVersion: access.role_version,
      targetUserId: member.user_id,
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
    scheduleControlEvent(c, {
      kind: "membership-changed",
      roomId: access.id,
      roleVersion: access.role_version,
      targetUserId: userIdResult.data,
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
  scheduleControlEvent(c, {
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
  scheduleControlEvent(c, {
    kind: "membership-changed",
    roomId: access.id,
    roleVersion: access.role_version,
    targetUserId: user.id,
  });
  scheduleAuditEvent(c, {
    roomId: access.id,
    actorUserId: user.id,
    action: "invitation.claimed",
    targetUserId: user.id,
  });
  return c.json(roomResponse(access, access.member_role));
});

collaborationRoute.post("/rooms/:roomId/updates", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);

  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);

  const parsed = await parseUpdateBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access) return c.json({ error: "not found" }, 404);
  if (access.status !== "active") {
    return c.json({ error: "room is not active" }, 409);
  }
  if (!canPublishCollaborationUpdate(access.member_role)) {
    return c.json({ error: "room is read-only" }, 403);
  }

  const event = eventFor(parsed.data, access.id, user.id);
  try {
    const redis = getCollaborationRedis(c.env);
    await enforceCollaborationUpdateRateLimit(redis, access.id, user.id);
    const result = await appendCollaborationUpdate(redis, event);
    if (shouldCompactCollaborationDocument(result.updateCount)) {
      const generation = await getCollaborationSnapshotGeneration(redis, access.id);
      scheduleCompaction(c, access.id, generation);
    }
    console.log("collaboration_update", {
      roomId: access.id,
      actorId: user.id,
      bytes: Math.floor((event.update.length * 3) / 4),
      duplicate: result.duplicate,
      updateCount: result.updateCount,
    });
    return c.json(
      { accepted: true, updateId: event.updateId, streamId: result.streamId },
      result.duplicate ? 200 : 202,
    );
  } catch (error) {
    if (error instanceof CollaborationRateLimitError) {
      return c.json(
        { error: "collaboration update rate limit exceeded" },
        429,
        { "Retry-After": "1" },
      );
    }
    if (error instanceof CollaborationDocumentQuotaError) {
      return c.json({ error: "collaboration room document quota exceeded" }, 413);
    }
    if (error instanceof CollaborationConfigurationError) {
      return c.json({ error: "collaboration unavailable" }, 503);
    }
    console.error("Failed to publish collaboration update", {
      roomId: access.id,
      updateId: event.updateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "failed to publish collaboration update" }, 503);
  }
});

collaborationRoute.get("/realtime", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);

  try {
    await enforceCollaborationConnectionRateLimit(getCollaborationRedis(c.env), user.id);
  } catch (error) {
    if (error instanceof CollaborationRateLimitError) {
      return c.json(
        { error: "collaboration connection rate limit exceeded" },
        429,
        { "Retry-After": "60" },
      );
    }
    if (error instanceof CollaborationConfigurationError) {
      return c.json({ error: "collaboration unavailable" }, 503);
    }
    throw error;
  }

  const realtimeResult = getRealtime(c);
  if (!realtimeResult.ok) return realtimeResult.response;

  const realtimeHandler = handle({
    realtime: realtimeResult.realtime,
    middleware: async ({ channels }) => {
      if (channels.length === 0 || channels.length > MAX_CHANNELS_PER_CONNECTION) {
        return errorResponse("invalid channel count", 400);
      }

      for (const channel of channels) {
        const parsedChannel = parseCollaborationChannel(channel);
        if (!parsedChannel) return errorResponse("forbidden", 403);

        const access = await getCollaborationRoomAccess(c.env.DB, parsedChannel.roomId, user.id);
        if (!access || access.status !== "active") {
          return errorResponse("forbidden", 403);
        }
      }
    },
  });

  const response = await realtimeHandler(c.req.raw);
  return response ?? c.json({ error: "failed to open realtime connection" }, 500);
});
