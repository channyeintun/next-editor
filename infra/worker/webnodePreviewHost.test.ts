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
    expect(isWebnodeHost("abc123defg-5173.preview.example.dev", {})).toBe(false);
    expect(isWebnodeHost("runtime.preview.example.dev", {})).toBe(false);
  });

  it("recognises the runtime host and session-port hosts under the configured host only", () => {
    const configured = { WEBNODE_PREVIEW_HOST: "preview.example.dev" };
    expect(isWebnodeHost("abc123defg-5173.preview.example.dev", configured)).toBe(true);
    expect(isWebnodeHost("ABC123DEFG-5173.Preview.Example.dev", configured)).toBe(true);
    expect(isWebnodeHost("runtime.preview.example.dev", configured)).toBe(true);
    expect(isWebnodeHost("preview.example.dev", configured)).toBe(false);
    expect(isWebnodeHost("a.b-1.preview.example.dev", configured)).toBe(false);
    expect(isWebnodeHost("abc123defg.preview.example.dev", configured)).toBe(false);
    expect(isWebnodeHost("other.preview.example.dev", configured)).toBe(false);
    expect(isWebnodeHost("abc123defg-5173.preview.example.dev.evil.test", configured)).toBe(false);
    expect(isWebnodeHost("example.dev", configured)).toBe(false);
  });

  it("recognises them beside the editor, and none of the editor's other subdomains", () => {
    // The deployment: the hosts are subdomains of the editor's own domain.
    const configured = { WEBNODE_PREVIEW_HOST: "nexteditor.dev" };
    expect(isWebnodeHost("runtime.nexteditor.dev", configured)).toBe(true);
    expect(isWebnodeHost("abc123defg-5173.nexteditor.dev", configured)).toBe(true);
    for (const other of ["nexteditor.dev", "www.nexteditor.dev", "status-2.nexteditor.dev"]) {
      expect(isWebnodeHost(other, configured)).toBe(false);
    }
    // A session id is ten characters: nothing shorter or longer is a preview host.
    expect(isWebnodeHost("abc123-5173.nexteditor.dev", configured)).toBe(false);
    expect(isWebnodeHost("abc123defgh-5173.nexteditor.dev", configured)).toBe(false);
  });
});

