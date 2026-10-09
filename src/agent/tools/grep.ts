import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { ToolContext } from "../types";
import { getProject } from "./workspaceFs";
import { globToRegex, matchesWorkspaceGlob, normalizeFolderPrefix } from "./workspaceGlob";
import { isBinaryWorkspacePath, isWorkspaceTextFile } from "../../types/workspace";

const inputSchema = z.object({
  pattern: z
    .string()
    .describe("Search pattern (regex by default, or literal substring if literal=true)"),
  path: z
    .string()
    .optional()
    .describe("Optional workspace-relative folder prefix to limit search (no slashes)"),
  glob: z.string().optional().describe("Optional glob pattern to filter files"),
  ignoreCase: z.boolean().optional().describe("Case-insensitive search (default false)"),
  literal: z
    .boolean()
    .optional()
    .describe("Treat pattern as literal substring, not regex (default false)"),
  context: z.number().optional().describe("Context lines before/after each match (default 0)"),
  limit: z.number().optional().describe("Maximum number of matching lines to return (default 200)"),
});

export function makeGrepTool(ctx: ToolContext) {
  return tool({
    name: "grep",
    description:
      "Search for lines matching a pattern across workspace files. Supports regex patterns (or " +
      "literal strings), optional path prefix filtering, glob patterns, and context lines.",
    inputSchema,
    execute: (input): string => {
      const project = getProject(ctx.workspace);
      if (!project) {
        return "No workspace loaded.";
      }

      const {
        pattern,
        path,
        glob,
        ignoreCase = false,
        literal = false,
        context = 0,
        limit = 200,
      } = input;

      const regexPattern = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;

      let regex: RegExp;
      try {
        regex = new RegExp(regexPattern, `g${ignoreCase ? "i" : ""}`);
      } catch (error) {
        return `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`;
      }

      const globRegex = glob ? globToRegex(glob) : null;

      const matchLines: string[] = [];
      const basePath = path ? normalizeFolderPrefix(path) : "";
      const sortedPaths = Object.keys(project.files).sort();

      for (const filePath of sortedPaths) {
        if (matchLines.length >= limit) break;

        const file = project.files[filePath];

        if (!isWorkspaceTextFile(file) || isBinaryWorkspacePath(file.path)) {
          continue;
        }

        // Normalized by normalizeFolderPrefix, as glob does. Used verbatim, a natural
        // `"src/"` or `"/src"` became the prefix `"src//"` / `"/src/"`, which no
        // workspace path can start with — so every file was skipped and the tool
        // answered "No matches found.", indistinguishable from a real miss. Do
        // NOT route this through parseWorkspacePath: it throws on a trailing
        // slash, and the empty string it falls back to would silently widen the
        // search to the whole workspace instead of scoping it.
        if (basePath && !filePath.startsWith(basePath + "/")) {
          continue;
        }

        if (globRegex && !matchesWorkspaceGlob(globRegex, filePath, basePath)) {
          continue;
        }

        const lines = file.content.split("\n");
        // The last line index already pushed for this file. Two matches within
        // 2 * context lines share part of their windows; without this the
        // shared lines were pushed twice, misstating the file and eating into
        // `limit`.
        let lastEmitted = -1;
        for (let i = 0; i < lines.length; i++) {
          if (matchLines.length >= limit) break;

          const line = lines[i];
          const lineNumber = i + 1;

          if (regex.test(line)) {
            for (let j = Math.max(lastEmitted + 1, i - context); j < i; j++) {
              matchLines.push(`${filePath}:${j + 1}:${lines[j]}`);
            }

            if (i > lastEmitted) {
              matchLines.push(`${filePath}:${lineNumber}:${line}`);
            }

            const contextEnd = Math.min(lines.length - 1, i + context);
            for (let j = Math.max(lastEmitted + 1, i + 1); j <= contextEnd; j++) {
              matchLines.push(`${filePath}:${j + 1}:${lines[j]}`);
            }
            lastEmitted = contextEnd;

            regex.lastIndex = 0;
          }
        }
      }

      if (matchLines.length === 0) {
        return "No matches found.";
      }

      const result = matchLines.slice(0, limit).join("\n");
      const truncated = matchLines.length > limit;
      return truncated ? `${result}\n\n(Results truncated; showing first ${limit} lines)` : result;
    },
  });
}
