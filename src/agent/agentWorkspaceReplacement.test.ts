import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RunAgentLoopOptions } from "./agentLoop";
import { getAgentStore } from "./agentStore";
import {
  getAgentSessionStore,
  selectCanRetry,
  startAgentRun,
  synchronizeAgentWorkspace,
} from "./agentSession";
import { ABORTED_TOOL_OUTPUT, createCodingTools, WORKSPACE_REPLACED_TOOL_OUTPUT } from "./tools";
import { makeCtx, makeFile, makeProject, makeStore } from "./tools/testUtils";
import { getProject } from "./tools/workspaceFs";
import type { WorkspaceStoreInstance } from "../stores/workspaceStore";
import type { WorkspaceProject } from "../types/workspace";

// The session loads the loop with a dynamic import; the fake stands in for the
// network-bound run, and each test drives the run's tools itself.
const runAgentLoop = vi.hoisted(() => vi.fn<(options: RunAgentLoopOptions) => Promise<void>>());
vi.mock("./agentLoop", () => ({ runAgentLoop }));

type ExecutableTool = {
  function: { name: string; execute: (input: unknown) => unknown };
};

function writeToolFor(ctx: Parameters<typeof createCodingTools>[0]): ExecutableTool {
  const tool = (createCodingTools(ctx, "webcontainer") as unknown as ExecutableTool[]).find(
    (candidate) => candidate.function.name === "write",
  );
  if (!tool) throw new Error("Expected a write tool");
  return tool;
}

function replacementProject(id: string): WorkspaceProject {
  return { ...makeProject([makeFile("index.html", "B")]), id };
}

/** Loads `project` the way a lesson, recording or replayed snapshot does. */
function loadInPlace(store: WorkspaceStoreInstance, project: WorkspaceProject) {
  store.trigger.loadProject({
    project,
    activeFilePath: "index.html",
    savedSnapshot: { activeFilePath: "index.html", project },
  });
}

/**
 * Starts a run on `store` whose loop replaces the workspace through `replace`, then
 * asks its write tool to overwrite index.html, as a model steered by the first
 * workspace's AGENTS.md would. Returns the run's signal and what the write said.
 */
async function runThenReplace(
  store: WorkspaceStoreInstance,
  replace: (workspace: WorkspaceStoreInstance) => void,
) {
  const outcome: { signal: AbortSignal | null; writeResult: unknown } = {
    signal: null,
    writeResult: null,
  };
  runAgentLoop.mockImplementationOnce(async (options) => {
    outcome.signal = options.signal;
    const write = writeToolFor({
      workspace: options.workspace,
      signal: options.signal,
      requestConfirmation: async () => true,
    });
    replace(options.workspace);
    outcome.writeResult = await write.function.execute({
      path: "index.html",
      content: "FROM-RUN-A",
    });
  });

  await startAgentRun({
    apiKey: "sk-or-test",
    model: "test/model",
    workspace: store,
    prompt: "dummy",
    handleChatEvent: () => {},
  });
  return outcome;
}

describe("agent run bound to the workspace it started on", () => {
  beforeEach(() => {
    runAgentLoop.mockReset();
  });

  // A zip import, New Editor or lesson-type switch swaps the project in with
  // reconcileExternalProject, which bumps no load version.
  it("treats a swapped-in project with another id as a new workspace", () => {
    const store = makeStore([makeFile("index.html", "A")]);
    synchronizeAgentWorkspace(store);
    getAgentStore().trigger.applyDelta({
      delta: { k: "message_start", id: "a-msg", role: "assistant" },
    });
    getAgentSessionStore().trigger.setCanRetry({ canRetry: true });

    store.trigger.reconcileExternalProject({ project: replacementProject("imported-b") });

    expect(synchronizeAgentWorkspace(store)).toBe(true);
    expect(getAgentStore().getSnapshot().context.items).toEqual([]);
    expect(selectCanRetry(getAgentSessionStore().getSnapshot().context)).toBe(false);
  });

  it("stops a run whose workspace a swap replaces before its next write", async () => {
    const store = makeStore([makeFile("index.html", "A")]);

    const { signal, writeResult } = await runThenReplace(store, (workspace) => {
      workspace.trigger.reconcileExternalProject({ project: replacementProject("imported-b") });
    });

    expect(signal?.aborted).toBe(true);
    expect(writeResult).toBe(ABORTED_TOOL_OUTPUT);
    expect(getProject(store)?.id).toBe("imported-b");
    expect(getProject(store)?.files["index.html"]?.content).toBe("B");
  });

  // The agent panel, which used to be the only thing that noticed a load, is not
  // mounted while another dock tab is open or the dock is collapsed.
  it("stops a run whose workspace a load replaces while the panel is hidden", async () => {
    const store = makeStore([makeFile("index.html", "A")]);

    const { signal, writeResult } = await runThenReplace(store, (workspace) => {
      loadInPlace(workspace, replacementProject("test"));
    });

    expect(signal?.aborted).toBe(true);
    expect(writeResult).toBe(ABORTED_TOOL_OUTPUT);
    expect(getProject(store)?.files["index.html"]?.content).toBe("B");
  });

  it("keeps running across edits to the same workspace", async () => {
    const store = makeStore([makeFile("index.html", "A")]);

    const { signal, writeResult } = await runThenReplace(store, (workspace) => {
      workspace.trigger.updateFileContent({ path: "index.html", content: "edited" });
    });

    expect(signal?.aborted).toBe(false);
    expect(writeResult).not.toBe(ABORTED_TOOL_OUTPUT);
    expect(getProject(store)?.files["index.html"]?.content).toBe("FROM-RUN-A");
  });

  it("refuses a tool call on a workspace other than the one its run started on", async () => {
    const store = makeStore([makeFile("index.html", "A")]);
    const write = writeToolFor(makeCtx(store));

    loadInPlace(store, replacementProject("test"));

    expect(await write.function.execute({ path: "index.html", content: "FROM-RUN-A" })).toBe(
      WORKSPACE_REPLACED_TOOL_OUTPUT,
    );
    expect(getProject(store)?.files["index.html"]?.content).toBe("B");
  });
});
