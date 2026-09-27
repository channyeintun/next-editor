import type { WorkspaceProject } from "../../types/workspace";
import { collectPlaygroundFiles } from "../playgroundFiles";
import type { AsmPlaygroundFile } from "./types";

/** Extensions an assembly source file is written with. */
const SOURCE_EXTENSIONS = [".asm", ".s", ".nasm"];

/** The one file a run assembles. */
export const ASM_ENTRY_PATH = "main.asm";

/**
 * Current editable assembly sources in deterministic order.
 *
 * `main.asm` sorts first because it is the file a run assembles. The others
 * are collected too so the client can say plainly which one it chose — there is
 * no `%include` here and no linker, so a second file is never part of the same
 * program, and a workspace with several and none named `main.asm` is a question
 * rather than a guess.
 *
 * There is no companion `areAsmPlaygroundFilesEqual`: that helper exists only
 * to catch edits that landed while a format request was in flight, and
 * assembly has no formatter.
 */
export function collectAsmPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): AsmPlaygroundFile[] {
  return collectPlaygroundFiles(project, {
    extensions: SOURCE_EXTENSIONS,
    entryPath: ASM_ENTRY_PATH,
  });
}
