import type { ToolContext, ToolExecuteResult, Tool } from "../types";
import { getProject } from "./workspaceFs";

export interface GlobToolInput {
  pattern: string;
  path?: string;
  limit?: number;
}

function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      if (i + 1 < pattern.length && pattern[i + 1] === "*") {
        if (i + 2 < pattern.length && pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
          continue;
        } else if (i + 2 === pattern.length) {
          regex += ".*";
          i += 2;
          continue;
        }
      }
      regex += "[^/]*";
      i += 1;
    } else if (char === "?") {
      regex += "[^/]";
      i += 1;
    } else if ("\\^$+.()[]{}|".includes(char)) {
      regex += "\\" + char;
      i += 1;
    } else {
      regex += char;
      i += 1;
    }
  }

  return new RegExp("^" + regex + "$");
}

async function execute(input: GlobToolInput, ctx: ToolContext): Promise<ToolExecuteResult> {
  const project = getProject(ctx.workspace);

  if (!project) {
    return { content: "No workspace loaded.", is_error: true };
  }

  const baseFolder = input.path ? input.path.replace(/^\/+|\/+$/g, "") : "";
  const baseFolderPrefix = baseFolder ? baseFolder + "/" : "";

  let filePaths = Object.keys(project.files);
  if (baseFolder) {
    filePaths = filePaths.filter((p) => p.startsWith(baseFolderPrefix));
  }

  const globRegex = globToRegex(input.pattern);
  const matches: string[] = [];

  for (const filePath of filePaths) {
    const relativeToSearch = baseFolder ? filePath.slice(baseFolderPrefix.length) : filePath;
    if (globRegex.test(relativeToSearch)) {
      matches.push(filePath);
    }
  }

  matches.sort();

  const limit = input.limit ?? 200;
  const truncated = matches.length > limit;
  const displayMatches = matches.slice(0, limit);

  if (displayMatches.length === 0) {
    return { content: "No files matched." };
  }

  let result = displayMatches.join("\n");
  if (truncated) {
    result += `\n... ${matches.length - limit} more matches`;
  }

  return { content: result };
}

export const globTool: Tool<GlobToolInput> = {
  name: "glob",
  description:
    "Search for files in the workspace using a glob pattern. Supports *, **, and ? wildcards. " +
    "Returns matching file paths sorted alphabetically, optionally scoped to a folder.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern to match files (e.g., '**/*.tsx', 'src/*.ts', '*.json'). " +
          "* matches any sequence except /, ** matches any sequence including /, ? matches single char except /.",
      },
      path: {
        type: "string",
        description:
          "Optional folder prefix to scope the search (workspace-relative, no leading/trailing slash)",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default 200)",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  execute,
};
