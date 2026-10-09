import type { WorkspaceProject } from "../../types/workspace";
import { collectPlaygroundFiles, PLAYGROUND_SOURCE_RULES } from "../playgroundFiles";
import type { RustPlaygroundFile } from "./types";

/**
 * Current editable Rust sources in deterministic order. The upstream
 * Playground compiles a single crate from one source string, so lessons run
 * exactly one `main.rs` — the runner panel rejects any other shape with a
 * console message before calling the service.
 */
export function collectRustPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): RustPlaygroundFile[] {
  return collectPlaygroundFiles(project, PLAYGROUND_SOURCE_RULES.rust);
}
