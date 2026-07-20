import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { ToolContext, ToolOutputContent } from "../types";
import {
  bytesToBase64,
  getWorkspaceFileMimeType,
  isBinaryWorkspacePath,
  isLegacyWorkspaceBinaryFile,
  isWorkspaceAssetFile,
} from "../../types/workspace";
import { getWorkspaceAssetBytes } from "../../storage/workspaceAssetStore";
import { toRichToolModelOutput } from "./modelOutput";
import { readFile } from "./workspaceFs";

const MAX_LINES = 2000;
const EMBEDDABLE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const inputSchema = z.object({
  path: z.string().describe("Workspace-relative file path"),
  offset: z.number().optional().describe("0-based line number to start reading from"),
  limit: z.number().optional().describe("Maximum number of lines to read"),
});

function readText(content: string, offset?: number, limit?: number): string {
  const lines = content.split("\n");
  const start = Math.max(0, offset ?? 0);
  const end = Math.min(lines.length, start + (limit ?? MAX_LINES));
  const sliced = lines.slice(start, end);
  const truncatedNote =
    end < lines.length ? `\n… truncated (${lines.length - end} more lines)` : "";

  return sliced.map((line, index) => `${start + index + 1}\t${line}`).join("\n") + truncatedNote;
}

export function makeReadTool(ctx: ToolContext) {
  return tool({
    name: "read",
    description:
      "Read a workspace file's contents. Text files are returned with line numbers; images are " +
      "returned inline; other binary files return a short note instead of their bytes.",
    inputSchema,
    execute: async (input): Promise<string | ToolOutputContent[]> => {
      const file = readFile(ctx.workspace, input.path);

      if (!file) {
        return `File not found: ${input.path}`;
      }

      if (isWorkspaceAssetFile(file) || isLegacyWorkspaceBinaryFile(file)) {
        const mimeType = isWorkspaceAssetFile(file)
          ? file.content.mimeType
          : getWorkspaceFileMimeType(file.path);

        if (EMBEDDABLE_IMAGE_MIME_TYPES.has(mimeType)) {
          const content = isWorkspaceAssetFile(file)
            ? bytesToBase64(await getWorkspaceAssetBytes(file.content))
            : file.content;
          return [
            {
              type: "input_image",
              imageUrl: `data:${mimeType};base64,${content}`,
              detail: "auto",
            },
          ];
        }

        return `${input.path} is a binary file (${mimeType}) and cannot be displayed as text.`;
      }

      if (isBinaryWorkspacePath(file.path)) {
        return `${input.path} is a binary file and cannot be displayed as text.`;
      }

      return readText(file.content, input.offset, input.limit);
    },
    toModelOutput: ({ output }) => toRichToolModelOutput(output),
  });
}
