import type { CollaborationAwarenessEvent } from "./protocol";

/**
 * The key that identifies one participant: a member's session. A session ID
 * alone is not unique, because each client picks its own and every member sees
 * the others' in awareness, so another member can reuse one.
 */
export function collaborationParticipantKey(
  participant: Pick<CollaborationAwarenessEvent, "actorId" | "sessionId">,
): string {
  return `${participant.actorId}:${participant.sessionId}`;
}
