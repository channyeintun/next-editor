import { createStore } from "@xstate/store-react";
import { runAgentLoop } from "./agentLoop";
import { getAgentStore, type AgentWorkspaceScope } from "./agentStore";
import { createChatRecorder, type ChatEventHandler } from "./chatRecording";
import type { AgentModelId, ToolConfirmationRequest, ToolContext } from "./types";
import { selectWorkspaceLoadVersion, type WorkspaceStoreInstance } from "../stores/workspaceStore";
import type { ChatImage } from "../types/chat";
import { formatAgentError } from "./agentError";

export interface PendingConfirmation {
  id: number;
  request: ToolConfirmationRequest;
}

interface AgentSessionContext {
  pending: PendingConfirmation[];
  isRunning: boolean;
  canRetry: boolean;
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
let retryOptions: (Omit<StartAgentRunOptions, "apiKey" | "model"> & { fromId?: string }) | null =
  null;

const agentSessionStore = createStore({
  context: { pending: [], isRunning: false, canRetry: false } as AgentSessionContext,
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
    setCanRetry: (context, event: { canRetry: boolean }) => ({
      ...context,
      canRetry: event.canRetry,
    }),
  },
});

export function getAgentSessionStore() {
  return agentSessionStore;
}

export const selectPending = (context: AgentSessionContext): PendingConfirmation[] =>
  context.pending;
export const selectIsRunning = (context: AgentSessionContext): boolean => context.isRunning;
export const selectCanRetry = (context: AgentSessionContext): boolean => context.canRetry;

// Passed to the loop as `requestConfirmation` — enqueues a pending item the panel
// renders and resolves via `resolveConfirmation`.
function requestConfirmation(
  request: ToolConfirmationRequest,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    nextConfirmationId += 1;
    const id = nextConfirmationId;
    let settled = false;
    const onAbort = () => resolveConfirmation(id, false);
    resolvers.set(id, (approved) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(approved);
    });
    agentSessionStore.trigger.enqueue({ item: { id, request } });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      resolveConfirmation(id, false);
    }
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

function settlePendingConfirmations(approved: boolean): void {
  for (const id of resolvers.keys()) {
    resolveConfirmation(id, approved);
  }
  agentSessionStore.trigger.clear();
}

function getWorkspaceScope(workspace: WorkspaceStoreInstance): AgentWorkspaceScope {
  return {
    workspace,
    loadVersion: selectWorkspaceLoadVersion(workspace.getSnapshot().context),
  };
}

function areWorkspaceScopesEqual(
  left: AgentWorkspaceScope | null,
  right: AgentWorkspaceScope,
): boolean {
  return left?.workspace === right.workspace && left.loadVersion === right.loadVersion;
}

function isCurrentWorkspaceScope(scope: AgentWorkspaceScope): boolean {
  return areWorkspaceScopesEqual(getAgentStore().getSnapshot().context.workspaceScope, scope);
}

/**
 * Bind the singleton conversation to one concrete workspace load. A replacement
 * aborts the old run, clears its transcript/retry, and prevents late deltas from
 * leaking into the newly loaded workspace.
 */
export function synchronizeAgentWorkspace(workspace: WorkspaceStoreInstance): boolean {
  const agentStore = getAgentStore();
  const nextScope = getWorkspaceScope(workspace);
  const currentScope = agentStore.getSnapshot().context.workspaceScope;

  if (!currentScope) {
    agentStore.trigger.bindWorkspaceScope({ scope: nextScope });
    return false;
  }

  if (areWorkspaceScopesEqual(currentScope, nextScope)) {
    return false;
  }

  abortController?.abort();
  settlePendingConfirmations(false);
  agentStore.trigger.resetForWorkspace({ scope: nextScope });
  clearAgentRetry();
  return true;
}

export function stopAgentRun(): void {
  abortController?.abort();
  settlePendingConfirmations(false);
}

