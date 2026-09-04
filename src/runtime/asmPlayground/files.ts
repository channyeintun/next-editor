import { isWorkspaceTextFile, type WorkspaceProject } from "../../types/workspace";
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
  return Object.values(project.files)
    .filter(isWorkspaceTextFile)
    .filter((file) => SOURCE_EXTENSIONS.some((extension) => file.path.endsWith(extension)))
    .sort((left, right) => {
      if (left.path === ASM_ENTRY_PATH) return right.path === ASM_ENTRY_PATH ? 0 : -1;
      if (right.path === ASM_ENTRY_PATH) return 1;
      return left.path.localeCompare(right.path);
    })
    .map((file) => ({ path: file.path, content: file.content }));
}
