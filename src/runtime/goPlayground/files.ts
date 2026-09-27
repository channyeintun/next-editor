import type { WorkspaceProject } from "../../types/workspace";
import { arePlaygroundFilesEqual, collectPlaygroundFiles } from "../playgroundFiles";
import type { GoPlaygroundFile } from "./types";

/** Current editable Go sources in the deterministic order used by the Playground. */
export function collectGoPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): GoPlaygroundFile[] {
  return collectPlaygroundFiles(project, { extensions: [".go"], entryPath: "main.go" });
}

/** Exact source snapshot comparison used to prevent stale gofmt overwrites. */
export const areGoPlaygroundFilesEqual = arePlaygroundFilesEqual;
