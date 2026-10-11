import type { WorkspaceProject } from "../../types/workspace";
import { collectPlaygroundFiles, PLAYGROUND_SOURCE_RULES } from "../playgroundFiles";
import type { KitePlaygroundFile } from "./types";

/**
 * Current editable Kite sources in deterministic order.
 *
 * `main.kite` sorts first because it is the file a run starts from. A Kite
 * module is a *directory* and every `.kite` beside the entry is part of the
 * same program, so the rest are collected too — Format touches all of them, a
 * run compiles them with the entry, and the client says so plainly when a
 * workspace has several and none is named `main.kite`.
 */
export function collectKitePlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): KitePlaygroundFile[] {
  return collectPlaygroundFiles(project, PLAYGROUND_SOURCE_RULES.kite);
}
