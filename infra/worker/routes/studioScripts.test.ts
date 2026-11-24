import { describe, expect, it, vi } from "vite-plus/test";
import { studioScriptsRoute } from "./studioScripts";
import {
  PUBLISHED_SCRIPT_INDEX_KEY,
  publishedScriptObjectKey,
} from "../../../src/studio/plans/publishedScripts";

const ID = "a".repeat(64);

// A stand-in for R2's get: `stored` maps a key to its text and ETag. With an
// If-None-Match that matches, it answers as R2 does for a failed precondition:
// the object's metadata without a body.
function bucketOf(stored: Record<string, { text: string; etag: string }>) {
  const get = vi.fn<(key: string, options?: { onlyIf?: Headers }) => Promise<unknown>>(
    async (key, options) => {
      const entry = Object.hasOwn(stored, key) ? stored[key] : undefined;
      if (!entry) return null;
      const object = {
        size: entry.text.length,
        httpEtag: entry.etag,
        writeHttpMetadata(headers: Headers) {
          // What a careless publisher might have stored; the route must not replay it.
          headers.set("content-type", "text/html");
        },
      };
      if (options?.onlyIf?.get("if-none-match") === entry.etag) return object;
      return { ...object, body: new Response(entry.text).body! };
    },
  );
  return { env: { BUCKET: { get } as unknown as R2Bucket }, get };
}

function request(path: string, init?: RequestInit) {
  return new Request(`https://nexteditor.dev${path}`, init);
}

describe("studioScriptsRoute index", () => {
  it("serves the index as JSON that revalidates, with its ETag", async () => {
    const { env, get } = bucketOf({
      [PUBLISHED_SCRIPT_INDEX_KEY]: { text: '{"version":1}\n', etag: '"index-1"' },
    });

    const response = await studioScriptsRoute.request(request("/index"), undefined, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("etag")).toBe('"index-1"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe('{"version":1}\n');
    expect(get).toHaveBeenCalledWith(PUBLISHED_SCRIPT_INDEX_KEY, expect.anything());
  });

  it("answers 304 when the client already holds the current index", async () => {
    const { env } = bucketOf({
      [PUBLISHED_SCRIPT_INDEX_KEY]: { text: "{}", etag: '"index-1"' },
    });

    const response = await studioScriptsRoute.request(
      request("/index", { headers: { "if-none-match": '"index-1"' } }),
      undefined,
      env,
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"index-1"');
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("is a 404 that is never cached before the first publish", async () => {
    const { env } = bucketOf({});

    const response = await studioScriptsRoute.request(request("/index"), undefined, env);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "not found" });
  });
});

describe("studioScriptsRoute objects", () => {
  it("serves a script as immutable plain text", async () => {
    const { env, get } = bucketOf({
      [publishedScriptObjectKey(ID)]: { text: "lesson:\n  slug: x\n", etag: `"${ID}"` },
    });

    const response = await studioScriptsRoute.request(request(`/objects/${ID}`), undefined, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBe(`"${ID}"`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("lesson:\n  slug: x\n");
    expect(get).toHaveBeenCalledWith(`studio-scripts/objects/${ID}`, expect.anything());
  });

  it.each([
    ["too short", "abc"],
    ["uppercase", "A".repeat(64)],
    ["a path", `${ID}/../index.json`],
    ["the index's name", "index.json"],
  ])("refuses a malformed id (%s) without reading the bucket", async (_, id) => {
    const { env, get } = bucketOf({});

    const response = await studioScriptsRoute.request(request(`/objects/${id}`), undefined, env);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(get).not.toHaveBeenCalled();
  });

  it("is a 404 that is never cached for an id that was not published", async () => {
    const { env, get } = bucketOf({});

    const response = await studioScriptsRoute.request(request(`/objects/${ID}`), undefined, env);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("answers HEAD with the headers and no body", async () => {
    const { env } = bucketOf({
      [publishedScriptObjectKey(ID)]: { text: "lesson: {}\n", etag: `"${ID}"` },
    });

    const response = await studioScriptsRoute.request(
      request(`/objects/${ID}`, { method: "HEAD" }),
      undefined,
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("etag")).toBe(`"${ID}"`);
    expect(await response.text()).toBe("");
  });
});
