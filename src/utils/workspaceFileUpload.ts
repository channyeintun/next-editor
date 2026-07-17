import {
  getWorkspaceFileMimeType,
  isBinaryWorkspacePath,
  type WorkspaceFileContent,
  type WorkspaceFileEncoding,
} from "../types/workspace";
import { registerWorkspaceAsset } from "../storage/workspaceAssetStore";

/**
 * Largest local asset we accept into a workspace. Bytes persist to IndexedDB
 * (which has no ~5 MB localStorage quota), so this cap bounds browser/runtime
 * work rather than a base64 or localStorage representation.
 */
export const MAX_WORKSPACE_ASSET_BYTES = 50 * 1024 * 1024;

export interface UploadedWorkspaceFile {
  content: WorkspaceFileContent;
  encoding?: WorkspaceFileEncoding;
}

// Text-ish MIME types that lack a text/* prefix but should still be read as text.
const TEXT_LIKE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/typescript",
  "image/svg+xml",
]);

/** Decide whether a picked/dropped file should be stored as bytes or text. */
export function shouldReadAsBinary(file: { name: string; type: string }): boolean {
  if (isBinaryWorkspacePath(file.name)) {
    return true;
  }

  const mimeType = file.type;

  if (!mimeType) {
    // Unknown/extensionless files default to text so source files stay editable.
    return false;
  }

  if (mimeType.startsWith("text/") || TEXT_LIKE_MIME_TYPES.has(mimeType)) {
    return false;
  }

  return true;
}

/**
 * Read a picked/dropped File into a workspace-ready payload, choosing a binary
 * asset-descriptor or text representation based on extension and MIME type.
 */
export async function readUploadedWorkspaceFile(file: File): Promise<UploadedWorkspaceFile> {
  if (shouldReadAsBinary(file)) {
    const buffer = await file.arrayBuffer();

    const content = await registerWorkspaceAsset(new Uint8Array(buffer), {
      mimeType: file.type || getWorkspaceFileMimeType(file.name),
    });
    return { content, encoding: "asset" };
  }

  return { content: await file.text() };
}
