/**
 * The one glob vocabulary the agent's file tools share (glob's `pattern`,
 * grep's `glob`), so the model sees the same semantics everywhere:
 * `**` followed by `/` matches zero or more whole folders, any other `**`
 * matches any sequence including `/`, `*` matches any sequence except `/`,
 * and `?` matches one character except `/`.
 */
export function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      if (i + 1 < pattern.length && pattern[i + 1] === "*") {
        if (i + 2 < pattern.length && pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[\\]".includes(char)) {
      regex += "\\" + char;
      i++;
    } else {
      regex += char;
      i++;
    }
  }

  return new RegExp(`^${regex}$`);
}

/**
 * Normalizes a tool's folder-prefix argument so `"src"`, `"src/"`, `"/src"`
 * and `"/src/"` all scope to the same folder. Used verbatim, `"src/"` became
 * the prefix `"src//"`, which no workspace path can start with.
 */
export function normalizeFolderPrefix(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/**
 * Whether `filePath` (already known to sit under `baseFolder`, or anywhere
 * when `baseFolder` is empty) matches a compiled glob. The path relative to
 * the folder is tested so `{ path: "src", glob: "*.ts" }` finds `src/a.ts`;
 * the full path is tested too so a workspace-rooted glob like `src/*.ts`
 * still matches when the search is scoped to `src`.
 */
export function matchesWorkspaceGlob(regex: RegExp, filePath: string, baseFolder: string): boolean {
  const relative = baseFolder ? filePath.slice(baseFolder.length + 1) : filePath;
  return regex.test(relative) || regex.test(filePath);
}