export interface StartAgentRunOptions {
  apiKey: string;
  model: AgentModelId;
  workspace: WorkspaceStoreInstance;
  prompt: string;
  images?: ChatImage[];
  handleChatEvent: ChatEventHandler;
  getRuntimeDiagnostics?: ToolContext["getRuntimeDiagnostics"];
  getPreviewInspection?: ToolContext["getPreviewInspection"];
  capturePreviewScreenshot?: ToolContext["capturePreviewScreenshot"];
}

export function clearAgentRetry(): void {
  retryOptions = null;
  agentSessionStore.trigger.setCanRetry({ canRetry: false });
}

export async function retryAgentRun(options: {
  apiKey: string;
  model: AgentModelId;
  workspace: WorkspaceStoreInstance;
}): Promise<void> {
  if (
    synchronizeAgentWorkspace(options.workspace) ||
    agentSessionStore.getSnapshot().context.isRunning ||
    !retryOptions
  ) {
    return;
  }

  const retry = retryOptions;
  clearAgentRetry();

  if (retry.fromId) {
    const delta = { k: "remove", fromId: retry.fromId } as const;
    getAgentStore().trigger.applyDelta({ delta });
    retry.handleChatEvent(delta);
  }

  await runAgentRun({ ...retry, ...options });
}

/** Drives one user turn; no-ops if a run is already in flight (the panel guards on `isRunning`). */
export async function startAgentRun(options: StartAgentRunOptions): Promise<void> {
  synchronizeAgentWorkspace(options.workspace);

  if (agentSessionStore.getSnapshot().context.isRunning) {
    return;
  }

  clearAgentRetry();
  await runAgentRun(options);
}

async function runAgentRun(options: StartAgentRunOptions): Promise<void> {
  const agentStore = getAgentStore();
  const workspaceScope = agentStore.getSnapshot().context.workspaceScope;
  if (!workspaceScope) {
    return;
  }
  agentStore.trigger.setError({ message: null });

  const controller = new AbortController();
  abortController = controller;
  agentSessionStore.trigger.setRunning({ isRunning: true });

  const history = agentStore.getSnapshot().context.items;
  const recordChatDelta = createChatRecorder(agentStore, options.handleChatEvent);

  try {
    await runAgentLoop({
      apiKey: options.apiKey,
      model: options.model,
      workspace: options.workspace,
      history,
      prompt: options.prompt,
      images: options.images,
      signal: controller.signal,
      requestConfirmation: (request) => requestConfirmation(request, controller.signal),
      getRuntimeDiagnostics: options.getRuntimeDiagnostics,
      getPreviewInspection: options.getPreviewInspection,
      capturePreviewScreenshot: options.capturePreviewScreenshot,
      onDelta: (delta) => {
        if (!isCurrentWorkspaceScope(workspaceScope)) {
          return;
        }
        agentStore.trigger.applyDelta({ delta });
        recordChatDelta(delta);
      },
      onUsage: (usage) => {
        if (isCurrentWorkspaceScope(workspaceScope)) {
          agentStore.trigger.addUsage({ usage });
        }
      },
    });
  } catch (error) {
    if (!isCurrentWorkspaceScope(workspaceScope)) {
      return;
    }
    agentStore.trigger.setError({
      message: formatAgentError(error),
    });
    const firstTurnItem = agentStore.getSnapshot().context.items[history.length];
    retryOptions = {
      workspace: options.workspace,
      prompt: options.prompt,
      images: options.images,
      handleChatEvent: options.handleChatEvent,
      getRuntimeDiagnostics: options.getRuntimeDiagnostics,
      getPreviewInspection: options.getPreviewInspection,
      capturePreviewScreenshot: options.capturePreviewScreenshot,
      ...(firstTurnItem ? { fromId: firstTurnItem.id } : {}),
    };
    agentSessionStore.trigger.setCanRetry({ canRetry: true });
  } finally {
    if (abortController === controller) {
      abortController = null;
    }
    // Settle any confirmation still pending on abort/error as declined, so a tool
    // blocked on `await requestConfirmation` unblocks instead of hanging forever.
    settlePendingConfirmations(false);
    agentSessionStore.trigger.setRunning({ isRunning: false });
  }
}
