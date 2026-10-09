import type { WorkspaceProject } from "../../types/workspace";
import { collectPlaygroundFiles, PLAYGROUND_SOURCE_RULES } from "../playgroundFiles";
import type { KotlinPlaygroundFile } from "./types";

/** Current editable Kotlin sources in the deterministic order used by the Playground. */
export function collectKotlinPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): KotlinPlaygroundFile[] {
  return collectPlaygroundFiles(project, PLAYGROUND_SOURCE_RULES.kotlin);
}
