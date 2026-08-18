import type { Tool } from "@openrouter/agent";
import type { WorkspaceExecutionKind } from "../../types/workspace";
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
// Run — remotely for Go, Kotlin and Rust, in-page for Kite — so each of them gets
// the same file-tools-only profile.
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

export {
  makeReadTool,
  makeWriteTool,
  makeEditTool,
  makeLsTool,
  makeGlobTool,
  makeGrepTool,
  makeBashTool,
  makeRuntimeDiagnosticsTool,
  makeInspectPreviewTool,
  makeCapturePreviewTool,
};

/** What a tool reports to the model instead of acting, once the run was stopped. */
export const ABORTED_TOOL_OUTPUT = "The run was stopped before this tool ran; nothing was changed.";

/**
 * Refuse every tool call once the run is aborted.
 *
 * The SDK owns the tool loop and accepts no AbortSignal, and `ModelResult.cancel()`
 * reaches only the first turn's stream — each follow-up turn streams through its own
 * local one. So after Stop the SDK keeps calling the model and keeps invoking these
 * `execute` closures until `stopWhen` is met. This guard is the only place that can
 * refuse them, which is what keeps a stopped run from writing files the transcript
 * never records. Applied to every tool rather than just the mutating ones so a tool
 * added later inherits it, and so a stopped run stops spending on side effects at all.
 */
function guardToolOnAbort(ctx: ToolContext, tool: Tool): Tool {
  // `tool()` returns a fresh plain `{ type, function }` object per call (tools are
  // built per run, never shared), so wrapping in place cannot leak across runs.
  const fn = (tool as { function?: { execute?: (...args: never[]) => unknown } }).function;
  const execute = fn?.execute;
  if (!fn || typeof execute !== "function") {
    return tool;
  }
  fn.execute = (...args: never[]) =>
    ctx.signal.aborted ? ABORTED_TOOL_OUTPUT : execute.apply(fn, args);
  return tool;
}

/**
 * Builds the coding tool set for a run. Each tool's `execute` closes over
 * `ctx` (workspace store, abort signal, confirmation gate), so tools are created
 * per run rather than shared as singletons — that's what lets the `bash` tool
 * await the user's confirmation inline inside its own `execute`.
 */
export function createCodingTools(ctx: ToolContext, executionKind: WorkspaceExecutionKind): Tool[] {
  return codingToolDefinitionsFor(executionKind).map(([, createTool]) =>
    guardToolOnAbort(ctx, createTool(ctx) as unknown as Tool),
  );
}
