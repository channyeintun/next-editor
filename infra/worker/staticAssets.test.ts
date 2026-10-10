import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Env } from "./env";
import app from "./index";
import {
  IMMUTABLE_ASSET_CACHE_CONTROL,
  MISSING_ASSET_CACHE_CONTROL,
  serveStaticFile,
} from "./staticAssets";

const STATIC_ASSETS_CACHE_CONTROL = "public, max-age=0, must-revalidate";

const assetsFetch = vi.fn<(request: Request) => Promise<Response>>();

function env(): Env {
  return { ASSETS: { fetch: assetsFetch } as unknown as Fetcher } as Env;
}

function chunk(status = 200): Response {
  return new Response(status === 304 ? null : "export const x = 1;", {
    status,
    headers: {
      "content-type": "text/javascript",
      "cache-control": STATIC_ASSETS_CACHE_CONTROL,
      etag: '"chunk"',
    },
  });
}

// What not_found_handling = "single-page-application" answers for a path with
// no file, conditional requests included.
function spaShell(status = 200): Response {
  return new Response(status === 304 ? null : "<!doctype html><div id=root></div>", {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": STATIC_ASSETS_CACHE_CONTROL,
    },
  });
}

function get(path: string): Request {
  return new Request(`https://nexteditor.dev${path}`);
}

beforeEach(() => {
  assetsFetch.mockReset();
});

describe("serveStaticFile", () => {
  it("caches a hashed chunk for a year and keeps its body and validators", async () => {
    assetsFetch.mockResolvedValue(chunk());

    const response = await serveStaticFile(env(), get("/assets/Editor-DlI0Xcli.js"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(response.headers.get("etag")).toBe('"chunk"');
    expect(await response.text()).toBe("export const x = 1;");
  });

  it("marks a revalidated chunk immutable too, so older cache entries upgrade", async () => {
    assetsFetch.mockResolvedValue(chunk(304));

    const response = await serveStaticFile(env(), get("/assets/Editor-DlI0Xcli.js"));

    expect(response.status).toBe(304);
    expect(response.headers.get("cache-control")).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
  });

  it.each([200, 304])(
    "answers a missing chunk (SPA shell, %i) with an uncacheable 404",
    async (status) => {
      assetsFetch.mockResolvedValue(spaShell(status));

      const response = await serveStaticFile(env(), get("/assets/Editor-DOESNOTEXIST.js"));

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe(MISSING_ASSET_CACHE_CONTROL);
      expect(response.headers.get("content-type")).not.toContain("text/html");
    },
  );

  it("passes other asset statuses through untouched", async () => {
    const partial = new Response("ex", {
      status: 206,
      headers: { "content-type": "text/javascript", "cache-control": STATIC_ASSETS_CACHE_CONTROL },
    });
    assetsFetch.mockResolvedValue(partial);

    const response = await serveStaticFile(env(), get("/assets/Editor-DlI0Xcli.js"));

    expect(response).toBe(partial);
  });

  it("leaves the SPA shell and unhashed files outside /assets as they are", async () => {
    const shell = spaShell();
    assetsFetch.mockResolvedValueOnce(shell);
    const logo = new Response("png", {
      headers: { "content-type": "image/png", "cache-control": STATIC_ASSETS_CACHE_CONTROL },
    });
    assetsFetch.mockResolvedValueOnce(logo);

    expect(await serveStaticFile(env(), get("/code"))).toBe(shell);
    expect(await serveStaticFile(env(), get("/logo.png"))).toBe(logo);
  });
});

describe("the Worker's static answers", () => {
  it.each([
    ["/assets/Editor-DlI0Xcli.js", chunk(), 200],
    ["/assets/Editor-DOESNOTEXIST.js", spaShell(), 404],
    ["/code", spaShell(), 200],
  ])("keep cross-origin isolation on %s", async (path, assetResponse, status) => {
    assetsFetch.mockResolvedValue(assetResponse);

    const response = await app.fetch(get(path), env());

    expect(response.status).toBe(status);
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });
});
