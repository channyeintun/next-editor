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

  it("serves a stored text/html object as an inert download", async () => {
    // The stored content-type is replayed to the browser on the app's own
    // origin, so a stored text/html would otherwise execute as first-party
    // script on direct navigation.
    const bucket = {
      get: vi.fn<() => Promise<unknown>>(async () => ({
        body: new Response("<script>alert(1)</script>").body!,
        size: 24,
        httpEtag: '"evil"',
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", "text/html");
        },
      })),
    } as unknown as R2Bucket;

    const response = await mediaRoute.request(
      "https://nexteditor.dev/lessons/abc/evil.png",
      undefined,
      { BUCKET: bucket },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment");
  });

  it("refuses keys outside the public prefixes", async () => {
    // Collaboration room assets share this bucket but have their own
    // membership-checked route; this wildcard must not be a way around it.
    const bucket = {
      get: vi.fn<() => Promise<unknown>>(async () => ({
        body: new Response("private").body!,
        size: 7,
        httpEtag: '"private"',
        writeHttpMetadata() {},
      })),
    } as unknown as R2Bucket;

    const response = await mediaRoute.request(
      "https://nexteditor.dev/collaboration/rooms/room-1/assets/deadbeef",
      undefined,
      { BUCKET: bucket },
    );

    expect(response.status).toBe(404);
    expect(bucket.get).not.toHaveBeenCalled();
  });
});
