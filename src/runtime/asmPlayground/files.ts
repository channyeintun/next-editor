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

/** Exact source snapshot comparison, used to detect a stale run. */
export function areAsmPlaygroundFilesEqual(
  left: readonly AsmPlaygroundFile[],
  right: readonly AsmPlaygroundFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) => file.path === right[index]?.path && file.content === right[index]?.content,
    )
  );
}
