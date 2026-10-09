import type { Recording } from "../core/src";
import { isWorkspaceTextFile } from "../types/workspace";
import { hashWorkspaceFiles } from "./hash";

/** The text files of the recording's final workspace snapshot, by path. */
export function workspaceTextFilesOf(recording: Recording): Record<string, string> {
  const files: Record<string, string> = {};
  const project = recording.workspaceSnapshot?.project;
  if (!project) {
    return files;
  }
  for (const [path, file] of Object.entries(project.files)) {
    if (isWorkspaceTextFile(file)) {
      files[path] = file.content;
    }
  }
  return files;
}

/** Hash of the recording's final workspace text files (repeatability + manifest). */
export async function finalWorkspaceHashOf(recording: Recording): Promise<string> {
  return hashWorkspaceFiles(workspaceTextFilesOf(recording));
}
