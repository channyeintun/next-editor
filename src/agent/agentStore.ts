import { createStore } from "@xstate/store-react";
import type { ChatCheckpoint, ChatDelta, ChatImage, ChatItem, ChatStatus } from "../types/chat";
import { applyChatDelta, INITIAL_CHAT_FOLD_STATE } from "../core/src/utils/chatDelta";
import type { WorkspaceStoreInstance } from "../stores/workspaceStore";
import { DEFAULT_AGENT_MODEL, type AgentModelId } from "./types";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentWorkspaceScope {
  workspace: WorkspaceStoreInstance;
  loadVersion: number;
}

export interface AgentStoreContext {
  model: AgentModelId;
  items: ChatItem[];
  status: ChatStatus;
  draft: string;
  draftImages: ChatImage[];
  error: string | null;
  usage: AgentUsage;
  /** Set by `applyChatSnapshot` during recording playback; null while live (see AgentPanel). */
  replaySnapshot: ChatCheckpoint | null;
  /** Loaded workspace generation that owns the live transcript and retry state. */
  workspaceScope: AgentWorkspaceScope | null;
}

function initialContext(): AgentStoreContext {
  return {
    model: DEFAULT_AGENT_MODEL,
    items: INITIAL_CHAT_FOLD_STATE.items,
    status: INITIAL_CHAT_FOLD_STATE.status,
    draft: INITIAL_CHAT_FOLD_STATE.draft,
    draftImages: [],
    error: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    replaySnapshot: null,
    workspaceScope: null,
  };
}

/**
 * Live agent UI state. `applyDelta` reuses the same `applyChatDelta` reducer the
 * recording replay track folds from (see `core/src/utils/chatDelta.ts`), so the
 * live transcript and a replayed one are built by identical logic.
 */
export function createAgentStore() {
  return createStore({
    context: initialContext(),
    on: {
      setModel: (context, event: { model: AgentModelId }) =>
        event.model === context.model ? context : { ...context, model: event.model },

      applyDelta: (context, event: { delta: ChatDelta }) => {
        const folded = applyChatDelta(
          { items: context.items, status: context.status, draft: context.draft },
          event.delta,
        );
        return {
          ...context,
          items: folded.items,
          status: folded.status,
          draft: folded.draft,
        };
      },

      addUsage: (context, event: { usage: AgentUsage }) => ({
        ...context,
        usage: {
          inputTokens: context.usage.inputTokens + event.usage.inputTokens,
          outputTokens: context.usage.outputTokens + event.usage.outputTokens,
        },
      }),

      addDraftImages: (context, event: { images: ChatImage[] }) => ({
        ...context,
        draftImages: [...context.draftImages, ...event.images],
      }),

      removeDraftImage: (context, event: { id: string }) => ({
        ...context,
        draftImages: context.draftImages.filter((image) => image.id !== event.id),
      }),

      clearDraftImages: (context) =>
        context.draftImages.length === 0 ? context : { ...context, draftImages: [] },

      setError: (context, event: { message: string | null }) => ({
        ...context,
        error: event.message,
      }),

      applyReplaySnapshot: (context, event: { snapshot: ChatCheckpoint | null }) => ({
        ...context,
        replaySnapshot: event.snapshot,
      }),

      bindWorkspaceScope: (context, event: { scope: AgentWorkspaceScope }) => ({
        ...context,
        workspaceScope: event.scope,
      }),

      resetForWorkspace: (context, event: { scope: AgentWorkspaceScope }) => ({
        ...initialContext(),
        model: context.model,
        workspaceScope: event.scope,
      }),

      reset: (context) => ({
        ...initialContext(),
        model: context.model,
        workspaceScope: context.workspaceScope,
      }),
    },
  });
}

export type AgentStoreInstance = ReturnType<typeof createAgentStore>;

export const selectItems = (context: AgentStoreContext): ChatItem[] => context.items;
export const selectStatus = (context: AgentStoreContext): ChatStatus => context.status;
export const selectDraft = (context: AgentStoreContext): string => context.draft;
export const selectDraftImages = (context: AgentStoreContext): ChatImage[] => context.draftImages;
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
