import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { ToolContext } from "../types";
import { readFile, writeFile } from "./workspaceFs";
import { applyEdits, EditApplyError } from "./editDiff";
import { isWorkspaceTextFile } from "../../types/workspace";

const inputSchema = z.object({
  path: z.string().describe("Workspace-relative file path"),
  edits: z
    .array(
      z.object({
        oldText: z.string().describe("Exact text to replace; must be unique in the file"),
        newText: z.string().describe("Replacement text"),
      }),
    )
    .describe("Edits applied in order in a single call"),
});

export function makeEditTool(ctx: ToolContext) {
  return tool({
    name: "edit",
    description:
      "Edit a file by exact text replacement. Each edits[].oldText must match a unique region of " +
      "the file's current content; edits are applied in order in a single call.",
    inputSchema,
    execute: (input): string => {
      const file = readFile(ctx.workspace, input.path);

      if (!file) {
        return `File not found: ${input.path}`;
      }

      if (!isWorkspaceTextFile(file)) {
        return `${input.path} is a binary file and cannot be edited.`;
      }

      if (input.edits.length === 0) {
        return "No edits provided.";
      }

      try {
        const { content, diff } = applyEdits(file.content, input.edits);
        writeFile(ctx.workspace, input.path, content);
        return `Edited ${input.path}:\n${diff}`;
      } catch (error) {
        if (error instanceof EditApplyError) {
          return `${input.path}: ${error.message}`;
        }
        throw error;
      }
    },
  });
}
