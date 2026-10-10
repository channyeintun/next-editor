import { strToU8, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import {
  isLegacyWorkspaceBinaryFile,
  isWorkspaceAssetFile,
  type WorkspaceProject,
} from "../types/workspace";
import { normalizeWorkspaceFolderPath } from "../types/workspacePaths";
import { base64ToBytes } from "../shared/base64";
import { getWorkspaceAssetBlob } from "../storage/workspaceAssetStore";
import { downloadBlob } from "./downloadBlob";

function getArchiveFileName(projectName: string): string {
  const normalizedName = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalizedName || "next-editor-workspace";
}

async function streamBlobIntoEntry(blob: Blob, entry: ZipPassThrough): Promise<void> {
  const reader = blob.stream().getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      entry.push(value);
    }
    entry.push(new Uint8Array(0), true);
  } finally {
    reader.releaseLock();
  }
}

export async function downloadWorkspaceProjectAsZip(project: WorkspaceProject): Promise<void> {
  const chunks: Uint8Array[] = [];
  let resolveArchive!: (blob: Blob) => void;
  let rejectArchive!: (error: Error) => void;
  const archive = new Promise<Blob>((resolve, reject) => {
    resolveArchive = resolve;
    rejectArchive = reject;
  });
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      rejectArchive(error);
      return;
    }
    chunks.push(chunk);
    if (final) {
      // A Blob reads each view's own byte range, so fflate's chunks go in as
      // they are instead of being copied into standalone buffers first.
      resolveArchive(new Blob(chunks as BlobPart[], { type: "application/zip" }));
    }
  });

  // Preserve empty folders with explicit directory entries (trailing slash).
  for (const folderPath of project.folders) {
    const normalizedPath = normalizeWorkspaceFolderPath(folderPath);

    if (!normalizedPath) {
      continue;
    }

    const entry = new ZipPassThrough(`${normalizedPath}/`);
    zip.add(entry);
    entry.push(new Uint8Array(0), true);
  }

  for (const file of Object.values(project.files)) {
    if (isWorkspaceAssetFile(file)) {
      const entry = new ZipPassThrough(file.path);
      zip.add(entry);
      await streamBlobIntoEntry(await getWorkspaceAssetBlob(file.content), entry);
      continue;
    }

    if (isLegacyWorkspaceBinaryFile(file)) {
      const entry = new ZipPassThrough(file.path);
      zip.add(entry);
      entry.push(base64ToBytes(file.content), true);
      continue;
    }

    const entry = new ZipDeflate(file.path, { level: 6 });
    zip.add(entry);
    entry.push(strToU8(file.content), true);
  }

  zip.end();
  downloadBlob(await archive, `${getArchiveFileName(project.name)}.zip`);
}
