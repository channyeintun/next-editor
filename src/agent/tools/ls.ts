import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { ToolContext } from "../types";
import { listDir } from "./workspaceFs";

const inputSchema = z.object({
  path: z.string().optional().describe("Workspace-relative directory path; defaults to root"),
  limit: z.number().optional().describe("Maximum entries to return; defaults to 200"),
});

export function makeLsTool(ctx: ToolContext) {
  return tool({
    name: "ls",
    description:
      "List the immediate children (files and folders) of a directory in the workspace. " +
      "Folders are shown with a trailing slash. The listing is alphabetically sorted.",
    inputSchema,
    execute: (input): string => {
      const listing = listDir(ctx.workspace, input.path);
      const limit = input.limit ?? 200;

      const entries: string[] = [];

      for (const file of listing.files) {
        entries.push(file.name);
      }

      for (const folder of listing.folders) {
        const baseName = folder.endsWith("/") ? folder.slice(0, -1) : folder;
        const lastSlash = baseName.lastIndexOf("/");
        const folderName = lastSlash === -1 ? baseName : baseName.slice(lastSlash + 1);
        entries.push(`${folderName}/`);
      }

      entries.sort();

      if (entries.length === 0) {
        return "(empty)";
      }

      const truncated = entries.length > limit;
      const shown = entries.slice(0, limit);

      let output = shown.join("\n");
      if (truncated) {
        const remaining = entries.length - limit;
        output += `\n… ${remaining} more ${remaining === 1 ? "entry" : "entries"}`;
      }

      return output;
    },
  });
}
