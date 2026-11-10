import type { Tool } from "@openrouter/agent";
import type { WorkspaceExecutionKind } from "../../types/lessonTypes";
import {
  areWorkspaceBoundariesEqual,
  getWorkspaceBoundary,
  type WorkspaceBoundary,
} from "../../stores/workspaceStore";
import type { ToolContext } from "../types";
import { makeReadTool } from "./read";
import { makeWriteTool } from "./write";
import { makeEditTool } from "./edit";
import { makeLsTool } from "./ls";
import { makeGlobTool } from "./glob";
import { makeGrepTool } from "./grep";
import { makeBashTool } from "./bash";
import { makeRuntimeDiagnosticsTool } from "./runtimeDiagnostics";
import { makeInspectPreviewTool } from "./inspectPreview";
import { makeCapturePreviewTool } from "./capturePreview";

// The third entry scopes each tool to an execution kind: file tools are available
// everywhere, while shell/runtime/preview observation only exists where the
// WebContainer runtime does. Every Playground lesson runs its code on an explicit
// Run — remotely for Go, Kotlin, Rust, Zig and Haskell, in-page for Kite and
// assembly — so each of them gets the same file-tools-only profile.
const CODING_TOOL_DEFINITIONS = [
  ["read", makeReadTool, "all"],
  ["ls", makeLsTool, "all"],
  ["glob", makeGlobTool, "all"],
  ["grep", makeGrepTool, "all"],
  ["runtime_diagnostics", makeRuntimeDiagnosticsTool, "webcontainer"],
  ["inspect_preview", makeInspectPreviewTool, "webcontainer"],
  ["capture_preview", makeCapturePreviewTool, "webcontainer"],
  ["write", makeWriteTool, "all"],
  ["edit", makeEditTool, "all"],
  ["bash", makeBashTool, "webcontainer"],
] as const;

function codingToolDefinitionsFor(executionKind: WorkspaceExecutionKind) {
  return CODING_TOOL_DEFINITIONS.filter(
    ([, , scope]) => scope === "all" || scope === executionKind,
  );
}

export function codingToolNamesFor(executionKind: WorkspaceExecutionKind): string[] {
  return codingToolDefinitionsFor(executionKind).map(([name]) => name);
}

/** What a tool reports to the model instead of acting, once the run was stopped. */
export const ABORTED_TOOL_OUTPUT = "The run was stopped before this tool ran; nothing was changed.";

/** What a tool reports instead of acting on a workspace that replaced the run's. */
export const WORKSPACE_REPLACED_TOOL_OUTPUT =
  "The workspace this run started on was replaced by another project; nothing was changed.";

/**
 * Refuse every tool call once the run is aborted.
 *
 * The run's signal stops the SDK's tool loop only at a turn boundary: a round it
 * has already dispatched still invokes these `execute` closures after Stop (the
 * SDK checks the signal between turns and on in-flight requests, not before each
 * tool body). This guard is what refuses them, which is what keeps a stopped run
 * from writing files the transcript never records. Applied to every tool rather
 * than just the mutating ones so a tool added later inherits it, and so a stopped
 * run stops spending on side effects at all.
 *
 * Also refuse a call on a workspace other than `runWorkspace`, the one the run
 * started on. The store is shared and mutable: a lesson, recording or import
 * loaded during the run replaces its project in place, and a write steered by the
 * old project's files would land in the new one. The session aborts the run when
 * that happens; this check holds even for a tool set used without the session.
 */
function guardToolOnAbort(ctx: ToolContext, runWorkspace: WorkspaceBoundary, tool: Tool): Tool {
  // `tool()` returns a fresh plain `{ type, function }` object per call (tools are
  // built per run, never shared), so wrapping in place cannot leak across runs.
  const fn = (tool as { function?: { execute?: (...args: never[]) => unknown } }).function;
  const execute = fn?.execute;
  if (!fn || typeof execute !== "function") {
    return tool;
  }
  fn.execute = (...args: never[]) => {
    if (ctx.signal.aborted) {
      return ABORTED_TOOL_OUTPUT;
    }
    if (
      !areWorkspaceBoundariesEqual(
        runWorkspace,
        getWorkspaceBoundary(ctx.workspace.getSnapshot().context),
      )
    ) {
      return WORKSPACE_REPLACED_TOOL_OUTPUT;
    }
    return execute.apply(fn, args);
  };
  return tool;
}

/**
 * Builds the coding tool set for a run, bound to the workspace the store holds
 * now. Each tool's `execute` closes over `ctx` (workspace store, abort signal,
 * confirmation gate), so tools are created per run rather than shared as
 * singletons — that's what lets the `bash` tool await the user's confirmation
 * inline inside its own `execute`.
 */
export function createCodingTools(ctx: ToolContext, executionKind: WorkspaceExecutionKind): Tool[] {
  const runWorkspace = getWorkspaceBoundary(ctx.workspace.getSnapshot().context);
  return codingToolDefinitionsFor(executionKind).map(([, createTool]) =>
    guardToolOnAbort(ctx, runWorkspace, createTool(ctx) as unknown as Tool),
  );
}
