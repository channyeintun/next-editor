import type { WorkspaceProject } from "../types/workspace";
import { normalizeWorkspaceFolderPath } from "../types/workspace";

function getArchiveFileName(projectName: string): string {
  const normalizedName = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalizedName || "next-editor-workspace";
}

export async function downloadWorkspaceProjectAsZip(project: WorkspaceProject): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();

  for (const folderPath of project.folders) {
    const normalizedPath = normalizeWorkspaceFolderPath(folderPath);

    if (!normalizedPath) {
      continue;
    }

    zip.folder(normalizedPath);
  }

  for (const file of Object.values(project.files)) {
    zip.file(file.path, file.content);
  }

  const blob = await zip.generateAsync({ type: "blob" });
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
