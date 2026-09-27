import type { WorkspaceProject } from "../../types/workspace";
import { arePlaygroundFilesEqual, collectPlaygroundFiles } from "../playgroundFiles";
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
  return collectPlaygroundFiles(project, { extensions: [".kite"], entryPath: "main.kite" });
}

/** Exact source snapshot comparison, used to prevent stale format overwrites. */
export const areKitePlaygroundFilesEqual = arePlaygroundFilesEqual;
