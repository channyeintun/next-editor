import { createStore } from "@xstate/store-react";
import type { ChatCheckpoint, ChatDelta, ChatMessage, ChatStatus } from "../types/chat";
import { applyChatDelta, INITIAL_CHAT_FOLD_STATE } from "../core/src/utils/chatDelta";
import { DEFAULT_AGENT_MODEL, type AgentModelId } from "./types";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentStoreContext {
  model: AgentModelId;
  messages: ChatMessage[];
  status: ChatStatus;
  error: string | null;
  usage: AgentUsage;
  /** Set by `applyChatSnapshot` during recording playback; null while live (see AgentPanel). */
  replaySnapshot: ChatCheckpoint | null;
}

function initialContext(): AgentStoreContext {
  return {
    model: DEFAULT_AGENT_MODEL,
    messages: INITIAL_CHAT_FOLD_STATE.messages,
    status: INITIAL_CHAT_FOLD_STATE.status,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    replaySnapshot: null,
  };
}

/**
 * Live agent UI state — mirrors `apiClientStore.ts`. `applyDelta` reuses the same
 * `applyChatDelta` reducer the recording replay track folds from (see
 * `core/src/utils/chatDelta.ts`), so the live transcript and a replayed one are
 * built by identical logic.
 */
export function createAgentStore() {
  return createStore({
    context: initialContext(),
    on: {
      setModel: (context, event: { model: AgentModelId }) =>
        event.model === context.model ? context : { ...context, model: event.model },

      applyDelta: (context, event: { delta: ChatDelta }) => {
        const folded = applyChatDelta(
          { messages: context.messages, status: context.status },
          event.delta,
        );
        const usage =
          event.delta.k === "message_end" && event.delta.usage
            ? {
                inputTokens: context.usage.inputTokens + event.delta.usage.input,
                outputTokens: context.usage.outputTokens + event.delta.usage.output,
              }
            : context.usage;

        return { ...context, messages: folded.messages, status: folded.status, usage };
      },

      setError: (context, event: { message: string | null }) => ({
        ...context,
        error: event.message,
      }),

      applyReplaySnapshot: (context, event: { snapshot: ChatCheckpoint | null }) => ({
        ...context,
        replaySnapshot: event.snapshot,
      }),

      reset: (context) => ({ ...initialContext(), model: context.model }),
    },
  });
}

export type AgentStoreInstance = ReturnType<typeof createAgentStore>;

export const selectMessages = (context: AgentStoreContext): ChatMessage[] => context.messages;
export const selectStatus = (context: AgentStoreContext): ChatStatus => context.status;
export const selectError = (context: AgentStoreContext): string | null => context.error;
export const selectUsage = (context: AgentStoreContext): AgentUsage => context.usage;
export const selectModel = (context: AgentStoreContext): AgentModelId => context.model;
export const selectReplaySnapshot = (context: AgentStoreContext): ChatCheckpoint | null =>
  context.replaySnapshot;

let sharedAgentStore: AgentStoreInstance | null = null;

/** App-wide singleton — NextEditorProvider's `applyChatSnapshot` and AgentPanel must share one instance. */
export function getAgentStore(): AgentStoreInstance {
  if (!sharedAgentStore) {
    sharedAgentStore = createAgentStore();
  }

  return sharedAgentStore;
}
