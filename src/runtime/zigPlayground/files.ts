import { isWorkspaceTextFile, type WorkspaceProject } from "../../types/workspace";
import type { ZigPlaygroundFile } from "./types";

/**
 * Current editable Zig sources in deterministic order. The upstream
 * Playground compiles a single root source file from one text body, so
 * lessons run exactly one `main.zig` — the runner panel rejects any other
 * shape with a console message before calling the service.
 */
export function collectZigPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): ZigPlaygroundFile[] {
  return Object.values(project.files)
    .filter(isWorkspaceTextFile)
    .filter((file) => file.path.endsWith(".zig"))
    .sort((left, right) => {
      if (left.path === "main.zig") return right.path === "main.zig" ? 0 : -1;
      if (right.path === "main.zig") return 1;
      return left.path.localeCompare(right.path);
    })
    .map((file) => ({ path: file.path, content: file.content }));
}

/** Exact source snapshot comparison used to prevent stale `zig fmt` overwrites. */
export function areZigPlaygroundFilesEqual(
  left: readonly ZigPlaygroundFile[],
  right: readonly ZigPlaygroundFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) => file.path === right[index]?.path && file.content === right[index]?.content,
    )
  );
}
