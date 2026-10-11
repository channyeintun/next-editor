import { tool } from "@openrouter/agent";
import * as z from "zod";
import type { ToolContext, ToolOutputContent } from "../types";
import { isLegacyWorkspaceBinaryFile, isWorkspaceAssetFile } from "../../types/workspace";
import { getWorkspaceFileMimeType, isBinaryWorkspacePath } from "../../types/workspaceFiles";
import { bytesToBase64 } from "../../shared/base64";
import { getWorkspaceAssetBytes } from "../../storage/workspaceAssetStore";
import { toRichToolModelOutput } from "./modelOutput";
import {
  capOutputLines,
  clipLine,
  MAX_TOOL_LINE_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
} from "./outputLimits";
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
  const numbered = lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}\t${clipLine(line)}`);
  const { text, omittedLines } = capOutputLines(numbered);

  if (omittedLines > 0) {
    const nextLineIndex = end - omittedLines;
    return (
      `${text}\n… truncated at ${MAX_TOOL_OUTPUT_CHARS} characters ` +
      `(${lines.length - nextLineIndex} more lines); continue with offset=${nextLineIndex}`
    );
  }

  const truncatedNote =
    end < lines.length ? `\n… truncated (${lines.length - end} more lines)` : "";
  return text + truncatedNote;
}

export function makeReadTool(ctx: ToolContext) {
  return tool({
    name: "read",
    description:
      "Read a workspace file's contents. Text files are returned with line numbers; images are " +
      "returned inline; other binary files return a short note instead of their bytes. Lines " +
      `longer than ${MAX_TOOL_LINE_CHARS} characters are clipped, so copy edit oldText from ` +
      "short, unclipped lines.",
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
