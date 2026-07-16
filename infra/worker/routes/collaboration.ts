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
  collaborationCreateRoomInputSchema,
  collaborationDocumentUpdateEventSchema,
  collaborationDocumentUpdateInputSchema,
  collaborationIdSchema,
  collaborationRoomChannel,
  createCollaborationInvitationInputSchema,
  roomIdFromCollaborationChannel,
  updateCollaborationMemberInputSchema,
  type CollaborationDocumentUpdateInput,
  type CollaborationCreateRoomInput,
} from "../../../src/collaboration/protocol";
import {
  createProvisioningCollaborationRoom,
  claimCollaborationInvitation,
  createCollaborationInvitation,
  getCollaborationRoomAccess,
  getCollaborationInvitationByHash,
  listCollaborationInvitations,
  listCollaborationRoomMembers,
  listCollaborationRoomsForUser,
  removeCollaborationMember,
  revokeCollaborationInvitation,
  setCollaborationRoomStatus,
  updateCollaborationMemberRole,
  type CollaborationInvitationRow,
  type CollaborationRoomAccess,
  type CollaborationRoomRow,
} from "../../db/collaborationQueries";
import { getCurrentUser } from "../auth/session";
import {
  CollaborationConfigurationError,
  createCollaborationRealtime,
  getCollaborationRedis,
} from "../collaboration/realtime";
import {
  appendCollaborationUpdate,
  compactCollaborationDocument,
  getCollaborationBootstrap,
  initializeCollaborationDocument,
  shouldCompactCollaborationDocument,
} from "../collaboration/documentStore";
import type { Env } from "../env";

const MAX_UPDATE_REQUEST_BYTES = MAX_ENCODED_YJS_UPDATE_LENGTH + 2 * 1024;
const MAX_CREATE_ROOM_REQUEST_BYTES = MAX_ENCODED_YJS_SNAPSHOT_LENGTH + 2 * 1024;
const MAX_CHANNELS_PER_CONNECTION = 4;

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

// Mounted at /api/collaboration in worker/index.ts. D1 is the room/role
// control plane; Redis Streams and Realtime are the document data plane.
export const collaborationRoute = new Hono<{ Bindings: Env }>();

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

  const room = await createProvisioningCollaborationRoom(c.env.DB, {
    ownerId: user.id,
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  });
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

  return c.json(roomResponse(activeRoom, "owner"), 201);
});

collaborationRoute.get("/rooms/:roomId", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);

  const roomIdResult = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomIdResult.success) return c.json({ error: "invalid room id" }, 400);

  const access = await getCollaborationRoomAccess(c.env.DB, roomIdResult.data, user.id);
  if (!access) return c.json({ error: "not found" }, 404);

  return c.json(roomResponse(access, access.member_role));
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
  return revoked ? c.body(null, 204) : c.json({ error: "not found" }, 404);
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
  return member ? c.json({ member: memberResponse(member) }) : c.json({ error: "not found" }, 404);
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
  return removed ? c.body(null, 204) : c.json({ error: "not found" }, 404);
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
  return room ? c.json(roomResponse(room, "owner")) : c.json({ error: "not found" }, 404);
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
    const result = await appendCollaborationUpdate(getCollaborationRedis(c.env), event);
    if (shouldCompactCollaborationDocument(result.updateCount)) {
      c.executionCtx.waitUntil(
        compactCollaborationDocument(getCollaborationRedis(c.env), access.id).catch((error) => {
          console.error("Failed to compact collaboration room", {
            roomId: access.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    }
    return c.json(
      { accepted: true, updateId: event.updateId, streamId: result.streamId },
      result.duplicate ? 200 : 202,
    );
  } catch (error) {
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

  const realtimeResult = getRealtime(c);
  if (!realtimeResult.ok) return realtimeResult.response;

  const realtimeHandler = handle({
    realtime: realtimeResult.realtime,
    middleware: async ({ channels }) => {
      if (channels.length === 0 || channels.length > MAX_CHANNELS_PER_CONNECTION) {
        return errorResponse("invalid channel count", 400);
      }

      for (const channel of channels) {
        const roomId = roomIdFromCollaborationChannel(channel);
        if (!roomId) return errorResponse("forbidden", 403);

        const access = await getCollaborationRoomAccess(c.env.DB, roomId, user.id);
        if (!access || access.status !== "active") {
          return errorResponse("forbidden", 403);
        }
      }
    },
  });

  const response = await realtimeHandler(c.req.raw);
  return response ?? c.json({ error: "failed to open realtime connection" }, 500);
});
