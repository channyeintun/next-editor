import { describe, expect, it } from "vitest";
import {
  collaborationAssetKey,
  deleteCollaborationRoomAssets,
  readCollaborationAsset,
  sha256Hex,
} from "./assetStore";

describe("collaboration asset store", () => {
  it("hashes and bounds a private room asset", async () => {
    const bytes = new TextEncoder().encode("hello");
    expect(await sha256Hex(bytes)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    const result = await readCollaborationAsset(
      new Request("https://example.test", {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: new Blob([
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        ]),
      }),
    );
    expect(result).toEqual({
      ok: true,
      bytes,
      descriptor: {
        id: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        mimeType: "image/png",
        size: 5,
      },
    });
    expect(
      collaborationAssetKey(
        "20000000-0000-4000-8000-000000000001",
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      ),
    ).toBe(
      "collaboration/rooms/20000000-0000-4000-8000-000000000001/assets/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("rejects an oversized declared body without reading it", async () => {
    const result = await readCollaborationAsset(
      new Request("https://example.test", {
        method: "PUT",
        headers: { "Content-Length": String(5 * 1024 * 1024 + 1) },
        body: "x",
      }),
    );
    expect(result).toEqual({
      ok: false,
      status: 413,
      error: "collaboration asset is too large",
    });
  });

  it("deletes every paginated asset under only the selected room prefix", async () => {
    const prefixes: string[] = [];
    const deleted: string[][] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        prefixes.push(options.prefix ?? "");
        if (!options.cursor) {
          return {
            objects: [{ key: `${options.prefix}first` }],
            truncated: true,
            cursor: "next-page",
          };
        }
        return {
          objects: [{ key: `${options.prefix}second` }],
          truncated: false,
        };
      },
      delete: async (keys: string[]) => {
        deleted.push(keys);
      },
    } as unknown as R2Bucket;

    await expect(
      deleteCollaborationRoomAssets(bucket, "20000000-0000-4000-8000-000000000001"),
    ).resolves.toBe(2);
    expect(prefixes).toEqual([
      "collaboration/rooms/20000000-0000-4000-8000-000000000001/assets/",
      "collaboration/rooms/20000000-0000-4000-8000-000000000001/assets/",
    ]);
    expect(deleted).toEqual([
      ["collaboration/rooms/20000000-0000-4000-8000-000000000001/assets/first"],
      ["collaboration/rooms/20000000-0000-4000-8000-000000000001/assets/second"],
    ]);
  });
});
