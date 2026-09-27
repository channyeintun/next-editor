import { isWorkspaceTextFile, type WorkspaceProject } from "../types/workspace";

/** A lesson source file as every playground client takes it. */
export interface PlaygroundFile {
  path: string;
  content: string;
}

/**
 * The current editable sources with one of `extensions`, in the deterministic
 * order the playgrounds use: `entryPath` first, the rest by path.
 */
export function collectPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
  { extensions, entryPath }: { extensions: readonly string[]; entryPath: string },
): PlaygroundFile[] {
  return Object.values(project.files)
    .filter(isWorkspaceTextFile)
    .filter((file) => extensions.some((extension) => file.path.endsWith(extension)))
    .sort((left, right) => {
      if (left.path === entryPath) return right.path === entryPath ? 0 : -1;
      if (right.path === entryPath) return 1;
      return left.path.localeCompare(right.path);
    })
    .map((file) => ({ path: file.path, content: file.content }));
}

/** Exact source snapshot comparison, used to prevent stale format overwrites. */
export function arePlaygroundFilesEqual(
  left: readonly PlaygroundFile[],
  right: readonly PlaygroundFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) => file.path === right[index]?.path && file.content === right[index]?.content,
    )
  );
}

/**
 * Whether the sources are exactly one file, at `path`: the only lesson a
 * playground that compiles a single source string can run.
 */
export function isSinglePlaygroundFile(files: readonly PlaygroundFile[], path: string): boolean {
  return files.length === 1 && files[0].path === path;
}
