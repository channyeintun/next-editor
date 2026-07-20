import { describe, expect, it } from "vitest";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import {
  createWorkspaceStore,
  selectWorkspaceLoadVersion,
  selectWorkspaceProjectId,
  type StoredWorkspaceSnapshot,
} from "../stores/workspaceStore";
import { getAgentStore } from "./agentStore";
import { getAgentSessionStore, selectCanRetry, synchronizeAgentWorkspace } from "./agentSession";

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
