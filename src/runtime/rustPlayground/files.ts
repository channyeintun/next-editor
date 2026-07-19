import { isWorkspaceTextFile, type WorkspaceProject } from "../../types/workspace";
import type { RustPlaygroundFile } from "./types";

/**
 * Current editable Rust sources in deterministic order. The upstream
 * Playground compiles a single crate from one source string, so lessons run
 * exactly one `main.rs` — the runner panel rejects any other shape with a
 * console message before calling the service.
 */
export function collectRustPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): RustPlaygroundFile[] {
  return Object.values(project.files)
    .filter(isWorkspaceTextFile)
    .filter((file) => file.path.endsWith(".rs"))
    .sort((left, right) => {
      if (left.path === "main.rs") return right.path === "main.rs" ? 0 : -1;
      if (right.path === "main.rs") return 1;
      return left.path.localeCompare(right.path);
    })
    .map((file) => ({ path: file.path, content: file.content }));
}

/** Exact source snapshot comparison used to prevent stale rustfmt overwrites. */
export function areRustPlaygroundFilesEqual(
  left: readonly RustPlaygroundFile[],
  right: readonly RustPlaygroundFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) => file.path === right[index]?.path && file.content === right[index]?.content,
    )
  );
}
