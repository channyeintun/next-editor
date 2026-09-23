import { assign, setup } from "xstate";

export type CollaborationConnectionState =
  | "disconnected"
  | "connecting"
  | "syncing"
  | "live"
  | "reconnecting"
  | "failed";

/**
 * Connection lifecycle only. The room session (room descriptor, role, host)
 * lives on CollaborationRoomProvider, which drives this machine; the machine
 * keeps what its guards and the connection UI need.
 */
export interface CollaborationMachineContext {
  sessionId: string | null;
  attemptId: string | null;
  hasOfflineChanges: boolean;
  error: string | null;
}

type AttemptEvent = { sessionId: string; attemptId: string };

export type CollaborationMachineEvent =
  | ({ type: "CONNECT" } & AttemptEvent)
  | ({ type: "PROVIDER_OPEN" } & AttemptEvent)
  | ({ type: "SYNCED" } & AttemptEvent)
  | ({ type: "DISCONNECTED"; message?: string } & AttemptEvent)
  | ({ type: "FATAL_ERROR"; message: string } & AttemptEvent)
  | ({ type: "RETRY" } & AttemptEvent)
  // The provider stored a refreshed room session (e.g. a role change). The
  // machine keeps no copy; the event exists so subscribers re-read the provider.
  | { type: "SESSION_REFRESHED" }
  | { type: "OFFLINE_CHANGES" }
  | { type: "CHANGES_FLUSHED" }
  | { type: "LEAVE" };

function isCurrentAttempt(
  context: CollaborationMachineContext,
  event: CollaborationMachineEvent,
): boolean {
  return (
    "sessionId" in event &&
    "attemptId" in event &&
    event.sessionId === context.sessionId &&
    event.attemptId === context.attemptId
  );
}

const initialContext: CollaborationMachineContext = {
  sessionId: null,
  attemptId: null,
  hasOfflineChanges: false,
  error: null,
};

export const collaborationMachine = setup({
  types: {
    context: {} as CollaborationMachineContext,
    events: {} as CollaborationMachineEvent,
  },
  guards: {
    isCurrentAttempt: ({ context, event }) => isCurrentAttempt(context, event),
    isCurrentRetry: ({ context, event }) =>
      event.type === "RETRY" && event.sessionId === context.sessionId,
  },
  actions: {
    beginSession: assign(({ event }) => {
      if (event.type !== "CONNECT") return {};
      return {
        sessionId: event.sessionId,
        attemptId: event.attemptId,
        hasOfflineChanges: false,
        error: null,
      };
    }),
    beginRetry: assign(({ event }) => {
      if (event.type !== "RETRY") return {};
      return { attemptId: event.attemptId, error: null };
    }),
    clearError: assign({ error: null }),
    markDisconnected: assign(({ event }) => ({
      error: event.type === "DISCONNECTED" ? (event.message ?? null) : null,
    })),
    markFatal: assign(({ event }) => ({
      error: event.type === "FATAL_ERROR" ? event.message : "Collaboration failed",
    })),
    markOfflineChanges: assign({ hasOfflineChanges: true }),
    clearOfflineChanges: assign({ hasOfflineChanges: false }),
    reset: assign(() => initialContext),
  },
}).createMachine({
  id: "collaboration",
  initial: "disconnected",
  context: initialContext,
  on: {
    LEAVE: { target: ".disconnected", actions: "reset" },
    SESSION_REFRESHED: {},
    OFFLINE_CHANGES: { actions: "markOfflineChanges" },
    CHANGES_FLUSHED: { actions: "clearOfflineChanges" },
  },
  states: {
    disconnected: {
      on: {
        CONNECT: { target: "connecting", actions: "beginSession" },
      },
    },
    connecting: {
      on: {
        PROVIDER_OPEN: {
          guard: "isCurrentAttempt",
          target: "syncing",
        },
        DISCONNECTED: {
          guard: "isCurrentAttempt",
          target: "reconnecting",
          actions: "markDisconnected",
        },
        FATAL_ERROR: {
          guard: "isCurrentAttempt",
          target: "failed",
          actions: "markFatal",
        },
      },
    },
    syncing: {
      on: {
        SYNCED: {
          guard: "isCurrentAttempt",
          target: "live",
          actions: "clearError",
        },
        DISCONNECTED: {
          guard: "isCurrentAttempt",
          target: "reconnecting",
          actions: "markDisconnected",
        },
        FATAL_ERROR: {
          guard: "isCurrentAttempt",
          target: "failed",
          actions: "markFatal",
        },
      },
    },
    live: {
      on: {
        DISCONNECTED: {
          guard: "isCurrentAttempt",
          target: "reconnecting",
          actions: "markDisconnected",
        },
        FATAL_ERROR: {
          guard: "isCurrentAttempt",
          target: "failed",
          actions: "markFatal",
        },
      },
    },
    reconnecting: {
      on: {
        RETRY: {
          guard: "isCurrentRetry",
          target: "connecting",
          actions: "beginRetry",
        },
        FATAL_ERROR: {
          guard: "isCurrentAttempt",
          target: "failed",
          actions: "markFatal",
        },
      },
    },
    failed: {
      on: {
        RETRY: {
          guard: "isCurrentRetry",
          target: "connecting",
          actions: "beginRetry",
        },
      },
    },
  },
});

export function collaborationConnectionState(value: unknown): CollaborationConnectionState {
  return typeof value === "string" &&
    ["disconnected", "connecting", "syncing", "live", "reconnecting", "failed"].includes(value)
    ? (value as CollaborationConnectionState)
    : "disconnected";
}
