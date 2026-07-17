import { describe, expect, it, vi } from "vitest";
import { mediaRoute } from "./media";

describe("mediaRoute", () => {
  it("allows slide images to load from the opaque sandboxed slide iframe", async () => {
    const bucket = {
      get: vi.fn<() => Promise<unknown>>(async () => ({
        body: new Response("image bytes").body!,
        size: 11,
        httpEtag: '"slide-image"',
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", "image/jpeg");
        },
      })),
    } as unknown as R2Bucket;

    const response = await mediaRoute.request(
      "https://nexteditor.dev/slide-images/example",
      undefined,
      { BUCKET: bucket },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });
});
