import { assign, setup } from "xstate";
import type {
  CollaborationRole,
  CollaborationRoomDescriptor,
  CollaborationRoomSession,
} from "./protocol";

export type CollaborationConnectionState =
  | "disconnected"
  | "connecting"
  | "syncing"
  | "live"
  | "reconnecting"
  | "failed";

export interface CollaborationMachineContext {
  roomId: string | null;
  sessionId: string | null;
  attemptId: string | null;
  attempt: number;
  room: CollaborationRoomDescriptor | null;
  role: CollaborationRole | null;
  hasOfflineChanges: boolean;
  error: string | null;
}

type AttemptEvent = { sessionId: string; attemptId: string };

export type CollaborationMachineEvent =
  | { type: "CONNECT"; roomId: string; sessionId: string; attemptId: string }
  | ({ type: "PROVIDER_OPEN" } & AttemptEvent)
  | ({ type: "SYNCED"; roomSession: CollaborationRoomSession } & AttemptEvent)
  | ({ type: "DISCONNECTED"; message?: string } & AttemptEvent)
  | ({ type: "FATAL_ERROR"; message: string } & AttemptEvent)
  | { type: "RETRY"; sessionId: string; attemptId: string; attempt: number }
  | { type: "ROLE_CHANGED"; role: CollaborationRole; roleVersion: number }
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
  roomId: null,
  sessionId: null,
  attemptId: null,
  attempt: 0,
  room: null,
  role: null,
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
        roomId: event.roomId,
        sessionId: event.sessionId,
        attemptId: event.attemptId,
        attempt: 0,
        room: null,
        role: null,
        hasOfflineChanges: false,
        error: null,
      };
    }),
    beginRetry: assign(({ event }) => {
      if (event.type !== "RETRY") return {};
      return { attemptId: event.attemptId, attempt: event.attempt, error: null };
    }),
    acceptSession: assign(({ event }) => {
      if (event.type !== "SYNCED") return {};
      return {
        room: event.roomSession.room,
        role: event.roomSession.membership.role,
        hasOfflineChanges: false,
        error: null,
      };
    }),
    markDisconnected: assign(({ event }) => ({
      error: event.type === "DISCONNECTED" ? (event.message ?? null) : null,
    })),
    markFatal: assign(({ event }) => ({
      error: event.type === "FATAL_ERROR" ? event.message : "Collaboration failed",
    })),
    updateRole: assign(({ context, event }) => {
      if (event.type !== "ROLE_CHANGED" || !context.room) return {};
      return {
        role: event.role,
        room: { ...context.room, roleVersion: event.roleVersion },
      };
    }),
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
    ROLE_CHANGED: { actions: "updateRole" },
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
          actions: "acceptSession",
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
