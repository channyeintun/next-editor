import { isWorkspaceTextFile, type WorkspaceProject } from "../../types/workspace";
import type { KotlinPlaygroundFile } from "./types";

/** Current editable Kotlin sources in the deterministic order used by the Playground. */
export function collectKotlinPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): KotlinPlaygroundFile[] {
  return Object.values(project.files)
    .filter(isWorkspaceTextFile)
    .filter((file) => file.path.endsWith(".kt"))
    .sort((left, right) => {
      if (left.path === "Main.kt") return right.path === "Main.kt" ? 0 : -1;
      if (right.path === "Main.kt") return 1;
      return left.path.localeCompare(right.path);
    })
    .map((file) => ({ path: file.path, content: file.content }));
}
