import type Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "../types";
import { readTool } from "./read";
import { writeTool } from "./write";
import { editTool } from "./edit";
import { lsTool } from "./ls";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { bashTool } from "./bash";

export { readTool, writeTool, editTool, lsTool, globTool, grepTool, bashTool };

/** Mirrors pi's `createReadOnlyTools()` — browsing only, no mutation. */
export const READ_ONLY_TOOLS: Tool[] = [readTool, lsTool, globTool, grepTool];

/** Mirrors pi's `createCodingTools()` plus the read-only set — the default registry. */
export const CODING_TOOLS: Tool[] = [...READ_ONLY_TOOLS, writeTool, editTool, bashTool];

export function createToolMap(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

export function toAnthropicToolSchemas(tools: Tool[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
}
