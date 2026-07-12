import { createStore } from "@xstate/store-react";
import { runAgentLoop } from "./agentLoop";
import { getAgentStore } from "./agentStore";
import { createChatRecorder, type ChatEventHandler } from "./chatRecording";
import { CODING_TOOLS } from "./tools";
import type { AgentModelId, ToolConfirmationRequest } from "./types";
import type { WorkspaceStoreInstance } from "../stores/workspaceStore";

export interface PendingConfirmation {
  id: number;
  request: ToolConfirmationRequest;
}

interface AgentSessionContext {
  pending: PendingConfirmation[];
  isRunning: boolean;
}

// Run state that must outlive the AgentPanel component — the panel mounts and
// unmounts as the runner dock switches tabs or collapses, so the abort handle and
// the confirmation resolvers live here (module scope), not in component refs. That
// way switching away mid-run never orphans the Stop control or a pending confirm
// gate; a remounted panel just reconnects to this session. The observable slice
// (pending list, isRunning) is exposed through the store; the resolvers/abort are
// kept as plain refs since they are not renderable state.
let abortController: AbortController | null = null;
const resolvers = new Map<number, (approved: boolean) => void>();
let nextConfirmationId = 0;

const agentSessionStore = createStore({
  context: { pending: [], isRunning: false } as AgentSessionContext,
  on: {
    setRunning: (context, event: { isRunning: boolean }) => ({
      ...context,
      isRunning: event.isRunning,
    }),
    enqueue: (context, event: { item: PendingConfirmation }) => ({
      ...context,
      pending: [...context.pending, event.item],
    }),
    remove: (context, event: { id: number }) => ({
      ...context,
      pending: context.pending.filter((item) => item.id !== event.id),
    }),
    clear: (context) => ({ ...context, pending: [] }),
  },
});

export function getAgentSessionStore() {
  return agentSessionStore;
}

export const selectPending = (context: AgentSessionContext): PendingConfirmation[] =>
  context.pending;
export const selectIsRunning = (context: AgentSessionContext): boolean => context.isRunning;

// Passed to the loop as `requestConfirmation` — enqueues a pending item the panel
// renders and resolves via `resolveConfirmation`.
function requestConfirmation(request: ToolConfirmationRequest): Promise<boolean> {
  return new Promise((resolve) => {
    nextConfirmationId += 1;
    const id = nextConfirmationId;
    resolvers.set(id, resolve);
    agentSessionStore.trigger.enqueue({ item: { id, request } });
  });
}

export function resolveConfirmation(id: number, approved: boolean): void {
  const resolve = resolvers.get(id);
  if (!resolve) {
    return;
  }
  resolvers.delete(id);
  agentSessionStore.trigger.remove({ id });
  resolve(approved);
}

export function stopAgentRun(): void {
  abortController?.abort();
}

export interface StartAgentRunOptions {
  apiKey: string;
  model: AgentModelId;
  workspace: WorkspaceStoreInstance;
  prompt: string;
  handleChatEvent: ChatEventHandler;
}

/** Drives one user turn; no-ops if a run is already in flight (the panel guards on `isRunning`). */
export async function startAgentRun(options: StartAgentRunOptions): Promise<void> {
  if (agentSessionStore.getSnapshot().context.isRunning) {
    return;
  }

  const agentStore = getAgentStore();
  agentStore.trigger.setError({ message: null });

  const controller = new AbortController();
  abortController = controller;
  agentSessionStore.trigger.setRunning({ isRunning: true });

  const history = agentStore.getSnapshot().context.messages;
  const recordChatDelta = createChatRecorder(agentStore, options.handleChatEvent);

  try {
    await runAgentLoop({
      apiKey: options.apiKey,
      model: options.model,
      workspace: options.workspace,
      tools: CODING_TOOLS,
      history,
      prompt: options.prompt,
      signal: controller.signal,
      requestConfirmation,
      onDelta: (delta) => {
        agentStore.trigger.applyDelta({ delta });
        recordChatDelta(delta);
      },
    });
  } catch (error) {
    agentStore.trigger.setError({
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    abortController = null;
    // Settle any confirmation still pending on abort/error as declined, so a tool
    // blocked on `await requestConfirmation` unblocks instead of hanging forever.
    for (const [id, resolve] of resolvers) {
      resolvers.delete(id);
      resolve(false);
    }
    agentSessionStore.trigger.clear();
    agentSessionStore.trigger.setRunning({ isRunning: false });
  }
}
