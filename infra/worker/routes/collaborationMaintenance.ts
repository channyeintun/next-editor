import { Hono } from "hono";
import type { Context } from "hono";
import {
  deleteCollaborationRoomAssetRegistrations,
  getCollaborationRoomById,
  markCollaborationRoomPurged,
} from "../../db/collaborationQueries";
import { deleteCollaborationRoomAssets } from "../collaboration/assetStore";
import {
  COLLABORATION_ROOM_RETENTION_MS,
  collaborationMaintenanceDestination,
  collaborationMaintenanceJobSchema,
  verifyQStashSignature,
} from "../collaboration/qstash";
import { deleteCollaborationRoomSqliteDocument } from "../collaboration/roomDurableObject";
import type { Env } from "../env";
import { readBytesWithLimit } from "../httpBody";
import { scheduleAuditEvent } from "./collaborationSideEffects";

const MAX_MAINTENANCE_REQUEST_BYTES = 2 * 1024;

/** The body as strict UTF-8: the maintenance job's signature covers exact text. */
async function readBoundedText<E extends { Bindings: Env }>(
  c: Context<E>,
  maxBytes: number,
): Promise<{ ok: true; body: string } | { ok: false; status: 400 | 413 }> {
  const body = await readBytesWithLimit(c.req.raw, maxBytes);
  if (body.status === "too-large") return { ok: false, status: 413 };
  if (body.status === "read-error") return { ok: false, status: 400 };
  try {
    return { ok: true, body: new TextDecoder("utf-8", { fatal: true }).decode(body.bytes) };
  } catch {
    return { ok: false, status: 400 };
  }
}

// The QStash receiver that purges a closed room once its retention ends. It is
// public: the QStash signature is its only gate. Mounted on collaborationRoute,
// so it answers at /api/collaboration/jobs/maintenance.
export const collaborationMaintenanceRoute = new Hono<{ Bindings: Env }>();

collaborationMaintenanceRoute.post("/jobs/maintenance", async (c) => {
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
    Date.now() < job.data.closedAt + COLLABORATION_ROOM_RETENTION_MS
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
