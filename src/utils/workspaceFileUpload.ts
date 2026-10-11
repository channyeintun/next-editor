import type { WorkspaceFileContent, WorkspaceFileEncoding } from "../types/workspace";
import { getWorkspaceFileMimeType, isBinaryWorkspacePath } from "../types/workspaceFiles";
import { registerWorkspaceAsset } from "../storage/workspaceAssetStore";

export interface UploadedWorkspaceFile {
  content: WorkspaceFileContent;
  encoding?: WorkspaceFileEncoding;
}

// How far into a file the NUL check looks, as git's binary check does.
const NUL_SCAN_BYTES = 8192;

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const byteOrderMarkKeepingTextDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface DecodeWorkspaceTextOptions {
  /** Keeps a leading UTF-8 BOM in the text instead of dropping it. */
  keepByteOrderMark?: boolean;
}

/**
 * The text of a file, or null when its bytes are not text: a NUL byte in the
 * first 8 KiB, or anything that is not valid UTF-8. The one rule every importer
 * (a picked or dropped file, a project zip, and the reverse sync reading a
 * WebContainer's files) applies to a file whose extension does not already
 * mark it binary, so none decodes a binary into U+FFFD text. A leading UTF-8
 * BOM is dropped, as the upload decoders before it did, unless the caller
 * keeps it: the reverse sync does, as the container's own text read does.
 */
export function decodeWorkspaceText(
  bytes: Uint8Array,
  { keepByteOrderMark = false }: DecodeWorkspaceTextOptions = {},
): string | null {
  if (bytes.subarray(0, NUL_SCAN_BYTES).includes(0)) {
    return null;
  }

  // A TextDecoder may refuse a view on a SharedArrayBuffer (Chrome's long
  // did), and this cross-origin isolated app can be handed one; that refusal
  // must not read as "not text".
  const decodable =
    typeof SharedArrayBuffer !== "undefined" && bytes.buffer instanceof SharedArrayBuffer
      ? bytes.slice()
      : bytes;
  try {
    return (keepByteOrderMark ? byteOrderMarkKeepingTextDecoder : textDecoder).decode(decodable);
  } catch {
    return null;
  }
}

/**
 * Read a picked/dropped File into a workspace-ready payload: a binary asset
 * descriptor for a binary extension or for bytes that are not text, the text
 * otherwise. File.type does not decide it: Chrome on macOS calls a .ts file
 * video/mp2t, and gives many unknown binaries no type at all.
 */
export async function readUploadedWorkspaceFile(file: File): Promise<UploadedWorkspaceFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = isBinaryWorkspacePath(file.name) ? null : decodeWorkspaceText(bytes);

  if (text === null) {
    const content = await registerWorkspaceAsset(bytes, {
      mimeType: file.type || getWorkspaceFileMimeType(file.name),
    });
    return { content, encoding: "asset" };
  }

  return { content: text };
}
