import { describe, expect, it, vi } from "vitest";
import {
  applyCollaborationParticipantEvent,
  getCollaborationFollowAvailability,
  isCollaborationFollowSuspendedConnectionState,
  scheduleCollaborationAwarenessFlush,
  type CollaborationPresenceParticipant,
} from "./followLifecycle";

const OWN_SESSION = "10000000-0000-4000-8000-000000000001";
const TARGET_SESSION = "20000000-0000-4000-8000-000000000002";
const ACTOR_ID = "30000000-0000-4000-8000-000000000003";

function participant(revision: number, expiresAt = 10_000): CollaborationPresenceParticipant {
  return {
    kind: "state",
    roomId: "40000000-0000-4000-8000-000000000004",
    actorId: ACTOR_ID,
    sessionId: TARGET_SESSION,
    revision,
    role: "editor",
    username: "ada",
    name: "Ada",
    avatarUrl: null,
    isHost: false,
    surface: { kind: "editor", fileNodeId: null, viewport: null },
    cursor: null,
    occurredAt: 1,
    expiresAt,
  };
}

describe("collaboration follow lifecycle", () => {
  it("flushes continuous awareness changes once per fixed coalescing window", () => {
    vi.useFakeTimers();
    try {
      let scheduled: ReturnType<typeof setTimeout> | null = null;
      const flush = vi.fn(() => {
        scheduled = null;
      });
      const schedule = () => {
        scheduled = scheduleCollaborationAwarenessFlush(scheduled, flush);
      };

      schedule();
      const firstTimer = scheduled;
      schedule();
      schedule();
      expect(scheduled).toBe(firstTimer);
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(74);
      expect(flush).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(flush).toHaveBeenCalledTimes(1);

      schedule();
      vi.advanceTimersByTime(75);
      expect(flush).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts only the exact present remote session while live", () => {
    expect(
      getCollaborationFollowAvailability({
        followedSessionId: TARGET_SESSION,
        ownSessionId: OWN_SESSION,
        connectionState: "live",
        participantSessionIds: new Set([TARGET_SESSION]),
      }),
    ).toBe("active");
    expect(
      getCollaborationFollowAvailability({
        followedSessionId: OWN_SESSION,
        ownSessionId: OWN_SESSION,
        connectionState: "live",
        participantSessionIds: new Set([OWN_SESSION]),
      }),
    ).toBe("missing");
  });

  it("suspends throughout reconnect and reports target loss after live presence expires", () => {
    for (const connectionState of ["reconnecting", "connecting", "syncing"] as const) {
      expect(isCollaborationFollowSuspendedConnectionState(connectionState)).toBe(true);
      expect(
        getCollaborationFollowAvailability({
          followedSessionId: TARGET_SESSION,
          ownSessionId: OWN_SESSION,
          connectionState,
          participantSessionIds: new Set(),
        }),
      ).toBe("suspended");
    }
    expect(isCollaborationFollowSuspendedConnectionState("live")).toBe(false);
    expect(
      getCollaborationFollowAvailability({
        followedSessionId: TARGET_SESSION,
        ownSessionId: OWN_SESSION,
        connectionState: "live",
        participantSessionIds: new Set(),
      }),
    ).toBe("missing");
  });

  it("does not retain a target after a terminal connection failure", () => {
    expect(
      getCollaborationFollowAvailability({
        followedSessionId: TARGET_SESSION,
        ownSessionId: OWN_SESSION,
        connectionState: "failed",
        participantSessionIds: new Set([TARGET_SESSION]),
      }),
    ).toBe("missing");
  });

  it("ignores stale revisions and applies leave only to the exact actor session", () => {
    const key = `${ACTOR_ID}:${TARGET_SESSION}`;
    const current = new Map([[key, participant(2)]]);
    const stale = applyCollaborationParticipantEvent(current, participant(1), 2);
    expect(stale).toBe(current);
    const staleLeave = applyCollaborationParticipantEvent(
      current,
      {
        kind: "leave",
        roomId: participant(2).roomId,
        actorId: ACTOR_ID,
        sessionId: TARGET_SESSION,
        revision: 1,
        occurredAt: 2,
      },
      2,
    );
    expect(staleLeave).toBe(current);

    const unrelated = participant(1);
    unrelated.sessionId = "50000000-0000-4000-8000-000000000005";
    const withUnrelated = applyCollaborationParticipantEvent(current, unrelated, 2);
    expect(withUnrelated.size).toBe(2);
    expect(withUnrelated.get(key)?.revision).toBe(2);

    const afterLeave = applyCollaborationParticipantEvent(
      withUnrelated,
      {
        kind: "leave",
        roomId: participant(2).roomId,
        actorId: ACTOR_ID,
        sessionId: TARGET_SESSION,
        revision: 3,
        occurredAt: 3,
      },
      3,
    );
    expect(afterLeave.has(key)).toBe(false);
    expect(afterLeave.size).toBe(1);
  });

  it("does not admit already expired presence", () => {
    const current = new Map<string, CollaborationPresenceParticipant>();
    const next = applyCollaborationParticipantEvent(current, participant(1, 5), 5);
    expect(next.size).toBe(0);
  });

  it("treats an equal-revision leave as terminal after revision saturation", () => {
    const saturated = participant(Number.MAX_SAFE_INTEGER);
    const key = `${ACTOR_ID}:${TARGET_SESSION}`;
    const next = applyCollaborationParticipantEvent(
      new Map([[key, saturated]]),
      {
        kind: "leave",
        roomId: saturated.roomId,
        actorId: ACTOR_ID,
        sessionId: TARGET_SESSION,
        revision: Number.MAX_SAFE_INTEGER,
        occurredAt: 2,
      },
      2,
    );

    expect(next.has(key)).toBe(false);
  });
});
