import { assign, setup } from "xstate";

export type RecordingStopReason = "user" | "failure" | "shutdown";

export type RecordingMachineState =
  | "idle"
  | "preparing"
  | "recording"
  | "stopping"
  | "finalizing"
  | "failed";

export type RecordingMachineContext = {
  sessionId: string | null;
  stopReason: RecordingStopReason | null;
  pendingOverloadBytes: number | null;
  failureMessage: string | null;
};

export type RecordingMachineEvent =
  | { type: "START"; sessionId: string }
  | { type: "PREPARED"; sessionId: string; pendingOverloadBytes: number | null }
  | { type: "PREPARE_FAILED"; sessionId: string; message: string }
  | {
      type: "STOP";
      sessionId: string;
      reason: RecordingStopReason;
      overloadBytes?: number;
    }
  | { type: "DRAINED"; sessionId: string }
  | { type: "FINALIZED"; sessionId: string }
  | { type: "FAIL"; sessionId: string; message: string }
  | { type: "CLEANED"; sessionId: string }
  | { type: "ABANDON"; sessionId: string };

const initialContext: RecordingMachineContext = {
  sessionId: null,
  stopReason: null,
  pendingOverloadBytes: null,
  failureMessage: null,
};

function isCurrentSession(context: RecordingMachineContext, event: RecordingMachineEvent): boolean {
  return "sessionId" in event && event.sessionId === context.sessionId;
}

// Extension-owned lifecycle only. This intentionally shares no machine,
// context, event, action, or actor implementation with the main app.
export const recordingCoordinatorMachine = setup({
  types: {
    context: {} as RecordingMachineContext,
    events: {} as RecordingMachineEvent,
  },
  guards: {
    isCurrentSession: ({ context, event }) => isCurrentSession(context, event),
  },
  actions: {
    beginSession: assign(({ event }) => {
      if (event.type !== "START") {
        return {};
      }
      return {
        sessionId: event.sessionId,
        stopReason: null,
        pendingOverloadBytes: null,
        failureMessage: null,
      };
    }),
    acceptPrepared: assign(({ event }) => ({
      pendingOverloadBytes: event.type === "PREPARED" ? event.pendingOverloadBytes : null,
    })),
    beginStop: assign(({ event }) => ({
      stopReason: event.type === "STOP" ? event.reason : null,
      pendingOverloadBytes:
        event.type === "STOP" && event.overloadBytes !== undefined ? event.overloadBytes : null,
    })),
    markFailed: assign(({ event }) => ({
      failureMessage:
        event.type === "FAIL" || event.type === "PREPARE_FAILED"
          ? event.message
          : "recording failed",
    })),
    resetAfterSuccess: assign(() => initialContext),
    resetAfterAbandon: assign(() => initialContext),
    finishFailureCleanup: assign(({ context }) => ({
      ...initialContext,
      // Keep the last failure observable until the next START clears it.
      failureMessage: context.failureMessage,
    })),
  },
}).createMachine({
  id: "nextRecordingCoordinator",
  initial: "idle",
  context: initialContext,
  states: {
    idle: {
      on: {
        START: { target: "preparing", actions: "beginSession" },
      },
    },
    preparing: {
      on: {
        PREPARED: {
          guard: "isCurrentSession",
          target: "recording",
          actions: "acceptPrepared",
        },
        PREPARE_FAILED: {
          guard: "isCurrentSession",
          target: "failed",
          actions: "markFailed",
        },
        FAIL: {
          guard: "isCurrentSession",
          target: "failed",
          actions: "markFailed",
        },
      },
    },
    recording: {
      on: {
        STOP: {
          guard: "isCurrentSession",
          target: "stopping",
          actions: "beginStop",
        },
        FAIL: {
          guard: "isCurrentSession",
          target: "failed",
          actions: "markFailed",
        },
        ABANDON: {
          guard: "isCurrentSession",
          target: "idle",
          actions: "resetAfterAbandon",
        },
      },
    },
    stopping: {
      on: {
        DRAINED: {
          guard: "isCurrentSession",
          target: "finalizing",
        },
        FAIL: {
          guard: "isCurrentSession",
          target: "failed",
          actions: "markFailed",
        },
      },
    },
    finalizing: {
      on: {
        FINALIZED: {
          guard: "isCurrentSession",
          target: "idle",
          actions: "resetAfterSuccess",
        },
        FAIL: {
          guard: "isCurrentSession",
          target: "failed",
          actions: "markFailed",
        },
      },
    },
    failed: {
      on: {
        CLEANED: {
          guard: "isCurrentSession",
          target: "idle",
          actions: "finishFailureCleanup",
        },
      },
    },
  },
});
