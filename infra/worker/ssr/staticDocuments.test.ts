import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import app from "../index";
import type { Env } from "../env";
import { serveAppShell, serveLandingDocument } from "./staticDocuments";

const assetsFetch = vi.fn<(request: Request) => Promise<Response>>();
const assets = { fetch: assetsFetch };
const env = { ASSETS: assets as unknown as Fetcher } as Env;

function htmlAsset(body: string, etag: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html",
      etag,
      "last-modified": "Sat, 10 Oct 2026 00:00:00 GMT",
    },
  });
}

function requestedPaths(): string[] {
  return assetsFetch.mock.calls.map(([request]) => new URL(request.url).pathname);
}

beforeEach(() => {
  vi.clearAllMocks();
  assetsFetch.mockImplementation(async (request) =>
    new URL(request.url).pathname === "/landing"
      ? htmlAsset('<div id="root" data-ssr="landing"></div>', '"landing"')
      : htmlAsset('<div id="root"></div>', '"shell"'),
  );
});

describe("static documents", () => {
  it("asks Static Assets for the landing document by its canonical path, conditionals included", async () => {
    const asset = htmlAsset("landing", '"landing"');
    assetsFetch.mockResolvedValueOnce(asset);

    const response = await serveLandingDocument(
      assets,
      new Request("https://nexteditor.dev/?utm_source=x", {
        headers: { "If-None-Match": '"landing"', "Accept-Encoding": "br" },
      }),
    );

    expect(response).toBe(asset);
    const [request] = assetsFetch.mock.calls[0];
    expect(request.url).toBe("https://nexteditor.dev/landing");
    expect(request.method).toBe("GET");
    expect(request.headers.get("If-None-Match")).toBe('"landing"');
    expect(request.headers.get("Accept-Encoding")).toBe("br");
  });

  it("asks for the app shell at /, which Static Assets serves without a redirect", async () => {
    await serveAppShell(
      assets,
      new Request("https://nexteditor.dev/learn/@chan", { method: "HEAD" }),
    );

    const [request] = assetsFetch.mock.calls[0];
    expect(request.url).toBe("https://nexteditor.dev/");
    expect(request.method).toBe("HEAD");
  });
});

describe("GET /", () => {
  it("serves the prerendered landing as is, keeping its validators", async () => {
    const response = await app.request("https://nexteditor.dev/", {}, env);

    expect(requestedPaths()).toEqual(["/landing"]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<div id="root" data-ssr="landing"></div>');
    expect(response.headers.get("etag")).toBe('"landing"');
    expect(response.headers.get("last-modified")).toBe("Sat, 10 Oct 2026 00:00:00 GMT");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("passes a 304 revalidation through", async () => {
    assetsFetch.mockResolvedValueOnce(
      new Response(null, { status: 304, headers: { etag: '"landing"' } }),
    );

    const response = await app.request(
      "https://nexteditor.dev/",
      { headers: { "If-None-Match": '"landing"' } },
      env,
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  });

  it.each(["/landing", "/landing/", "/landing.html"])(
    "keeps answering %s with the app shell, as for any path with no file",
    async (path) => {
      const response = await app.request(`https://nexteditor.dev${path}`, {}, env);

      expect(requestedPaths()).toEqual(["/"]);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<div id="root"></div>');
    },
  );
});