describe("serveWebnodeHost", () => {
  it("serves the service worker, told the editor's origin, with the headers a frame needs", async () => {
    const response = await serveWebnodeHost(
      new Request("https://abc123defg-5173.preview.example.dev/__webnode__/sw.js"),
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
        new Request(`https://abc123defg-5173.preview.example.dev${path}`),
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

describe("serveWebnodeHost across a deploy", () => {
  const built = (id: string) => ({
    PUBLIC_URL: "https://editor.example",
    ASSETS: {
      fetch: async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/webnode/build.json") {
          return new Response(JSON.stringify({ id }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(`/* ${pathname} of ${id} */`, {
          headers: { "content-type": "text/javascript" },
        });
      },
    } as unknown as Fetcher,
  });

  it("lets a browser keep the process script of the build it asked for", async () => {
    const response = await serveWebnodeHost(
      new Request("https://runtime.preview.example.dev/__webnode__/process.js?v=b2"),
      built("b2"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("/* /webnode/process.js of b2 */");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("refuses a script of another build instead of serving this one in its place", async () => {
    for (const script of ["process.js", "kernel.js", "runtime.js"]) {
      const response = await serveWebnodeHost(
        new Request(`https://runtime.preview.example.dev/__webnode__/${script}?v=b1`),
        built("b2"),
      );
      expect(response.status).toBe(409);
      expect(await response.text()).toBe("");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("tells an editor of another build to reload", async () => {
    const response = await serveWebnodeHost(
      new Request("https://runtime.preview.example.dev/__webnode__/runtime.html?v=b1"),
      built("b2"),
    );
    const html = await response.text();
    expect(html).toContain("webnode:runtime-error");
    expect(html).toContain('"https://editor.example"');
    expect(html).not.toContain("runtime.js");
  });

  it("loads the runtime script of the build the frame was asked for", async () => {
    const response = await serveWebnodeHost(
      new Request("https://runtime.preview.example.dev/__webnode__/runtime.html?v=b2"),
      built("b2"),
    );
    expect(await response.text()).toContain('<script src="/__webnode__/runtime.js?v=b2">');
  });

  it("serves unversioned requests as before, revalidated each time", async () => {
    const response = await serveWebnodeHost(
      new Request("https://runtime.preview.example.dev/__webnode__/process.js"),
      built("b2"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("reads the build again after a read that failed, and then refuses another build", async () => {
    let reads = 0;
    const flaky = {
      PUBLIC_URL: "https://editor.example",
      ASSETS: {
        fetch: async (request: Request) => {
          const pathname = new URL(request.url).pathname;
          if (pathname === "/webnode/build.json") {
            reads += 1;
            if (reads === 1) {
              throw new Error("assets unavailable");
            }
            return new Response(JSON.stringify({ id: "b2" }), {
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("/* script */", { headers: { "content-type": "text/javascript" } });
        },
      } as unknown as Fetcher,
    };
    const stale = () =>
      serveWebnodeHost(
        new Request("https://runtime.preview.example.dev/__webnode__/process.js?v=b1"),
        flaky,
      );

    // Without the id, the request cannot be told from one for this build.
    expect((await stale()).status).toBe(200);
    expect((await stale()).status).toBe(409);
    expect((await stale()).status).toBe(409);
    expect(reads).toBe(2);
  });

  it("answers the next request when the first one ended before its read of the build did", async () => {
    let reads = 0;
    const abandoned = {
      PUBLIC_URL: "https://editor.example",
      ASSETS: {
        fetch: (request: Request) => {
          if (new URL(request.url).pathname === "/webnode/build.json") {
            reads += 1;
            // The first request's read never settles: a visitor who left, whose
            // request the runtime ended with its work still under way.
            return reads === 1
              ? new Promise<Response>(() => {})
              : Promise.resolve(
                  new Response(JSON.stringify({ id: "b2" }), {
                    headers: { "content-type": "application/json" },
                  }),
                );
          }
          return Promise.resolve(
            new Response("/* script */", { headers: { "content-type": "text/javascript" } }),
          );
        },
      } as unknown as Fetcher,
    };
    const ask = () =>
      serveWebnodeHost(
        new Request("https://runtime.preview.example.dev/__webnode__/process.js?v=b2"),
        abandoned,
      );

    void ask();
    const next = await ask();
    expect(next.status).toBe(200);
    expect(await next.text()).toBe("/* script */");
    // The answer is kept from then on.
    expect((await ask()).status).toBe(200);
    expect(reads).toBe(2);
  });

  it("keeps the answer of a deployment that has no manifest", async () => {
    let reads = 0;
    const unversioned = {
      PUBLIC_URL: "https://editor.example",
      ASSETS: {
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname === "/webnode/build.json") {
            reads += 1;
            // The single-page-application fallback.
            return new Response("<!doctype html>app shell", {
              headers: { "content-type": "text/html" },
            });
          }
          return new Response("/* script */", { headers: { "content-type": "text/javascript" } });
        },
      } as unknown as Fetcher,
    };
    for (let request = 0; request < 3; request += 1) {
      const response = await serveWebnodeHost(
        new Request("https://runtime.preview.example.dev/__webnode__/process.js?v=b1"),
        unversioned,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
    expect(reads).toBe(1);
  });
});

describe("serveWebnodeHost for what a preview page asks itself", () => {
  const host = "https://abc123defg-5173.preview.example.dev";

  it("answers a page's own service worker script with 404", async () => {
    const response = await serveWebnodeHost(
      new Request(`${host}/mockServiceWorker.js`, {
        headers: { "sec-fetch-dest": "serviceworker", "service-worker": "script" },
      }),
      env,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toMatch(/html/);
  });

  it("clears the origin's storage when the editor asks, and only then", async () => {
    const asked = await serveWebnodeHost(
      new Request(`${host}/__webnode__/clear`, {
        method: "POST",
        headers: { origin: "https://editor.example" },
      }),
      env,
    );
    expect(asked.status).toBe(200);
    expect(asked.headers.get("clear-site-data")).toBe('"storage"');
    const other = await serveWebnodeHost(
      new Request(`${host}/__webnode__/clear`, { method: "POST", headers: { origin: host } }),
      env,
    );
    expect(other.status).toBe(403);
    expect(other.headers.get("clear-site-data")).toBeNull();
  });
});

describe("serveWebnodeHost for prepared install objects", () => {
  const id = "0123456789abcdef".repeat(4);
  const runtime = "https://runtime.preview.example.dev";
  const stored = new Uint8Array([0x1b, 0x03, 0x00, 0xf8, 0xff, 0x00, 0x7f]);

  function bucket(objects: Record<string, Uint8Array<ArrayBuffer>>) {
    const asked: unknown[][] = [];
    const binding = {
      get: async (...args: unknown[]) => {
        asked.push(args);
        const bytes = objects[args[0] as string];
        return bytes === undefined
          ? null
          : { body: new Blob([bytes]).stream(), size: bytes.length };
      },
    } as unknown as R2Bucket;
    return { binding, asked };
  }

  function withObjects(binding?: R2Bucket) {
    return { ...env, WEBNODE_PREVIEW_HOST: "preview.example.dev", BUCKET: binding };
  }

  function objectRequest(
    path = `/__webnode__/deps/${id}`,
    init: RequestInit = {},
    host = runtime,
  ): Request {
    return new Request(`${host}${path}`, {
      ...init,
      headers: { "accept-encoding": "gzip, deflate, br", ...init.headers },
    });
  }

  // Cloudflare keeps the browser's own Accept-Encoding there when it rewrites the header.
  function withClientEncoding(request: Request, accepted: string): Request {
    Object.defineProperty(request, "cf", { value: { clientAcceptEncoding: accepted } });
    return request;
  }

  // What a refusal shows: its status, no-store, no encoding and an empty body.
  async function refusal(response: Response) {
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      encoding: response.headers.get("content-encoding"),
      body: await response.text(),
    };
  }
  const refused = (status: number) => ({
    status,
    cacheControl: "no-store",
    encoding: null,
    body: "",
  });

  it("streams the stored Brotli bytes untouched, with the object's headers", async () => {
    const { binding, asked } = bucket({ [`webnode-deps/${id}`]: stored });
    const response = await serveWebnodeHost(objectRequest(), withObjects(binding));
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "application/octet-stream",
      "content-encoding": "br",
      "cache-control": "public, max-age=31536000, immutable, no-transform",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
      vary: "Accept-Encoding",
      "content-length": String(stored.length),
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(stored);
    expect(asked).toEqual([[`webnode-deps/${id}`]]);
  });

  it("answers the whole object to a Range request, which never reaches the bucket", async () => {
    const { binding, asked } = bucket({ [`webnode-deps/${id}`]: stored });
    const response = await serveWebnodeHost(
      objectRequest(undefined, { headers: { range: "bytes=0-1", "if-none-match": '"x"' } }),
      withObjects(binding),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(stored);
    expect(asked).toEqual([[`webnode-deps/${id}`]]);
  });

  it("answers 404 for an object the bucket does not have", async () => {
    const { binding } = bucket({});
    expect(await refusal(await serveWebnodeHost(objectRequest(), withObjects(binding)))).toEqual(
      refused(404),
    );
  });

  it("answers 404 without a bucket binding", async () => {
    expect(await refusal(await serveWebnodeHost(objectRequest(), withObjects()))).toEqual(
      refused(404),
    );
  });

  it("goes by the browser's own Accept-Encoding when Cloudflare rewrote the header", async () => {
    const { binding } = bucket({ [`webnode-deps/${id}`]: stored });
    const rewritten = withClientEncoding(
      new Request(`${runtime}/__webnode__/deps/${id}`, { headers: { "accept-encoding": "gzip" } }),
      "gzip, br",
    );
    const response = await serveWebnodeHost(rewritten, withObjects(binding));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(stored);
  });

  it("answers 404 to a browser that does not take Brotli", async () => {
    const { binding, asked } = bucket({ [`webnode-deps/${id}`]: stored });
    const neither = withClientEncoding(
      new Request(`${runtime}/__webnode__/deps/${id}`, { headers: { "accept-encoding": "gzip" } }),
      "gzip, deflate",
    );
    expect(await refusal(await serveWebnodeHost(neither, withObjects(binding)))).toEqual(
      refused(404),
    );
    const zeroQuality = new Request(`${runtime}/__webnode__/deps/${id}`, {
      headers: { "accept-encoding": "gzip, br;q=0" },
    });
    expect(await refusal(await serveWebnodeHost(zeroQuality, withObjects(binding)))).toEqual(
      refused(404),
    );
    expect(asked).toEqual([]);
  });

  it("answers 405 to anything but GET", async () => {
    const { binding, asked } = bucket({ [`webnode-deps/${id}`]: stored });
    for (const method of ["POST", "HEAD"]) {
      expect(
        await refusal(
          await serveWebnodeHost(objectRequest(undefined, { method }), withObjects(binding)),
        ),
      ).toEqual(refused(405));
    }
    expect(asked).toEqual([]);
  });

  it("answers 404 on a preview host, to a query string, and to an id not spelled canonically", async () => {
    const { binding, asked } = bucket({
      [`webnode-deps/${id}`]: stored,
      [`webnode-deps/${id.toUpperCase()}`]: stored,
    });
    const requests = [
      objectRequest(undefined, {}, "https://abc123defg-5173.preview.example.dev"),
      objectRequest(`/__webnode__/deps/${id}?v=b2`),
      objectRequest(`/__webnode__/deps/${id.toUpperCase()}`),
      objectRequest(`/__webnode__/deps/${id.slice(1)}`),
      objectRequest(`/__webnode__/deps/${id}0`),
      objectRequest("/__webnode__/deps/"),
    ];
    for (const request of requests) {
      expect(await refusal(await serveWebnodeHost(request, withObjects(binding)))).toEqual(
        refused(404),
      );
    }
    expect(asked).toEqual([]);
  });
});
