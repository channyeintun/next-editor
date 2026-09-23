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

  // The route sends `must-revalidate` with an ETag, so every reuse of a cached
  // recording or thumbnail revalidates. R2 evaluates the preconditions when
  // given the request headers and returns the object without a body when the
  // client's copy is current.
  describe("conditional requests", () => {
    const ETAG = '"recording-v1"';

    function conditionalBucket() {
      return {
        get: vi.fn<(key: string, options?: R2GetOptions) => Promise<unknown>>(
          async (_key, options) => {
            const conditions = options?.onlyIf as Headers | undefined;
            const metadata = {
              size: 11,
              httpEtag: ETAG,
              writeHttpMetadata(headers: Headers) {
                headers.set("content-type", "application/octet-stream");
              },
            };
            const ifMatch = conditions?.get("if-match");
            const preconditionFailed =
              conditions?.get("if-none-match") === ETAG ||
              (ifMatch !== null && ifMatch !== undefined && ifMatch !== ETAG);
            return preconditionFailed
              ? metadata
              : { ...metadata, body: new Response("recording").body! };
          },
        ),
      } as unknown as R2Bucket;
    }

    function getRecording(headers: HeadersInit) {
      return mediaRoute.request(
        "https://nexteditor.dev/lessons/abc/abc.ne",
        { headers },
        {
          BUCKET: conditionalBucket(),
        },
      );
    }

    it("answers a current If-None-Match with 304 and no body", async () => {
      const response = await getRecording({ "if-none-match": ETAG });

      expect(response.status).toBe(304);
      expect(response.headers.get("etag")).toBe(ETAG);
      expect(await response.text()).toBe("");
    });

    it("answers a failed If-Match with 412", async () => {
      const response = await getRecording({ "if-match": '"recording-v0"' });

      expect(response.status).toBe(412);
    });

    it("sends the object when the client's copy is stale", async () => {
      const response = await getRecording({ "if-none-match": '"recording-v0"' });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("recording");
    });
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
