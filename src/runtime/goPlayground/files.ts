import type { WorkspaceProject } from "../../types/workspace";
import { collectPlaygroundFiles, PLAYGROUND_SOURCE_RULES } from "../playgroundFiles";
import type { GoPlaygroundFile } from "./types";

/** Current editable Go sources in the deterministic order used by the Playground. */
export function collectGoPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): GoPlaygroundFile[] {
  return collectPlaygroundFiles(project, PLAYGROUND_SOURCE_RULES.go);
}
