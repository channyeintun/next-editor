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
} from "../../../src/collaboration/protocol";
import {
  createProvisioningCollaborationRoom,
  claimCollaborationInvitation,
  deleteCollaborationAssetRegistration,
  createCollaborationInvitation,
  getCollaborationAsset,
  getCollaborationRoomAccess,
  getCollaborationInvitationByHash,
  listCollaborationInvitations,
  listCollaborationRoomMembers,
  listCollaborationRoomsForUser,
  removeCollaborationMember,
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
import { requireUser } from "../auth/requireUser";
import { getCurrentUser } from "../auth/session";
import { collaborationAssetKey, readCollaborationAsset } from "../collaboration/assetStore";
import { exactArrayBuffer, randomToken } from "../collaboration/bytes";
import { sha256Hex } from "../../../src/shared/sha256Hex";
import type { Env } from "../env";
import { readJsonWithLimit } from "../httpBody";
import {
  exportCollaborationRoomSqliteDocument,
  forwardCollaborationWebSocket,
  hasCollaborationRoomBinding,
  initializeCollaborationRoomSqliteDocument,
  initializeCollaborationRoomTeachingDocument,
} from "../collaboration/roomDurableObject";
import { collaborationRoomLocationHint } from "../collaboration/roomLocation";
import { collaborationMaintenanceRoute } from "./collaborationMaintenance";
import {
  dispatchControlEvent,
  scheduleAuditEvent,
  scheduleClosedRoomCleanup,
} from "./collaborationSideEffects";
import { collaborationVoiceRoute } from "./collaborationVoice";

const MAX_CREATE_ROOM_REQUEST_BYTES = MAX_ENCODED_YJS_SNAPSHOT_LENGTH + 2 * 1024;
const MAX_TEACHING_INITIALIZATION_REQUEST_BYTES = MAX_ENCODED_YJS_SNAPSHOT_LENGTH + 2 * 1024;
// Invitation, claim and member-role bodies are a few short fields.
const MAX_SMALL_JSON_REQUEST_BYTES = 4 * 1024;

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

async function readBoundedJson<E extends { Bindings: Env }>(
  c: Context<E>,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 413 }> {
  const body = await readJsonWithLimit(c.req.raw, maxBytes);
  if (body.status === "too-large") return { ok: false, status: 413 };
  if (body.status !== "ok") return { ok: false, status: 400 };
  return { ok: true, body: body.value };
}

async function parseCreateRoomBody<E extends { Bindings: Env }>(
  c: Context<E>,
): Promise<ParsedCreateRoomBody> {
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

// Mounted at /api/collaboration in worker/index.ts. D1 owns room/access
// metadata; each room Durable Object owns its live socket and SQLite document.
// The QStash maintenance receiver and the voice gateway are their own modules,
// mounted here so they share the /api/collaboration URL space.
export const collaborationRoute = new Hono<{ Bindings: Env }>();

collaborationRoute.route("/", collaborationMaintenanceRoute);

collaborationRoute.get("/rooms", requireUser, async (c) => {
  const user = c.get("user");

  const rooms = await listCollaborationRoomsForUser(c.env.DB, user.id);
  return c.json({ rooms: rooms.map((room) => roomResponse(room, room.member_role)) });
});

collaborationRoute.post("/rooms", requireUser, async (c) => {
  const user = c.get("user");

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

collaborationRoute.get("/rooms/:roomId", requireUser, async (c) => {
  const user = c.get("user");

  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);

  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access) return c.json({ error: "not found" }, 404);

  return c.json(roomResponse(access, access.member_role), 200, {
    "Cache-Control": "private, no-store",
  });
});

collaborationRoute.post("/rooms/:roomId/teaching/initialize", requireUser, async (c) => {
  const user = c.get("user");
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

collaborationRoute.put("/rooms/:roomId/assets/:assetId", requireUser, async (c) => {
  const user = c.get("user");
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

collaborationRoute.get("/rooms/:roomId/assets/:assetId", requireUser, async (c) => {
  const user = c.get("user");
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

collaborationRoute.get("/rooms/:roomId/export", requireUser, async (c) => {
  const user = c.get("user");
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

collaborationRoute.get("/rooms/:roomId/members", requireUser, async (c) => {
  const user = c.get("user");
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);

  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access) return c.json({ error: "not found" }, 404);
  const members = await listCollaborationRoomMembers(c.env.DB, access.id);
  return c.json({ members: members.map(memberResponse), roleVersion: access.role_version });
});

collaborationRoute.get("/rooms/:roomId/invitations", requireUser, async (c) => {
  const user = c.get("user");
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);

  const invitations = await listCollaborationInvitations(c.env.DB, roomIdResult.data, user.id);
  if (!invitations) return c.json({ error: "not found" }, 404);
  return c.json({ invitations: invitations.map(invitationResponse) });
});

collaborationRoute.post("/rooms/:roomId/invitations", requireUser, async (c) => {
  const user = c.get("user");
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);
  const body = await readBoundedJson(c, MAX_SMALL_JSON_REQUEST_BYTES);
  if (!body.ok) return c.json({ error: "invalid invitation" }, body.status);
  const input = createCollaborationInvitationInputSchema.safeParse(body.body);
  if (!input.success) return c.json({ error: "invalid invitation" }, 400);

  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access || access.member_role !== "owner" || access.status !== "active") {
    return c.json({ error: "not found" }, 404);
  }
  const token = randomToken();
  const invitation = await createCollaborationInvitation(c.env.DB, {
    roomId: access.id,
    createdBy: user.id,
    tokenHash: await sha256Hex(token),
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

collaborationRoute.delete("/rooms/:roomId/invitations/:invitationId", requireUser, async (c) => {
  const user = c.get("user");
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

collaborationRoute.patch("/rooms/:roomId/members/:userId", requireUser, async (c) => {
  const user = c.get("user");
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  const userIdResult = collaborationIdSchema.safeParse(c.req.param("userId"));
  const body = await readBoundedJson(c, MAX_SMALL_JSON_REQUEST_BYTES);
  if (!body.ok) return c.json({ error: "invalid member update" }, body.status);
  const input = updateCollaborationMemberInputSchema.safeParse(body.body);
  if (!roomIdResult.success || !userIdResult.success || !input.success) {
    return c.json({ error: "invalid member update" }, 400);
  }
  const updated = await updateCollaborationMemberRole(
    c.env.DB,
    roomIdResult.data,
    user.id,
    userIdResult.data,
    input.data.role,
  );
  if (!updated) return c.json({ error: "not found" }, 404);
  const { member, roleVersion } = updated;
  await dispatchControlEvent(c, {
    kind: "membership-changed",
    roomId: roomIdResult.data,
    roleVersion,
    targetUserId: member.user_id,
    targetRole: member.role,
  });
  scheduleAuditEvent(c, {
    roomId: roomIdResult.data,
    actorUserId: user.id,
    action: "member.role_changed",
    targetUserId: member.user_id,
  });
  return c.json({ member: memberResponse(member) });
});

collaborationRoute.delete("/rooms/:roomId/members/:userId", requireUser, async (c) => {
  const user = c.get("user");
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  const userIdResult = collaborationIdSchema.safeParse(c.req.param("userId"));
  if (!roomIdResult.success || !userIdResult.success) return c.json({ error: "invalid id" }, 400);
  const ownerAccess = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!ownerAccess || ownerAccess.member_role !== "owner" || userIdResult.data === user.id) {
    return c.json({ error: "not found" }, 404);
  }
  const removed = await removeCollaborationMember(
    c.env.DB,
    roomIdResult.data,
    user.id,
    userIdResult.data,
  );
  // Re-dispatch even when the target was already removed. The first request
  // may have committed D1 and then failed to reach a coordinator; making the
  // retry idempotent closes that revocation gap.
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
  if (removed) {
    scheduleAuditEvent(c, {
      roomId: roomIdResult.data,
      actorUserId: user.id,
      action: "member.removed",
      targetUserId: userIdResult.data,
    });
  }
  return c.body(null, 204);
});

collaborationRoute.post("/rooms/:roomId/close", requireUser, async (c) => {
  const user = c.get("user");
  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);
  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access || access.member_role !== "owner") return c.json({ error: "not found" }, 404);
  if (access.status === "closed") {
    // A previous close may have committed D1 before coordinator delivery
    // failed. Repeating the close must retry both document and voice teardown,
    // and the purge job, whose deduplication ID makes a repeat harmless.
    if (access.closed_at !== null && access.purged_at === null) {
      scheduleClosedRoomCleanup(c, access.id, access.closed_at);
    }
    await dispatchControlEvent(c, {
      kind: "room-closed",
      roomId: access.id,
      roleVersion: access.role_version,
      targetUserId: null,
    });
    return c.json(roomResponse(access, access.member_role));
  }
  const room = await setCollaborationRoomStatus(c.env.DB, access.id, "closed");
  if (!room) return c.json({ error: "not found" }, 404);
  // The room is closed from here on, so record it and schedule its purge
  // before the coordinators are told, which can fail and fail the request.
  scheduleAuditEvent(c, {
    roomId: room.id,
    actorUserId: user.id,
    action: "room.closed",
  });
  if (room.closed_at !== null) scheduleClosedRoomCleanup(c, room.id, room.closed_at);
  await dispatchControlEvent(c, {
    kind: "room-closed",
    roomId: room.id,
    roleVersion: room.role_version,
    targetUserId: null,
  });
  return c.json(roomResponse(room, "owner"));
});

collaborationRoute.post("/invitations/claim", requireUser, async (c) => {
  const user = c.get("user");
  const body = await readBoundedJson(c, MAX_SMALL_JSON_REQUEST_BYTES);
  if (!body.ok) return c.json({ error: "invalid invitation" }, body.status);
  const input = claimCollaborationInvitationInputSchema.safeParse(body.body);
  if (!input.success) return c.json({ error: "invalid invitation" }, 400);
  const invitation = await getCollaborationInvitationByHash(
    c.env.DB,
    await sha256Hex(input.data.token),
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

collaborationRoute.route("/", collaborationVoiceRoute);
