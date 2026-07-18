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
// WebContainer runtime does. Go Playground lessons execute remotely on an explicit
// Run, so their agent gets a file-tools-only profile.
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

/**
 * Builds the coding tool set for a run. Each tool's `execute` closes over
 * `ctx` (workspace store, abort signal, confirmation gate), so tools are created
 * per run rather than shared as singletons — that's what lets the `bash` tool
 * await the user's confirmation inline inside its own `execute`.
 */
export function createCodingTools(ctx: ToolContext, executionKind: WorkspaceExecutionKind): Tool[] {
  return codingToolDefinitionsFor(executionKind).map(([, createTool]) =>
    createTool(ctx),
  ) as unknown as Tool[];
}
