import type { Tool } from "@openrouter/agent";
import type { ToolContext } from "../types";
import { makeReadTool } from "./read";
import { makeWriteTool } from "./write";
import { makeEditTool } from "./edit";
import { makeLsTool } from "./ls";
import { makeGlobTool } from "./glob";
import { makeGrepTool } from "./grep";
import { makeBashTool } from "./bash";

export {
  makeReadTool,
  makeWriteTool,
  makeEditTool,
  makeLsTool,
  makeGlobTool,
  makeGrepTool,
  makeBashTool,
};

/**
 * Builds the default coding tool set for a run. Each tool's `execute` closes over
 * `ctx` (workspace store, abort signal, confirmation gate), so tools are created
 * per run rather than shared as singletons — that's what lets the `bash` tool
 * await the user's confirmation inline inside its own `execute`.
 */
export function createCodingTools(ctx: ToolContext): Tool[] {
  return [
    makeReadTool(ctx),
    makeLsTool(ctx),
    makeGlobTool(ctx),
    makeGrepTool(ctx),
    makeWriteTool(ctx),
    makeEditTool(ctx),
    makeBashTool(ctx),
  ] as unknown as Tool[];
}
