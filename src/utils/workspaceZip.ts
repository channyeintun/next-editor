import { strToU8, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import {
  base64ToBytes,
  isLegacyWorkspaceBinaryFile,
  isWorkspaceAssetFile,
  normalizeWorkspaceFolderPath,
  type WorkspaceProject,
} from "../types/workspace";
import { getWorkspaceAssetBlob } from "../storage/workspaceAssetStore";

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

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
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
      resolveArchive(new Blob(chunks.map(copyToArrayBuffer), { type: "application/zip" }));
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
  const blob = await archive;
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
