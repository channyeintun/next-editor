import type { Tool } from "@openrouter/agent";
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

const CODING_TOOL_DEFINITIONS = [
  ["read", makeReadTool],
  ["ls", makeLsTool],
  ["glob", makeGlobTool],
  ["grep", makeGrepTool],
  ["runtime_diagnostics", makeRuntimeDiagnosticsTool],
  ["inspect_preview", makeInspectPreviewTool],
  ["capture_preview", makeCapturePreviewTool],
  ["write", makeWriteTool],
  ["edit", makeEditTool],
  ["bash", makeBashTool],
] as const;

export const CODING_TOOL_NAMES = CODING_TOOL_DEFINITIONS.map(([name]) => name);

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
 * Builds the default coding tool set for a run. Each tool's `execute` closes over
 * `ctx` (workspace store, abort signal, confirmation gate), so tools are created
 * per run rather than shared as singletons — that's what lets the `bash` tool
 * await the user's confirmation inline inside its own `execute`.
 */
export function createCodingTools(ctx: ToolContext): Tool[] {
  return CODING_TOOL_DEFINITIONS.map(([, createTool]) => createTool(ctx)) as unknown as Tool[];
}
