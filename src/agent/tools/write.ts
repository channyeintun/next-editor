import type { ToolContext, ToolExecuteResult, Tool } from "../types";
import type { WorkspaceFileEncoding } from "../../types/workspace";
import { writeFile } from "./workspaceFs";

export interface WriteToolInput {
  path: string;
  content: string;
  encoding?: WorkspaceFileEncoding;
}

async function execute(input: WriteToolInput, ctx: ToolContext): Promise<ToolExecuteResult> {
  const { created } = writeFile(ctx.workspace, input.path, input.content, input.encoding);
  const byteCount = new TextEncoder().encode(input.content).length;

  return {
    content: `${created ? "Created" : "Updated"} ${input.path} (${byteCount} bytes)`,
  };
}

export const writeTool: Tool<WriteToolInput> = {
  name: "write",
  description:
    "Write a file in the workspace, creating it if it doesn't exist or overwriting it if it does. " +
    "Parent folders are created automatically.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  execute,
};
