import { isWorkspaceTextFile, type WorkspaceProject } from "../../types/workspace";
import type { KitePlaygroundFile } from "./types";

/**
 * Current editable Kite sources in deterministic order.
 *
 * `main.kite` sorts first because it is the file a run compiles. A Kite module
 * is a *directory* and every `.kite` beside the entry is part of the same
 * program, so the rest are collected too — Format touches all of them, and the
 * client says so plainly when a workspace has several and none is named
 * `main.kite`.
 */
export function collectKitePlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): KitePlaygroundFile[] {
  return Object.values(project.files)
    .filter(isWorkspaceTextFile)
    .filter((file) => file.path.endsWith(".kite"))
    .sort((left, right) => {
      if (left.path === "main.kite") return right.path === "main.kite" ? 0 : -1;
      if (right.path === "main.kite") return 1;
      return left.path.localeCompare(right.path);
    })
    .map((file) => ({ path: file.path, content: file.content }));
}

/** Exact source snapshot comparison, used to prevent stale format overwrites. */
export function areKitePlaygroundFilesEqual(
  left: readonly KitePlaygroundFile[],
  right: readonly KitePlaygroundFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) => file.path === right[index]?.path && file.content === right[index]?.content,
    )
  );
}
