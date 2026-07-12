import type { ToolContext, ToolExecuteResult, Tool } from "../types";
import { getProject } from "./workspaceFs";
import { isBinaryWorkspacePath } from "../../types/workspace";

export interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

async function execute(input: GrepToolInput, ctx: ToolContext): Promise<ToolExecuteResult> {
  const project = getProject(ctx.workspace);
  if (!project) {
    return { content: "No workspace loaded.", is_error: true };
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

  let regexPattern = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;

  let regex: RegExp;
  try {
    regex = new RegExp(regexPattern, `g${ignoreCase ? "i" : ""}`);
  } catch (error) {
    return {
      content: `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true,
    };
  }

  // Simple glob-to-regex converter: * = [^/]*, ** = .*, **/ = (?:.*/)?, ? = [^/]
  const globToRegex = (globPattern: string): RegExp => {
    let regexStr = "";
    let i = 0;

    while (i < globPattern.length) {
      const char = globPattern[i];

      if (char === "*") {
        if (i + 1 < globPattern.length && globPattern[i + 1] === "*") {
          if (i + 2 < globPattern.length && globPattern[i + 2] === "/") {
            regexStr += "(?:.*/)?";
            i += 3;
          } else {
            regexStr += ".*";
            i += 2;
          }
        } else {
          regexStr += "[^/]*";
          i++;
        }
      } else if (char === "?") {
        regexStr += "[^/]";
        i++;
      } else if (".+^${}()|[\\]".includes(char)) {
        regexStr += "\\" + char;
        i++;
      } else {
        regexStr += char;
        i++;
      }
    }

    return new RegExp(`^${regexStr}$`);
  };

  const globRegex = glob ? globToRegex(glob) : null;

  const matchLines: string[] = [];
  const sortedPaths = Object.keys(project.files).sort();

  for (const filePath of sortedPaths) {
    if (matchLines.length >= limit) break;

    const file = project.files[filePath];

    if (file.encoding === "base64" || isBinaryWorkspacePath(file.path)) {
      continue;
    }

    if (path && !filePath.startsWith(path + "/")) {
      continue;
    }

    if (globRegex && !globRegex.test(filePath)) {
      continue;
    }

    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matchLines.length >= limit) break;

      const line = lines[i];
      const lineNumber = i + 1;

      if (regex.test(line)) {
        for (let j = Math.max(0, i - context); j < i; j++) {
          matchLines.push(`${filePath}:${j + 1}:${lines[j]}`);
        }

        matchLines.push(`${filePath}:${lineNumber}:${line}`);

        for (let j = i + 1; j <= Math.min(lines.length - 1, i + context); j++) {
          matchLines.push(`${filePath}:${j + 1}:${lines[j]}`);
        }

        regex.lastIndex = 0;
      }
    }
  }

  if (matchLines.length === 0) {
    return { content: "No matches found." };
  }

  const result = matchLines.slice(0, limit).join("\n");
  const truncated = matchLines.length > limit;
  const finalContent = truncated
    ? `${result}\n\n(Results truncated; showing first ${limit} lines)`
    : result;

  return { content: finalContent };
}

export const grepTool: Tool<GrepToolInput> = {
  name: "grep",
  description:
    "Search for lines matching a pattern across workspace files. Supports regex patterns (or literal strings), " +
    "optional path prefix filtering, glob patterns, and context lines.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Search pattern (regex by default, or literal substring if literal=true)",
      },
      path: {
        type: "string",
        description:
          "Optional workspace-relative folder prefix to limit search (no leading/trailing slashes)",
      },
      glob: {
        type: "string",
        description:
          "Optional glob pattern to filter files (* = any except /, ** = any including /)",
      },
      ignoreCase: {
        type: "boolean",
        description: "Case-insensitive search (default false)",
      },
      literal: {
        type: "boolean",
        description: "Treat pattern as literal substring, not regex (default false)",
      },
      context: {
        type: "number",
        description: "Number of context lines to show before/after each match (default 0)",
      },
      limit: {
        type: "number",
        description: "Maximum number of matching lines to return (default 200)",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  execute,
};
