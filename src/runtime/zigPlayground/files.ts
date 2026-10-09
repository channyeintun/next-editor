import type { WorkspaceProject } from "../../types/workspace";
import { collectPlaygroundFiles } from "../playgroundFiles";
import type { ZigPlaygroundFile } from "./types";

/**
 * Current editable Zig sources in deterministic order. The upstream
 * Playground compiles a single root source file from one text body, so
 * lessons run exactly one `main.zig` — the runner panel rejects any other
 * shape with a console message before calling the service.
 */
export function collectZigPlaygroundFiles(
  project: Pick<WorkspaceProject, "files">,
): ZigPlaygroundFile[] {
  return collectPlaygroundFiles(project, { extensions: [".zig"], entryPath: "main.zig" });
}
