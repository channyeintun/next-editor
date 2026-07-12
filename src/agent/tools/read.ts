import type { ToolContext, ToolExecuteResult, Tool } from "../types";
import { getWorkspaceFileMimeType, isBinaryWorkspacePath } from "../../types/workspace";
import { readFile } from "./workspaceFs";

const MAX_LINES = 2000;
const EMBEDDABLE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

function readText(content: string, offset?: number, limit?: number): string {
  const lines = content.split("\n");
  const start = Math.max(0, offset ?? 0);
  const end = Math.min(lines.length, start + (limit ?? MAX_LINES));
  const sliced = lines.slice(start, end);
  const truncatedNote =
    end < lines.length ? `\n… truncated (${lines.length - end} more lines)` : "";

  return sliced.map((line, index) => `${start + index + 1}\t${line}`).join("\n") + truncatedNote;
}

async function execute(input: ReadToolInput, ctx: ToolContext): Promise<ToolExecuteResult> {
  const file = readFile(ctx.workspace, input.path);

  if (!file) {
    return { content: `File not found: ${input.path}`, is_error: true };
  }

  if (file.encoding === "base64") {
    const mimeType = getWorkspaceFileMimeType(file.path);

    if (EMBEDDABLE_IMAGE_MIME_TYPES.has(mimeType)) {
      return {
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: file.content,
            },
          },
        ],
      };
    }

    return {
      content: `${input.path} is a binary file (${mimeType}) and cannot be displayed as text.`,
    };
  }

  if (isBinaryWorkspacePath(file.path)) {
    return { content: `${input.path} is a binary file and cannot be displayed as text.` };
  }

  return { content: readText(file.content, input.offset, input.limit) };
}

export const readTool: Tool<ReadToolInput> = {
  name: "read",
  description:
    "Read a workspace file's contents. Text files are returned with line numbers; images are " +
    "returned inline; other binary files return a short note instead of their bytes.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      offset: { type: "number", description: "0-based line number to start reading from" },
      limit: { type: "number", description: "Maximum number of lines to read" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  execute,
};
