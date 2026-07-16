import { handle } from "@upstash/realtime";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  MAX_ENCODED_YJS_UPDATE_LENGTH,
  canPublishCollaborationUpdate,
  collaborationDocumentUpdateEventSchema,
  collaborationDocumentUpdateInputSchema,
  collaborationIdSchema,
  collaborationRoomChannel,
  roomIdFromCollaborationChannel,
  type CollaborationDocumentUpdateInput,
} from "../../../src/collaboration/protocol";
import {
  createProvisioningCollaborationRoom,
  getCollaborationRoomAccess,
  setCollaborationRoomStatus,
  type CollaborationRoomAccess,
  type CollaborationRoomRow,
} from "../../db/collaborationQueries";
import { getCurrentUser } from "../auth/session";
import {
  CollaborationConfigurationError,
  createCollaborationRealtime,
} from "../collaboration/realtime";
import type { Env } from "../env";

const MAX_UPDATE_REQUEST_BYTES = MAX_ENCODED_YJS_UPDATE_LENGTH + 2 * 1024;
const MAX_CHANNELS_PER_CONNECTION = 4;

type CollaborationContext = Context<{ Bindings: Env }>;

type ParsedUpdateBody =
  | { ok: true; data: CollaborationDocumentUpdateInput }
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
      createdAt: room.created_at,
      updatedAt: room.updated_at,
    },
    membership: { role },
    channel: collaborationRoomChannel(room.id),
  };
}

async function parseUpdateBody(c: CollaborationContext): Promise<ParsedUpdateBody> {
  const contentLengthHeader = c.req.header("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      return { ok: false, status: 400, error: "invalid content-length" };
    }
    if (contentLength > MAX_UPDATE_REQUEST_BYTES) {
      return { ok: false, status: 413, error: "update payload too large" };
    }
  }

  const stream = c.req.raw.body;
  if (!stream) return { ok: false, status: 400, error: "invalid collaboration update" };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_UPDATE_REQUEST_BYTES) {
      await reader.cancel();
      return { ok: false, status: 413, error: "update payload too large" };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, status: 400, error: "invalid collaboration update" };
  }

  const result = collaborationDocumentUpdateInputSchema.safeParse(body);
  if (!result.success) {
    return { ok: false, status: 400, error: "invalid collaboration update" };
  }
  return { ok: true, data: result.data };
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

collaborationRoute.post("/rooms", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) return c.json({ error: "not signed in" }, 401);

  const parsed = await parseUpdateBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

  const realtimeResult = getRealtime(c);
  if (!realtimeResult.ok) return realtimeResult.response;

  const room = await createProvisioningCollaborationRoom(c.env.DB, {
    ownerId: user.id,
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  });
  const event = eventFor(parsed.data, room.id, user.id);

  try {
    await realtimeResult.realtime
      .channel(collaborationRoomChannel(room.id))
      .emit("document.update", event);
  } catch (error) {
    await setCollaborationRoomStatus(c.env.DB, room.id, "failed");
    console.error("Failed to seed collaboration room", {
      roomId: room.id,
      updateId: event.updateId,
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

  const realtimeResult = getRealtime(c);
  if (!realtimeResult.ok) return realtimeResult.response;

  const event = eventFor(parsed.data, access.id, user.id);
  try {
    await realtimeResult.realtime
      .channel(collaborationRoomChannel(access.id))
      .emit("document.update", event);
  } catch (error) {
    console.error("Failed to publish collaboration update", {
      roomId: access.id,
      updateId: event.updateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "failed to publish collaboration update" }, 503);
  }

  return c.json({ accepted: true, updateId: event.updateId }, 202);
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
