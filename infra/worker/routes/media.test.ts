import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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

  it("serves a stored image/bmp slide image inline", async () => {
    // routes/slideImages.ts stores image/bmp, so the renderable set (derived
    // from the writers' allow-lists) must hand it to the browser as-is.
    const bucket = {
      get: vi.fn<() => Promise<unknown>>(async () => ({
        body: new Response("BM").body!,
        size: 2,
        httpEtag: '"bmp"',
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", "image/bmp");
        },
      })),
    } as unknown as R2Bucket;

    const response = await mediaRoute.request(
      `https://nexteditor.dev/slide-images/${"a".repeat(64)}`,
      undefined,
      { BUCKET: bucket },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/bmp");
    expect(response.headers.get("content-disposition")).toBeNull();
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

describe("write-once media", () => {
  const SLIDE_IMAGE = `slide-images/${"ab12".repeat(16)}`;
  const LESSON_ID = "4f0c2a5e-8c1b-4d0e-9a57-0b1f9d3e2c71";
  const TIMESTAMPED_THUMBNAIL = `lessons/${LESSON_ID}/${LESSON_ID}-thumbnail-1791222405295.jpg`;
  const ETAG = '"image-v1"';

  function imageBucket() {
    return {
      get: vi.fn<(key: string, options?: R2GetOptions) => Promise<unknown>>(
        async (_key, options) => {
          const metadata = {
            size: 11,
            httpEtag: ETAG,
            writeHttpMetadata(headers: Headers) {
              headers.set("content-type", "image/jpeg");
            },
            ...(options?.range && (options.range as Headers).get("range")
              ? { range: { offset: 0, length: 5 } }
              : {}),
          };
          const conditions = options?.onlyIf as Headers | undefined;
          return conditions?.get("if-none-match") === ETAG
            ? metadata
            : { ...metadata, body: new Response("image bytes").body! };
        },
      ),
    };
  }

  /** A stand-in for caches.default: stores whole responses by URL. */
  function edgeCache() {
    const entries = new Map<string, { body: ArrayBuffer; status: number; headers: Headers }>();
    return {
      entries,
      match: vi.fn<(request: Request) => Promise<Response | undefined>>(async (request) => {
        const entry = entries.get(request.url);
        return entry
          ? new Response(entry.body, { status: entry.status, headers: entry.headers })
          : undefined;
      }),
      put: vi.fn<(key: string, response: Response) => Promise<void>>(async (key, response) => {
        entries.set(key, {
          body: await response.arrayBuffer(),
          status: response.status,
          headers: new Headers(response.headers),
        });
      }),
    };
  }

  /** GETs `/<key>` and waits for everything the route handed to waitUntil. */
  async function get(key: string, bucket: ReturnType<typeof imageBucket>, init?: RequestInit) {
    const pending: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    };
    const response = await mediaRoute.request(
      `https://nexteditor.dev/${key}`,
      init,
      { BUCKET: bucket as unknown as R2Bucket },
      executionContext as unknown as ExecutionContext,
    );
    await Promise.all(pending);
    return response;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([SLIDE_IMAGE, TIMESTAMPED_THUMBNAIL])("serves %s as immutable", async (key) => {
    const response = await get(key, imageBucket());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  // Each of these can be written again under the same key: an upload retry,
  // the first upload's untimestamped thumbnail, or a key outside the two
  // write-once shapes.
  it.each([
    `lessons/${LESSON_ID}/${LESSON_ID}.ne`,
    `lessons/${LESSON_ID}/${LESSON_ID}.ogg`,
    `lessons/${LESSON_ID}/${LESSON_ID}.en.vtt`,
    `lessons/${LESSON_ID}/${LESSON_ID}-thumbnail.jpg`,
    `lessons/${LESSON_ID}/other-id-thumbnail-1791222405295.jpg`,
    "slide-images/example",
  ])("keeps %s revalidating and out of the edge cache", async (key) => {
    const cache = edgeCache();
    vi.stubGlobal("caches", { default: cache });

    const response = await get(key, imageBucket());

    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("answers a repeat request from the edge cache without reading R2", async () => {
    const cache = edgeCache();
    vi.stubGlobal("caches", { default: cache });
    const bucket = imageBucket();

    const first = await get(`${SLIDE_IMAGE}?v=1`, bucket);
    expect(await first.text()).toBe("image bytes");
    // Keyed without the query string, so ?v=… cannot multiply the entries.
    expect([...cache.entries.keys()]).toEqual([`https://nexteditor.dev/${SLIDE_IMAGE}`]);

    const second = await get(SLIDE_IMAGE, bucket);

    expect(second.status).toBe(200);
    expect(await second.text()).toBe("image bytes");
    expect(second.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(second.headers.get("etag")).toBe(ETAG);
    expect(bucket.get).toHaveBeenCalledTimes(1);
  });

  it("leaves Range requests to R2 and never caches a partial response", async () => {
    const cache = edgeCache();
    vi.stubGlobal("caches", { default: cache });
    const bucket = imageBucket();

    const response = await get(TIMESTAMPED_THUMBNAIL, bucket, { headers: { range: "bytes=0-4" } });

    expect(response.status).toBe(206);
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("does not cache a 304 from R2", async () => {
    const cache = edgeCache();
    vi.stubGlobal("caches", { default: cache });

    const response = await get(TIMESTAMPED_THUMBNAIL, imageBucket(), {
      headers: { "if-none-match": ETAG },
    });

    expect(response.status).toBe(304);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("falls back to R2 when the edge cache fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = edgeCache();
    cache.match.mockRejectedValueOnce(new Error("cache unavailable"));
    cache.put.mockRejectedValueOnce(new Error("cache unavailable"));
    vi.stubGlobal("caches", { default: cache });

    const response = await get(SLIDE_IMAGE, imageBucket());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("image bytes");
  });
});
