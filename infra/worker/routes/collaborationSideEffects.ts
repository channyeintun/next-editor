import type { Context } from "hono";
import type { CollaborationRole } from "../../../src/collaboration/protocol";
import { recordCollaborationAuditEvent } from "../../db/collaborationQueries";
import {
  COLLABORATION_CLEANUP_DELAY,
  publishCollaborationMaintenanceJob,
} from "../collaboration/qstash";
import { notifyCollaborationRoomControl } from "../collaboration/roomDurableObject";
import { notifyCollaborationVoiceRoomControl } from "../collaboration/voiceDurableObject";
import type { Env } from "../env";

// What a collaboration write sets off besides its D1 rows: coordinator
// notifications, audit records and the closed-room purge job. Shared by the
// room API (routes/collaboration.ts) and the maintenance receiver
// (routes/collaborationMaintenance.ts).

/**
 * Tells the room coordinator (and, when voice is deployed, the voice room) that
 * membership changed or the room closed. Throws when delivery fails, so the
 * request fails and the caller can retry.
 */
export async function dispatchControlEvent<E extends { Bindings: Env }>(
  c: Context<E>,
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
  // Removal and room closure are access-revocation events: deliver them
  // before returning so an already-negotiated media path cannot outlive D1
  // membership merely because no further SFU API call is needed. Role-only
  // changes remain best-effort because every gateway call revalidates D1 and
  // voice permission is role-independent.
  if (c.env.COLLABORATION_VOICE_ROOMS) {
    const revokesVoiceAccess = event.kind === "room-closed" || command.targetRole === null;
    if (revokesVoiceAccess) {
      const voiceDelivered = await notifyCollaborationVoiceRoomControl(
        c.env,
        event.roomId,
        command,
      );
      if (!voiceDelivered) throw new Error("collaboration voice coordinator unavailable");
    } else {
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
}

/** Records an audit event after the response, logging instead of failing. */
export function scheduleAuditEvent<E extends { Bindings: Env }>(
  c: Context<E>,
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

/** Queues the delayed purge of a closed room after the response. */
export function scheduleClosedRoomCleanup<E extends { Bindings: Env }>(
  c: Context<E>,
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
