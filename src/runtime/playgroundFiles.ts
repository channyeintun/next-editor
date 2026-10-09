import {
  isWorkspaceTextFile,
  type WorkspaceLessonType,
  type WorkspaceProject,
} from "../types/workspace";
import type { PlaygroundFile } from "./playgroundContract";

export type { PlaygroundFile };

/** The lesson types whose sources a playground runner collects. */
export type PlaygroundSourceLanguage = Extract<
  WorkspaceLessonType,
  "go" | "rust" | "kotlin" | "zig" | "haskell" | "asm" | "kite"
>;

/** The file a language's run starts from, and every extension its sources may carry. */
export interface PlaygroundSourceRule {
  entryPath: string;
  extensions: readonly string[];
}

/**
 * Which workspace files each playground language runs. The runner collectors
 * (src/runtime/<lang>Playground/files.ts) and the zip importer's lesson
 * detection both read this table, so an archive the runner would run is always
 * recognized as that language.
 */
export const PLAYGROUND_SOURCE_RULES: Readonly<
  Record<PlaygroundSourceLanguage, PlaygroundSourceRule>
> = {
  go: { entryPath: "main.go", extensions: [".go"] },
  rust: { entryPath: "main.rs", extensions: [".rs"] },
  kotlin: { entryPath: "Main.kt", extensions: [".kt"] },
  zig: { entryPath: "main.zig", extensions: [".zig"] },
  // `.hs` only: `.lhs` is literate Haskell, a different source format (code
  // lives in `>`-prefixed lines or `\begin{code}` blocks) that the playground
  // does not compile. `endsWith(".hs")` already excludes it, and this comment
  // is here so nobody "fixes" the filter into accepting both.
  haskell: { entryPath: "Main.hs", extensions: [".hs"] },
  // Every extension an assembly source is written with: a single-extension
  // probe would fail to recognize an archive of `.s` files that the runner
  // would then happily assemble.
  asm: { entryPath: "main.asm", extensions: [".asm", ".s", ".nasm"] },
  kite: { entryPath: "main.kite", extensions: [".kite"] },
};

/**
 * The current editable sources with one of `extensions`, in the deterministic
 * order the playgrounds use: `entryPath` first, the rest by path.
 */
export function collectPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
  { extensions, entryPath }: PlaygroundSourceRule,
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
export function isSinglePlaygroundFile(files: readonly { path: string }[], path: string): boolean {
  return files.length === 1 && files[0].path === path;
}

/**
 * The file a run starts from, for a playground that is handed one source: the
 * file named `entryPath` (at the root or in a folder) wins, a single file is the
 * program whatever its name, and otherwise there is no way to tell — "empty"
 * when there are no files, "ambiguous" when there are several and none is
 * named. Each caller turns the two outcomes into its own language's message.
 */
export function pickPlaygroundEntry<File extends { path: string }>(
  files: readonly File[],
  entryPath: string,
): File | "empty" | "ambiguous" {
  if (files.length === 0) return "empty";
  const named = files.find(
    (file) => file.path === entryPath || file.path.endsWith(`/${entryPath}`),
  );
  if (named) return named;
  if (files.length === 1) return files[0];
  return "ambiguous";
}
