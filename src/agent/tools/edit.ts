import type { ToolContext, ToolExecuteResult, Tool } from "../types";
import { readFile, writeFile } from "./workspaceFs";
import { applyEdits, EditApplyError, type EditOperation } from "./editDiff";

export interface EditToolInput {
  path: string;
  edits: EditOperation[];
}

async function execute(input: EditToolInput, ctx: ToolContext): Promise<ToolExecuteResult> {
  const file = readFile(ctx.workspace, input.path);

  if (!file) {
    return { content: `File not found: ${input.path}`, is_error: true };
  }

  if (file.encoding === "base64") {
    return { content: `${input.path} is a binary file and cannot be edited.`, is_error: true };
  }

  if (input.edits.length === 0) {
    return { content: "No edits provided.", is_error: true };
  }

  try {
    const { content, diff } = applyEdits(file.content, input.edits);
    writeFile(ctx.workspace, input.path, content);
    return { content: `Edited ${input.path}:\n${diff}` };
  } catch (error) {
    if (error instanceof EditApplyError) {
      return { content: `${input.path}: ${error.message}`, is_error: true };
    }
    throw error;
  }
}

export const editTool: Tool<EditToolInput> = {
  name: "edit",
  description:
    "Edit a file by exact text replacement. Each edits[].oldText must match a unique region of " +
    "the file's current content; edits are applied in order in a single call.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: {
              type: "string",
              description: "Exact text to replace; must be unique in the file",
            },
            newText: { type: "string", description: "Replacement text" },
          },
          required: ["oldText", "newText"],
          additionalProperties: false,
        },
      },
    },
    required: ["path", "edits"],
    additionalProperties: false,
  },
  execute,
};
