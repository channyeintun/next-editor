import { isWorkspaceTextFile, type WorkspaceProject } from "../../types/workspace";
import type { GoPlaygroundFile } from "./types";

/** Current editable Go sources in the deterministic order used by the Playground. */
export function collectGoPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): GoPlaygroundFile[] {
  return Object.values(project.files)
    .filter(isWorkspaceTextFile)
    .filter((file) => file.path.endsWith(".go"))
    .sort((left, right) => {
      if (left.path === "main.go") return right.path === "main.go" ? 0 : -1;
      if (right.path === "main.go") return 1;
      return left.path.localeCompare(right.path);
    })
    .map((file) => ({ path: file.path, content: file.content }));
}

/** Exact source snapshot comparison used to prevent stale gofmt overwrites. */
export function areGoPlaygroundFilesEqual(
  left: readonly GoPlaygroundFile[],
  right: readonly GoPlaygroundFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) => file.path === right[index]?.path && file.content === right[index]?.content,
    )
  );
}
