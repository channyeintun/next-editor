import type { WorkspaceProject } from "../../types/workspace";
import { collectPlaygroundFiles, PLAYGROUND_SOURCE_RULES } from "../playgroundFiles";
import type { HaskellPlaygroundFile } from "./types";

/**
 * Current editable Haskell sources in deterministic order. The upstream
 * Playground compiles a single module from one source string, so lessons run
 * exactly one `Main.hs` — the runner panel rejects any other shape with a
 * console message before calling the service. The name is capitalized because
 * GHC's diagnostics name `Main.hs`, and a learner matching an error message to
 * a file in the tree should find the same spelling in both.
 *
 * Only `.hs` counts — PLAYGROUND_SOURCE_RULES says why `.lhs` does not.
 */
export function collectHaskellPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): HaskellPlaygroundFile[] {
  return collectPlaygroundFiles(project, PLAYGROUND_SOURCE_RULES.haskell);
}
