import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MAX_MEDIA_BYTES_PER_OWNER } from "../../db/ownerLimits";
import { insertSignedInUser, openSqliteD1 } from "../../db/testing";
import { countingRateLimiter } from "../testing/rateLimit";
import { slideImagesRoute } from "./slideImages";

vi.mock("../auth/session", () => ({
  getCurrentUser: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "user-1" })),
}));

function ingest(body: string, env: unknown = validationEnv()) {
  return slideImagesRoute.request(
    "https://nexteditor.dev/",
    { method: "POST", body, headers: { "content-type": "application/json" } },
    env as never,
  );
}

function validationEnv() {
  return {
    DB: {} as D1Database,
    BUCKET: {} as R2Bucket,
    SLIDE_IMAGE_RATE_LIMITER: countingRateLimiter(Infinity),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slideImagesRoute request validation", () => {
  // Every JSON value is a valid body, including `null`, which has no
  // properties to read.
  it.each(["null", "[]", "1", '"urls"', "{}", '{"urls":[]}', '{"urls":[1]}'])(
    "answers the body %s with 400",
    async (body) => {
      const response = await ingest(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "'urls' must be a non-empty array of strings",
      });
    },
  );

  it("answers a body that is not JSON with 400", async () => {
    const response = await ingest("{urls");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid JSON body" });
  });

  it("refuses a body over the request ceiling before parsing it", async () => {
    const response = await ingest(JSON.stringify({ urls: ["x".repeat(64 * 1024)] }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body is too large" });
  });
});

describe("slideImagesRoute storage", () => {
  /** A bucket over a Map, a real D1 with user-1, and Google answering a 1 KiB PNG. */
  function storageEnv() {
    const { db, sqlite } = openSqliteD1();
    insertSignedInUser(sqlite, "user-1", "session-1");
    const stored = new Map<string, number>();
    const bucket = {
      head: vi.fn<(key: string) => Promise<object | null>>(async (key) =>
        stored.has(key) ? {} : null,
      ),
      put: vi.fn<(key: string, body: Uint8Array) => Promise<void>>(async (key, body) => {
        stored.set(key, body.byteLength);
      }),
    };
    const limiter = countingRateLimiter(Infinity);
    const fetchSpy = vi.fn<() => Promise<Response>>(
      async () =>
        new Response(new Uint8Array(1024), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "1024" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const env = { DB: db, BUCKET: bucket, SLIDE_IMAGE_RATE_LIMITER: limiter };
    return { env, sqlite, stored, bucket, fetchSpy, limiter };
  }

  const urls = (list: string[]) => JSON.stringify({ urls: list });

  it("stores one image once, however its URL is spelled", async () => {
    // Each spelling used to be fetched again and stored under a key of its own.
    const { env, stored, fetchSpy } = storageEnv();
    const spellings = [
      "https://lh3.googleusercontent.com/dummy#1",
      "https://lh3.googleusercontent.com/dummy#2",
      "https://lh3.googleusercontent.com:443/dummy",
      "https://LH3.googleusercontent.com/dummy",
      "https://lh3.googleusercontent.com/./dummy",
    ];

    const response = await ingest(urls(spellings), env);

    expect(response.status).toBe(200);
    const { results } = (await response.json()) as {
      results: { url: string; path?: string }[];
    };
    expect(results.map((result) => result.url)).toEqual(spellings);
    const paths = new Set(results.map((result) => result.path));
    expect(paths.size).toBe(1);
    expect([...paths][0]).toMatch(/^slide-images\/[0-9a-f]{64}$/);
    expect(stored.size).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // A new spelling of a stored image is answered from the bucket.
    const again = await ingest(urls(["https://lh3.googleusercontent.com/dummy#3"]), env);
    expect(await again.json()).toEqual({
      results: [{ url: "https://lh3.googleusercontent.com/dummy#3", path: [...paths][0] }],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(stored.size).toBe(1);
  });

  it("charges each stored image to the user's storage quota, and refuses past it", async () => {
    const { env, sqlite, stored } = storageEnv();

    await ingest(urls(["https://lh3.googleusercontent.com/first"]), env);
    expect(sqlite.prepare("SELECT owner_id, bytes FROM media_objects").all()).toEqual([
      { owner_id: "user-1", bytes: 1024 },
    ]);

    // Nearly full: the next 1 KiB image does not fit.
    sqlite
      .prepare(
        "INSERT INTO media_objects (key, owner_id, bytes, created_at, updated_at) VALUES ('lessons/x/x.ne', 'user-1', ?, 0, 0)",
      )
      .run(MAX_MEDIA_BYTES_PER_OWNER - 1024);
    const refused = await ingest(urls(["https://lh3.googleusercontent.com/second"]), env);

    expect(await refused.json()).toEqual({
      results: [
        { url: "https://lh3.googleusercontent.com/second", error: "Storage quota reached." },
      ],
    });
    expect(stored.size).toBe(1);
  });

  it("charges each request to the user's budget, and fails closed without one", async () => {
    const { env, limiter, fetchSpy } = storageEnv();

    await ingest(urls(["https://lh3.googleusercontent.com/first"]), env);
    expect(limiter.keys).toEqual(["user:user-1"]);

    const limited = await ingest(urls(["https://lh3.googleusercontent.com/second"]), {
      ...env,
      SLIDE_IMAGE_RATE_LIMITER: countingRateLimiter(0),
    });
    expect(limited.status).toBe(429);
    const missing = await ingest(urls(["https://lh3.googleusercontent.com/second"]), {
      ...env,
      SLIDE_IMAGE_RATE_LIMITER: undefined,
    });
    expect(missing.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
