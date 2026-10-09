import { describe, expect, it, vi } from "vite-plus/test";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import {
  createWorkspaceStore,
  selectWorkspaceLoadVersion,
  selectWorkspaceProjectId,
  type StoredWorkspaceSnapshot,
} from "../stores/workspaceStore";
import type { RunAgentLoopOptions } from "./agentLoop";
import { getAgentStore } from "./agentStore";
import {
  getAgentSessionStore,
  retryAgentRun,
  selectCanRetry,
  startAgentRun,
  synchronizeAgentWorkspace,
} from "./agentSession";
import type { AgentObservers } from "./types";

// The session loads the loop with a dynamic import; the fake stands in for the
// network-bound run and records the options each run was given.
const runAgentLoop = vi.hoisted(() => vi.fn<(options: RunAgentLoopOptions) => Promise<void>>());
vi.mock("./agentLoop", () => ({ runAgentLoop }));

function createStarterSnapshot(): StoredWorkspaceSnapshot {
  const project = createStarterHtmlCssWorkspace();
  return { activeFilePath: project.entryFilePath, project };
}

describe("agent workspace scope", () => {
  it("clears conversation and retry state for a new store or load, even when project IDs match", () => {
    const firstWorkspace = createWorkspaceStore(createStarterSnapshot());
    const secondWorkspace = createWorkspaceStore(createStarterSnapshot());
    const agentStore = getAgentStore();
    const sessionStore = getAgentSessionStore();

    expect(synchronizeAgentWorkspace(firstWorkspace)).toBe(false);
    agentStore.trigger.applyDelta({
      delta: { k: "message_start", id: "old-message", role: "assistant" },
    });
    sessionStore.trigger.setCanRetry({ canRetry: true });

    expect(synchronizeAgentWorkspace(secondWorkspace)).toBe(true);
    expect(agentStore.getSnapshot().context.items).toEqual([]);
    expect(selectCanRetry(sessionStore.getSnapshot().context)).toBe(false);
    expect(selectWorkspaceProjectId(firstWorkspace.getSnapshot().context)).toBe(
      selectWorkspaceProjectId(secondWorkspace.getSnapshot().context),
    );

    agentStore.trigger.applyDelta({
      delta: { k: "message_start", id: "second-old-message", role: "assistant" },
    });
    const replacement = createStarterSnapshot();
    secondWorkspace.trigger.loadProject({
      project: replacement.project,
      activeFilePath: replacement.activeFilePath,
      savedSnapshot: replacement,
    });

    expect(selectWorkspaceLoadVersion(secondWorkspace.getSnapshot().context)).toBe(1);
    expect(synchronizeAgentWorkspace(secondWorkspace)).toBe(true);
    expect(agentStore.getSnapshot().context.items).toEqual([]);
  });
});

describe("agent retry", () => {
  it("repeats a failed run with the same observers the Send carried", async () => {
    const workspace = createWorkspaceStore(createStarterSnapshot());
    const observers: AgentObservers = {
      getRuntimeDiagnostics: vi.fn<NonNullable<AgentObservers["getRuntimeDiagnostics"]>>(),
      getPreviewInspection: vi.fn<NonNullable<AgentObservers["getPreviewInspection"]>>(),
      capturePreviewScreenshot: vi.fn<NonNullable<AgentObservers["capturePreviewScreenshot"]>>(),
    };
    runAgentLoop.mockRejectedValueOnce(new Error("Provider unavailable"));
    runAgentLoop.mockResolvedValueOnce(undefined);

    await startAgentRun({
      apiKey: "sk-or-test",
      model: "test/model",
      workspace,
      prompt: "Add a footer",
      handleChatEvent: () => {},
      observers,
    });
    expect(selectCanRetry(getAgentSessionStore().getSnapshot().context)).toBe(true);

    await retryAgentRun({ apiKey: "sk-or-retry", model: "test/other", workspace });

    expect(runAgentLoop).toHaveBeenCalledTimes(2);
    const retried = runAgentLoop.mock.calls[1]?.[0];
    expect(retried?.observers).toBe(observers);
    expect(retried?.prompt).toBe("Add a footer");
    expect(retried?.apiKey).toBe("sk-or-retry");
    expect(retried?.model).toBe("test/other");
  });
});
