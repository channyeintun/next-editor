import {
  MAX_COLLABORATION_ASSET_BYTES,
  collaborationAssetDescriptorSchema,
  type CollaborationAssetDescriptor,
} from "../../../src/collaboration/protocol";

const MAX_ASSET_DELETE_PAGES = 100;

export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function collaborationAssetKey(roomId: string, assetId: string): string {
  return `collaboration/rooms/${roomId}/assets/${assetId}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readCollaborationAsset(
  request: Request,
): Promise<
  | { ok: true; bytes: Uint8Array; descriptor: CollaborationAssetDescriptor }
  | { ok: false; status: 400 | 413; error: string }
> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      return { ok: false, status: 400, error: "invalid asset length" };
    }
    if (contentLength > MAX_COLLABORATION_ASSET_BYTES) {
      return { ok: false, status: 413, error: "collaboration asset is too large" };
    }
  }

  if (!request.body) return { ok: false, status: 400, error: "asset body is required" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_COLLABORATION_ASSET_BYTES) {
      await reader.cancel();
      return { ok: false, status: 413, error: "collaboration asset is too large" };
    }
    chunks.push(value);
  }
  if (size === 0) return { ok: false, status: 400, error: "asset body is required" };

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const descriptor = collaborationAssetDescriptorSchema.safeParse({
    id: await sha256Hex(bytes),
    mimeType: contentType || "application/octet-stream",
    size,
  });
  if (!descriptor.success) {
    return { ok: false, status: 400, error: "invalid asset metadata" };
  }
  return { ok: true, bytes, descriptor: descriptor.data };
}

export async function deleteCollaborationRoomAssets(
  bucket: R2Bucket,
  roomId: string,
): Promise<number> {
  const prefix = `collaboration/rooms/${roomId}/assets/`;
  let cursor: string | undefined;
  let deleted = 0;
  for (let page = 0; page < MAX_ASSET_DELETE_PAGES; page += 1) {
    const result = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = result.objects.map((object) => object.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    if (!result.truncated) return deleted;
    cursor = result.cursor;
  }
  throw new Error("collaboration asset cleanup page limit exceeded");
}
