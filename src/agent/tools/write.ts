import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { ToolContext } from "../types";
import { writeFile } from "./workspaceFs";

const inputSchema = z.object({
  path: z.string().describe("Workspace-relative file path"),
  content: z.string().describe("Full file content"),
});

export function makeWriteTool(ctx: ToolContext) {
  return tool({
    name: "write",
    description:
      "Write a file in the workspace, creating it if it doesn't exist or overwriting it if it " +
      "does. Parent folders are created automatically.",
    inputSchema,
    execute: (input): string => {
      const { created } = writeFile(ctx.workspace, input.path, input.content);
      const byteCount = new TextEncoder().encode(input.content).length;
      return `${created ? "Created" : "Updated"} ${input.path} (${byteCount} bytes)`;
    },
  });
}
