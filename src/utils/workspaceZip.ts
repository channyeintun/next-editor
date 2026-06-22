import { zipSync, strToU8, type Zippable } from "fflate";
import type { WorkspaceProject } from "../types/workspace";
import { base64ToBytes, normalizeWorkspaceFolderPath } from "../types/workspace";

function getArchiveFileName(projectName: string): string {
  const normalizedName = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalizedName || "next-editor-workspace";
}

export async function downloadWorkspaceProjectAsZip(project: WorkspaceProject): Promise<void> {
  const entries: Zippable = {};

  // Preserve empty folders with explicit directory entries (trailing slash).
  for (const folderPath of project.folders) {
    const normalizedPath = normalizeWorkspaceFolderPath(folderPath);

    if (!normalizedPath) {
      continue;
    }

    entries[`${normalizedPath}/`] = new Uint8Array(0);
  }

  for (const file of Object.values(project.files)) {
    entries[file.path] =
      file.encoding === "base64" ? base64ToBytes(file.content) : strToU8(file.content);
  }

  const blob = new Blob([zipSync(entries)], { type: "application/zip" });
  const downloadUrl = URL.createObjectURL(blob);

  try {
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `${getArchiveFileName(project.name)}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    window.setTimeout(() => {
      URL.revokeObjectURL(downloadUrl);
    }, 1000);
  }
}
