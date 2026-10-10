import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Env } from "./env";
import app from "./index";
import {
  IMMUTABLE_ASSET_CACHE_CONTROL,
  MISSING_ASSET_CACHE_CONTROL,
  PRECOMPRESSED_ASSET_CACHE_CONTROL,
  acceptsBrotli,
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

function get(path: string, headers?: HeadersInit, method = "GET"): Request {
  return new Request(`https://nexteditor.dev${path}`, { headers, method });
}

const CHROME_ACCEPT_ENCODING = "gzip, deflate, br, zstd";
const CHUNK_SOURCE = "export const answer = 42;\n".repeat(200);
const CHUNK_BROTLI = brotliCompressSync(CHUNK_SOURCE);

// The build's `.br` copy as ASSETS.fetch serves any file: typed by its own
// extension, with its own validators, no Content-Encoding.
function brotliCopy(status = 200): Response {
  return new Response(status === 304 ? null : CHUNK_BROTLI, {
    status,
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": STATIC_ASSETS_CACHE_CONTROL,
      "content-length": String(CHUNK_BROTLI.byteLength),
      etag: '"chunk-br"',
    },
  });
}

function requestedPaths(): string[] {
  return assetsFetch.mock.calls.map(([request]) => new URL(request.url).pathname);
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

describe("acceptsBrotli", () => {
  it.each([
    [CHROME_ACCEPT_ENCODING, true],
    ["br", true],
    ["gzip, BR;q=0.5", true],
    ["gzip, deflate", false],
    ["gzip, br;q=0", false],
    ["br;q=0.000", false],
    ["*", false],
  ])("reads %j as %s", (acceptEncoding, expected) => {
    expect(acceptsBrotli(get("/assets/x.js", { "Accept-Encoding": acceptEncoding }))).toBe(
      expected,
    );
  });

  it("is false without Accept-Encoding", () => {
    expect(acceptsBrotli(get("/assets/x.js"))).toBe(false);
  });

  it("prefers the browser's own value when Cloudflare rewrote the header", () => {
    const rewritten = (cf: object) =>
      Object.assign(get("/assets/x.js", { "Accept-Encoding": "gzip" }), { cf });

    expect(acceptsBrotli(rewritten({ clientAcceptEncoding: CHROME_ACCEPT_ENCODING }))).toBe(true);
    expect(acceptsBrotli(rewritten({}))).toBe(false);
  });
});

describe("serveStaticFile with Brotli copies", () => {
  it("serves the copy encoded, typed as the original, and uncompressible by the edge", async () => {
    assetsFetch.mockResolvedValueOnce(brotliCopy());

    const response = await serveStaticFile(
      env(),
      get("/assets/Editor-DlI0Xcli.js", {
        "Accept-Encoding": CHROME_ACCEPT_ENCODING,
        "If-None-Match": '"stale"',
      }),
    );

    expect(requestedPaths()).toEqual(["/assets/Editor-DlI0Xcli.js.br"]);
    expect(assetsFetch.mock.calls[0][0].headers.get("if-none-match")).toBe('"stale"');
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(response.headers.get("cache-control")).toBe(PRECOMPRESSED_ASSET_CACHE_CONTROL);
    expect(response.headers.get("vary")).toContain("Accept-Encoding");
    expect(response.headers.get("etag")).toBe('"chunk-br"');
    expect(response.headers.get("content-length")).toBe(String(CHUNK_BROTLI.byteLength));
    const body = Buffer.from(await response.arrayBuffer());
    expect(brotliDecompressSync(body).toString()).toBe(CHUNK_SOURCE);
  });

  it("types a WebAssembly copy as application/wasm for instantiateStreaming", async () => {
    assetsFetch.mockResolvedValueOnce(brotliCopy());

    const response = await serveStaticFile(
      env(),
      get("/assets/next-editor-dmp-CGeFVXWD.wasm", { "Accept-Encoding": "br" }),
    );

    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect(response.headers.get("content-encoding")).toBe("br");
  });

  it("revalidates against the copy without restating its encoding", async () => {
    assetsFetch.mockResolvedValueOnce(brotliCopy(304));

    const response = await serveStaticFile(
      env(),
      get("/assets/Editor-DlI0Xcli.js", {
        "Accept-Encoding": CHROME_ACCEPT_ENCODING,
        "If-None-Match": '"chunk-br"',
      }),
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(response.headers.get("cache-control")).toBe(PRECOMPRESSED_ASSET_CACHE_CONTROL);
    expect(response.headers.get("vary")).toContain("Accept-Encoding");
  });

  it("falls back to the original when the copy is missing", async () => {
    assetsFetch.mockResolvedValueOnce(spaShell()).mockResolvedValueOnce(chunk());

    const response = await serveStaticFile(
      env(),
      get("/assets/Editor-DlI0Xcli.js", { "Accept-Encoding": CHROME_ACCEPT_ENCODING }),
    );

    expect(requestedPaths()).toEqual([
      "/assets/Editor-DlI0Xcli.js.br",
      "/assets/Editor-DlI0Xcli.js",
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("cache-control")).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
    expect(await response.text()).toBe("export const x = 1;");
  });

  it("still answers a missing chunk with an uncacheable 404", async () => {
    assetsFetch.mockResolvedValueOnce(spaShell()).mockResolvedValueOnce(spaShell());

    const response = await serveStaticFile(
      env(),
      get("/assets/Editor-DOESNOTEXIST.js", { "Accept-Encoding": CHROME_ACCEPT_ENCODING }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe(MISSING_ASSET_CACHE_CONTROL);
  });

  it.each([
    ["a browser without br", get("/assets/Editor-DlI0Xcli.js", { "Accept-Encoding": "gzip" })],
    [
      "a Range request",
      get("/assets/Editor-DlI0Xcli.js", { "Accept-Encoding": "br", Range: "bytes=0-9" }),
    ],
    ["a POST", get("/assets/Editor-DlI0Xcli.js", { "Accept-Encoding": "br" }, "POST")],
    [
      "a type the build does not compress",
      get("/assets/font-abc.woff2", { "Accept-Encoding": "br" }),
    ],
    ["a source map", get("/assets/ts.worker-abc.js.map", { "Accept-Encoding": "br" })],
  ])("serves the original to %s", async (_, request) => {
    assetsFetch.mockResolvedValueOnce(chunk());

    const response = await serveStaticFile(env(), request);

    expect(requestedPaths()).toEqual([new URL(request.url).pathname]);
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("never serves a copy by its own name", async () => {
    const response = await serveStaticFile(
      env(),
      get("/assets/Editor-DlI0Xcli.js.br", { "Accept-Encoding": "br" }),
    );

    expect(assetsFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe(MISSING_ASSET_CACHE_CONTROL);
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

  it("keep a Brotli copy's encoding, headers and bytes through the isolation headers", async () => {
    assetsFetch.mockResolvedValueOnce(brotliCopy());

    const response = await app.fetch(
      get("/assets/Editor-DlI0Xcli.js", { "Accept-Encoding": CHROME_ACCEPT_ENCODING }),
      env(),
    );

    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(response.headers.get("cache-control")).toBe(PRECOMPRESSED_ASSET_CACHE_CONTROL);
    const body = Buffer.from(await response.arrayBuffer());
    expect(brotliDecompressSync(body).toString()).toBe(CHUNK_SOURCE);
  });
});
