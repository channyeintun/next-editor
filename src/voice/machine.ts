import { assign, setup } from "xstate";
import type { VoiceErrorCode } from "../collaboration/voiceProtocol";

// Deterministic lifecycle model for the collaboration voice client. All
// side effects (sockets, WebRTC, microphone, sinks) live in the voice
// engine; the machine only decides which transitions are legal so cleanup
// invariants stay testable without media APIs.
export type VoiceConnectionState =
  | "unavailable"
  | "idle"
  | "joining"
  | "listening"
  | "unmuting"
  | "live"
  | "reconnecting"
  | "failed"
  | "leaving";

export type VoiceUnavailableReason = "unsupported-browser" | "feature-disabled" | "no-room";

// UI-facing failure codes: the sanitized server codes plus client-local
// conditions the engine detects itself.
export type VoiceClientErrorCode =
  | VoiceErrorCode
  | "microphone-permission-denied"
  | "microphone-unavailable"
  | "network";

export interface VoiceMachineContext {
  roomId: string | null;
  unavailableReason: VoiceUnavailableReason | null;
  errorCode: VoiceClientErrorCode | null;
  // Preserved across reconnects so recovery can restore the user's intent
  // without ever unmuting on its own.
  wantsMicrophone: boolean;
}

export type VoiceMachineEvent =
  | { type: "SET_AVAILABLE" }
  | { type: "SET_UNAVAILABLE"; reason: VoiceUnavailableReason }
  | { type: "JOIN"; roomId: string }
  | { type: "READY" }
  | { type: "UNMUTE" }
  | { type: "MUTE" }
  | { type: "PUBLISHED" }
  | { type: "UNMUTE_FAILED"; code: VoiceClientErrorCode }
  | { type: "TRANSPORT_LOST" }
  | { type: "TRANSPORT_RECOVERED"; publishing: boolean }
  | { type: "FAIL"; code: VoiceClientErrorCode }
  | { type: "RETRY" }
  | { type: "LEAVE" }
  | { type: "CLEANUP_DONE" };

const initialContext: VoiceMachineContext = {
  roomId: null,
  unavailableReason: null,
  errorCode: null,
  wantsMicrophone: false,
};

export const voiceMachine = setup({
  types: {
    context: {} as VoiceMachineContext,
    events: {} as VoiceMachineEvent,
  },
  guards: {
    recoveredPublishing: ({ event }) => event.type === "TRANSPORT_RECOVERED" && event.publishing,
  },
  actions: {
    beginJoin: assign(({ event }) => {
      if (event.type !== "JOIN") return {};
      return {
        roomId: event.roomId,
        errorCode: null,
        wantsMicrophone: false,
      };
    }),
    wantMicrophone: assign({ wantsMicrophone: true, errorCode: null }),
    dropMicrophoneIntent: assign({ wantsMicrophone: false }),
    markUnmuteFailed: assign(({ event }) => ({
      wantsMicrophone: false,
      errorCode: event.type === "UNMUTE_FAILED" ? event.code : null,
    })),
    markFailed: assign(({ event }) => ({
      errorCode: event.type === "FAIL" ? event.code : ("internal" as const),
    })),
    clearError: assign({ errorCode: null }),
    markUnavailable: assign(({ event }) => ({
      unavailableReason: event.type === "SET_UNAVAILABLE" ? event.reason : null,
    })),
    reset: assign(({ context }) => ({
      ...initialContext,
      unavailableReason: context.unavailableReason,
    })),
  },
}).createMachine({
  id: "collaborationVoice",
  initial: "unavailable",
  context: initialContext,
  states: {
    unavailable: {
      on: {
        SET_AVAILABLE: {
          target: "idle",
          actions: assign({ unavailableReason: null }),
        },
        SET_UNAVAILABLE: { actions: "markUnavailable" },
      },
    },
    // Idle owns no microphone track, remote sinks, SFU session, coordination
    // socket, or retry timer — the engine asserts this on entry.
    idle: {
      on: {
        JOIN: { target: "joining", actions: "beginJoin" },
        SET_UNAVAILABLE: { target: "unavailable", actions: "markUnavailable" },
      },
    },
    joining: {
      on: {
        READY: { target: "listening", actions: "clearError" },
        FAIL: { target: "failed", actions: "markFailed" },
        LEAVE: "leaving",
        SET_UNAVAILABLE: { target: "leaving", actions: "markUnavailable" },
      },
    },
    listening: {
      on: {
        UNMUTE: { target: "unmuting", actions: "wantMicrophone" },
        TRANSPORT_LOST: "reconnecting",
        FAIL: { target: "failed", actions: "markFailed" },
        LEAVE: "leaving",
        SET_UNAVAILABLE: { target: "leaving", actions: "markUnavailable" },
      },
    },
    unmuting: {
      on: {
        PUBLISHED: "live",
        UNMUTE_FAILED: { target: "listening", actions: "markUnmuteFailed" },
        MUTE: { target: "listening", actions: "dropMicrophoneIntent" },
        TRANSPORT_LOST: "reconnecting",
        FAIL: { target: "failed", actions: "markFailed" },
        LEAVE: "leaving",
        SET_UNAVAILABLE: { target: "leaving", actions: "markUnavailable" },
      },
    },
    live: {
      on: {
        MUTE: { target: "listening", actions: "dropMicrophoneIntent" },
        // Microphone loss (device unplugged/revoked) while publishing.
        UNMUTE_FAILED: { target: "listening", actions: "markUnmuteFailed" },
        TRANSPORT_LOST: "reconnecting",
        FAIL: { target: "failed", actions: "markFailed" },
        LEAVE: "leaving",
        SET_UNAVAILABLE: { target: "leaving", actions: "markUnavailable" },
      },
    },
    reconnecting: {
      on: {
        TRANSPORT_RECOVERED: [
          { guard: "recoveredPublishing", target: "live", actions: "clearError" },
          { target: "listening", actions: "clearError" },
        ],
        // The user may still change mute intent while recovering.
        MUTE: { actions: "dropMicrophoneIntent" },
        UNMUTE: { actions: "wantMicrophone" },
        FAIL: { target: "failed", actions: "markFailed" },
        LEAVE: "leaving",
        SET_UNAVAILABLE: { target: "leaving", actions: "markUnavailable" },
      },
    },
    failed: {
      on: {
        RETRY: {
          target: "joining",
          actions: assign({ errorCode: null, wantsMicrophone: false }),
        },
        LEAVE: "leaving",
        SET_UNAVAILABLE: { target: "leaving", actions: "markUnavailable" },
      },
    },
    leaving: {
      on: {
        CLEANUP_DONE: [
          {
            guard: ({ context }) => context.unavailableReason !== null,
            target: "unavailable",
            actions: "reset",
          },
          { target: "idle", actions: "reset" },
        ],
      },
    },
  },
});
