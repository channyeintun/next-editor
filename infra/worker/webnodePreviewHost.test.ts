import { describe, expect, it } from "vitest";
import { isWebnodeHost, serveWebnodeHost } from "./webnodePreviewHost";

function assets(files: Record<string, string>): Fetcher {
  return {
    fetch: async (request: Request) => {
      const source = files[new URL(request.url).pathname];
      return source === undefined
        ? new Response("<!doctype html>app shell", { headers: { "content-type": "text/html" } })
        : new Response(source, { headers: { "content-type": "text/javascript" } });
    },
  } as unknown as Fetcher;
}

const env = {
  PUBLIC_URL: "https://editor.example",
  ASSETS: assets({
    "/webnode/preview-sw.js": "/* worker */",
    "/webnode/kernel.js": "/* kernel */",
  }),
};

describe("isWebnodeHost", () => {
  it("is false for every host until the wildcard host is configured", () => {
    expect(isWebnodeHost("abc123-5173.preview.example.dev", {})).toBe(false);
    expect(isWebnodeHost("runtime.preview.example.dev", {})).toBe(false);
  });

  it("recognises the runtime host and session-port hosts under the configured host only", () => {
    const configured = { WEBNODE_PREVIEW_HOST: "preview.example.dev" };
    expect(isWebnodeHost("abc123-5173.preview.example.dev", configured)).toBe(true);
    expect(isWebnodeHost("ABC123-5173.Preview.Example.dev", configured)).toBe(true);
    expect(isWebnodeHost("runtime.preview.example.dev", configured)).toBe(true);
    expect(isWebnodeHost("preview.example.dev", configured)).toBe(false);
    expect(isWebnodeHost("a.b-1.preview.example.dev", configured)).toBe(false);
    expect(isWebnodeHost("abc123.preview.example.dev", configured)).toBe(false);
    expect(isWebnodeHost("other.preview.example.dev", configured)).toBe(false);
    expect(isWebnodeHost("abc123-5173.preview.example.dev.evil.test", configured)).toBe(false);
    expect(isWebnodeHost("example.dev", configured)).toBe(false);
  });
});

describe("serveWebnodeHost", () => {
  it("serves the service worker, told the editor's origin, with the headers a frame needs", async () => {
    const response = await serveWebnodeHost(
      new Request("https://abc123-5173.preview.example.dev/__webnode__/sw.js"),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      `self.__WEBNODE_EDITOR_ORIGIN__ = "https://editor.example";\n/* worker */`,
    );
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("serves the kernel script on the runtime host", async () => {
    const response = await serveWebnodeHost(
      new Request("https://runtime.preview.example.dev/__webnode__/kernel.js"),
      env,
    );
    expect(await response.text()).toBe("/* kernel */");
  });

  it("answers 404 for a script the build did not emit, never the app shell", async () => {
    const response = await serveWebnodeHost(
      new Request("https://runtime.preview.example.dev/__webnode__/process.js"),
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("answers any other path with a page only the editor may frame", async () => {
    for (const path of ["/src/main.tsx", "/api/auth/me", "/__webnode__/runtime.html"]) {
      const response = await serveWebnodeHost(
        new Request(`https://abc123-5173.preview.example.dev${path}`),
        env,
      );
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-security-policy")).toBe(
        "frame-ancestors https://editor.example",
      );
      expect(await response.text()).not.toContain("app shell");
    }
  });
});
