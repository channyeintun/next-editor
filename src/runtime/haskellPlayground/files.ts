import type { WorkspaceProject } from "../../types/workspace";
import { collectPlaygroundFiles } from "../playgroundFiles";
import type { HaskellPlaygroundFile } from "./types";

/**
 * Current editable Haskell sources in deterministic order. The upstream
 * Playground compiles a single module from one source string, so lessons run
 * exactly one `Main.hs` — the runner panel rejects any other shape with a
 * console message before calling the service. The name is capitalized because
 * GHC's diagnostics name `Main.hs`, and a learner matching an error message to
 * a file in the tree should find the same spelling in both.
 *
 * Only `.hs` counts: `.lhs` is literate Haskell, a different source format
 * (code lives in `>`-prefixed lines or `\begin{code}` blocks) that the
 * Playground does not accept. `endsWith(".hs")` already excludes it, and this
 * comment is here so nobody "fixes" the filter into accepting both.
 *
 * There is no companion `areHaskellPlaygroundFilesEqual`: that helper exists
 * only to catch edits that landed while a format request was in flight, and
 * the Haskell path has no formatter.
 */
export function collectHaskellPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): HaskellPlaygroundFile[] {
  return collectPlaygroundFiles(project, { extensions: [".hs"], entryPath: "Main.hs" });
}
