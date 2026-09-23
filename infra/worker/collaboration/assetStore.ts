import { readBytesWithLimit } from "../httpBody";
import { sha256Hex } from "./bytes";
import {
  MAX_COLLABORATION_ASSET_BYTES,
  collaborationAssetDescriptorSchema,
  type CollaborationAssetDescriptor,
} from "../../../src/collaboration/protocol";

const MAX_ASSET_DELETE_PAGES = 100;

function collaborationRoomAssetPrefix(roomId: string): string {
  return `collaboration/rooms/${roomId}/assets/`;
}

export function collaborationAssetKey(roomId: string, assetId: string): string {
  return `${collaborationRoomAssetPrefix(roomId)}${assetId}`;
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
  }

  const body = await readBytesWithLimit(request, MAX_COLLABORATION_ASSET_BYTES);
  if (body.status === "too-large") {
    return { ok: false, status: 413, error: "collaboration asset is too large" };
  }
  if (body.status === "read-error") {
    return { ok: false, status: 400, error: "asset body could not be read" };
  }
  const { bytes } = body;
  const size = bytes.byteLength;
  if (size === 0) return { ok: false, status: 400, error: "asset body is required" };

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
  const prefix = collaborationRoomAssetPrefix(roomId);
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
