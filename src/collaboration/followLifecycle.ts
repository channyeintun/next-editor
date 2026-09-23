import type { CollaborationConnectionState } from "./collaborationMachine";
import { collaborationParticipantKey } from "./participantKey";
import type { CollaborationAwarenessEvent } from "./protocol";

export type CollaborationPresenceParticipant = Extract<
  CollaborationAwarenessEvent,
  { kind: "state" }
>;

export type CollaborationFollowAvailability = "none" | "active" | "suspended" | "missing";

export function isCollaborationFollowSuspendedConnectionState(
  connectionState: CollaborationConnectionState | null | undefined,
): boolean {
  return (
    connectionState === "reconnecting" ||
    connectionState === "connecting" ||
    connectionState === "syncing"
  );
}

export function scheduleCollaborationAwarenessFlush(
  scheduled: ReturnType<typeof setTimeout> | null,
  flush: () => void,
  delayMs = 75,
): ReturnType<typeof setTimeout> {
  return scheduled ?? setTimeout(flush, delayMs);
}

export function applyCollaborationParticipantEvent(
  current: Map<string, CollaborationPresenceParticipant>,
  event: CollaborationAwarenessEvent,
  now = Date.now(),
): Map<string, CollaborationPresenceParticipant> {
  const key = collaborationParticipantKey(event);
  const previous = current.get(key);
  if (
    previous &&
    (previous.revision > event.revision ||
      (previous.revision === event.revision && event.kind === "state"))
  ) {
    return current;
  }
  const next = new Map(current);
  if (event.kind === "leave" || event.expiresAt <= now) next.delete(key);
  else next.set(key, event);
  return next;
}

export function getCollaborationFollowAvailability({
  followedParticipantKey,
  ownParticipantKey,
  connectionState,
  participantKeys,
}: {
  followedParticipantKey: string | null;
  ownParticipantKey: string | null;
  connectionState: CollaborationConnectionState;
  participantKeys: ReadonlySet<string>;
}): CollaborationFollowAvailability {
  if (!followedParticipantKey) return "none";
  if (followedParticipantKey === ownParticipantKey) return "missing";
  if (isCollaborationFollowSuspendedConnectionState(connectionState)) {
    return "suspended";
  }
  if (connectionState !== "live") return "missing";
  return participantKeys.has(followedParticipantKey) ? "active" : "missing";
}
