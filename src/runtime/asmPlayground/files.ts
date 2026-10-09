import type { WorkspaceProject } from "../../types/workspace";
import { collectPlaygroundFiles, PLAYGROUND_SOURCE_RULES } from "../playgroundFiles";
import type { AsmPlaygroundFile } from "./types";

/** The one file a run assembles. */
export const ASM_ENTRY_PATH = PLAYGROUND_SOURCE_RULES.asm.entryPath;

/**
 * Current editable assembly sources in deterministic order.
 *
 * `main.asm` sorts first because it is the file a run assembles. The others
 * are collected too so the client can say plainly which one it chose — there is
 * no `%include` here and no linker, so a second file is never part of the same
 * program, and a workspace with several and none named `main.asm` is a question
 * rather than a guess.
 */
export function collectAsmPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): AsmPlaygroundFile[] {
  return collectPlaygroundFiles(project, PLAYGROUND_SOURCE_RULES.asm);
}
