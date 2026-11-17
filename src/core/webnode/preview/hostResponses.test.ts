// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createPreviewConnectHtml } from "./connectPage";
import {
  PREVIEW_CLEAR_PATH,
  RUNTIME_FRAME_PATH,
  STALE_BUILD_MESSAGE,
  webnodeHostAsset,
  webnodeHostResponse,
} from "./hostResponses";

const EDITOR = "https://editor.example";

describe("webnodeHostAsset", () => {
  it("names the scripts a runtime host serves and nothing else", () => {
    expect(webnodeHostAsset("/__webnode__/sw.js")).toBe("preview-sw.js");
    expect(webnodeHostAsset("/__webnode__/runtime.js")).toBe("runtime.js");
    expect(webnodeHostAsset("/__webnode__/kernel.js")).toBe("kernel.js");
    expect(webnodeHostAsset("/__webnode__/process.js")).toBe("process.js");
    expect(webnodeHostAsset("/")).toBeNull();
    expect(webnodeHostAsset("/__webnode__/other.js")).toBeNull();
    expect(webnodeHostAsset("/src/main.ts")).toBeNull();
  });
});

describe("webnodeHostResponse", () => {
  it("serves the service worker, told who the editor is", () => {
    const response = webnodeHostResponse("/__webnode__/sw.js", {
      editorOrigin: EDITOR,
      assetSource: "/* worker */",
    });
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "service-worker-allowed": "/",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "cross-origin",
    });
    expect(response.body).toBe(
      `self.__WEBNODE_EDITOR_ORIGIN__ = "https://editor.example";\n/* worker */`,
    );
  });

  it("serves the kernel and process scripts unchanged", () => {
    for (const path of ["/__webnode__/kernel.js", "/__webnode__/process.js"]) {
      const response = webnodeHostResponse(path, { editorOrigin: EDITOR, assetSource: "code();" });
      expect(response.body).toBe("code();");
      expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
      expect(response.headers["service-worker-allowed"]).toBeUndefined();
    }
  });

  it("answers 404 for a script the host could not read", () => {
    expect(
      webnodeHostResponse("/__webnode__/kernel.js", { editorOrigin: EDITOR, assetSource: null })
        .status,
    ).toBe(404);
  });

  it("serves the runtime frame, framable by the editor only", () => {
    const response = webnodeHostResponse(RUNTIME_FRAME_PATH, {
      editorOrigin: EDITOR,
      assetSource: null,
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain('<script src="/__webnode__/runtime.js"></script>');
    expect(response.headers["content-security-policy"]).toBe(`frame-ancestors ${EDITOR}`);
    expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("asks the browser to keep every page it serves apart from other origins of its site", () => {
    for (const path of [RUNTIME_FRAME_PATH, "/", "/src/main.tsx"]) {
      const response = webnodeHostResponse(path, { editorOrigin: EDITOR, assetSource: null });
      expect(response.headers["origin-agent-cluster"]).toBe("?1");
    }
  });

  it("serves the connect page for every other path", () => {
    for (const path of ["/", "/index.html", "/src/main.ts", "/__webnode__/other"]) {
      const response = webnodeHostResponse(path, { editorOrigin: EDITOR, assetSource: null });
      expect(response.status).toBe(200);
      expect(response.body).toBe(createPreviewConnectHtml(EDITOR));
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toBe(`frame-ancestors ${EDITOR}`);
    }
  });
});

describe("webnodeHostResponse for what a preview page asks itself", () => {
  it("answers a page's own service worker script with 404, not the connect page", () => {
    for (const destination of ["serviceworker", "script", "worker", "empty"]) {
      const response = webnodeHostResponse("/mockServiceWorker.js", {
        editorOrigin: EDITOR,
        assetSource: null,
        destination,
      });
      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toBeUndefined();
    }
  });

  it("serves the connect page to a document or frame load", () => {
    for (const destination of ["document", "iframe", null]) {
      const response = webnodeHostResponse("/", {
        editorOrigin: EDITOR,
        assetSource: null,
        destination,
      });
      expect(response.body).toBe(createPreviewConnectHtml(EDITOR));
    }
  });

  it("clears the origin's storage, not the site's cookies, when the editor asks", () => {
    const response = webnodeHostResponse(PREVIEW_CLEAR_PATH, {
      editorOrigin: EDITOR,
      assetSource: null,
      method: "POST",
      requestOrigin: EDITOR,
    });
    expect(response.status).toBe(200);
    expect(response.headers["clear-site-data"]).toBe('"storage"');
  });

  it("clears nothing for anyone else", () => {
    for (const request of [
      { method: "POST", requestOrigin: "https://abcdefghij-3000.preview.example" },
      { method: "GET", requestOrigin: EDITOR },
      { method: "POST", requestOrigin: null },
    ]) {
      const response = webnodeHostResponse(PREVIEW_CLEAR_PATH, {
        editorOrigin: EDITOR,
        assetSource: null,
        ...request,
      });
      expect(response.status).toBe(403);
      expect(response.headers["clear-site-data"]).toBeUndefined();
    }
  });
});

describe("webnodeHostResponse across a deploy", () => {
  const served = { editorOrigin: EDITOR, assetSource: "code();", currentBuild: "b2" };

  it("lets a browser keep the kernel and process scripts of the build it asked for", () => {
    for (const path of ["/__webnode__/kernel.js", "/__webnode__/process.js"]) {
      const response = webnodeHostResponse(path, { ...served, requestedBuild: "b2" });
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    }
  });

  it("revalidates the scripts that carry the editor's origin, whatever build is named", () => {
    for (const path of ["/__webnode__/runtime.js", "/__webnode__/sw.js"]) {
      const response = webnodeHostResponse(path, { ...served, requestedBuild: "b2" });
      expect(response.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("revalidates a script asked for without a build, or by a host that knows none", () => {
    expect(webnodeHostResponse("/__webnode__/process.js", served).headers["cache-control"]).toBe(
      "no-cache",
    );
    expect(
      webnodeHostResponse("/__webnode__/process.js", {
        editorOrigin: EDITOR,
        assetSource: "code();",
        requestedBuild: "b2",
      }).headers["cache-control"],
    ).toBe("no-cache");
  });

  it("refuses a script of another build", () => {
    const response = webnodeHostResponse("/__webnode__/process.js", {
      ...served,
      requestedBuild: "b1",
    });
    expect(response.status).toBe(409);
    expect(response.body).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("names the build in the runtime frame's script", () => {
    const response = webnodeHostResponse(RUNTIME_FRAME_PATH, {
      editorOrigin: EDITOR,
      assetSource: null,
      requestedBuild: "b2",
      currentBuild: "b2",
    });
    expect(response.body).toContain('<script src="/__webnode__/runtime.js?v=b2"></script>');
  });

  it("escapes a build id it puts into the frame", () => {
    const response = webnodeHostResponse(RUNTIME_FRAME_PATH, {
      editorOrigin: EDITOR,
      assetSource: null,
      requestedBuild: '"><script>alert(1)</script>',
    });
    expect(response.body).not.toContain("<script>alert(1)");
    expect(response.body.match(/<script/g)).toHaveLength(1);
  });

  it("tells the editor of another build to reload, and only that editor", () => {
    const response = webnodeHostResponse(RUNTIME_FRAME_PATH, {
      editorOrigin: EDITOR,
      assetSource: null,
      requestedBuild: "b1",
      currentBuild: "b2",
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-security-policy"]).toBe(`frame-ancestors ${EDITOR}`);
    expect(response.body).toContain(
      `parent.postMessage({"type":"webnode:runtime-error","message":"${STALE_BUILD_MESSAGE}"}, "${EDITOR}")`,
    );
    expect(response.body).not.toContain("runtime.js");
  });
});

describe("createPreviewConnectHtml", () => {
  it("is a self-contained document whose script parses", () => {
    const html = createPreviewConnectHtml(EDITOR);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Connecting to preview…");
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    expect(() => new Function(script)).not.toThrow();
  });

  it("takes a connection only from the editor and asks only the editor", () => {
    const html = createPreviewConnectHtml(EDITOR);
    expect(html).toContain('var EDITOR = "https://editor.example";');
    expect(html).toContain("event.origin !== EDITOR");
    expect(html).toContain('{ type: "webnode:preview-connect" }, EDITOR)');
    expect(html).not.toContain('"*"');
  });

  describe("when the preview cannot start", () => {
    interface Posted {
      message: { type: string; payload: { type: string; message: string } };
      origin: string;
    }

    /** Runs the page's script with the browser objects it touches. */
    async function run(
      navigator: object,
      embedded = true,
      port: { build?: string } | null = null,
      fetchStatus = 404,
    ) {
      const script =
        /<script>([\s\S]*)<\/script>/.exec(createPreviewConnectHtml(EDITOR))?.[1] ?? "";
      const element = () => ({ textContent: "", style: {} as Record<string, string> });
      const elements: Record<string, ReturnType<typeof element>> = {
        msg: element(),
        note: element(),
        spin: element(),
      };
      const posted: Posted[] = [];
      const listeners: ((event: object) => void)[] = [];
      const window: Record<string, unknown> = {
        addEventListener: (_type: string, listener: (event: object) => void) =>
          listeners.push(listener),
      };
      window.parent = embedded
        ? {
            postMessage: (message: Posted["message"], origin: string) =>
              posted.push({ message, origin }),
          }
        : window;
      const location = {
        host: "abc123defg-5173.preview.example",
        href: "https://abc123defg-5173.preview.example/",
      };
      new Function(
        "document",
        "navigator",
        "window",
        "location",
        "setInterval",
        "clearInterval",
        "fetch",
        script,
      )(
        { getElementById: (id: string) => elements[id] },
        navigator,
        window,
        location,
        () => 0,
        () => {},
        async () => ({ status: fetchStatus }),
      );
      if (port) {
        for (const listener of listeners) {
          listener({
            source: window.parent,
            origin: EDITOR,
            data: { type: "webnode:preview-port", port: {}, ...port },
          });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { elements, posted: posted.filter((post) => post.message.payload) };
    }

    it("tells the editor that the browser has no service workers", async () => {
      const { elements, posted } = await run({});
      expect(elements.msg.textContent).toBe("This browser cannot show the preview.");
      expect(posted).toHaveLength(1);
      expect(posted[0].origin).toBe(EDITOR);
      expect(posted[0].message.type).toBe("webnode:preview-message");
      expect(posted[0].message.payload.type).toBe("preview_unavailable");
      expect(posted[0].message.payload.message).toContain("Service workers are unavailable");
    });

    it("tells the editor when the browser refuses the service worker, and what to allow", async () => {
      const refused = new Error("The user denied permission to use Service Worker.");
      const { posted } = await run(
        { serviceWorker: { register: () => Promise.reject(refused) } },
        true,
        { build: "" },
      );
      expect(posted).toHaveLength(1);
      expect(posted[0].origin).toBe(EDITOR);
      expect(posted[0].message.payload.message).toContain("denied permission");
      expect(posted[0].message.payload.message).toContain(
        "allow them for abc123defg-5173.preview.example",
      );
    });

    it("registers the service worker of the editor's build", async () => {
      const registered: string[] = [];
      await run(
        {
          serviceWorker: {
            register: (path: string) => {
              registered.push(path);
              return new Promise(() => {});
            },
          },
        },
        true,
        { build: "b7" },
      );
      expect(registered).toEqual(["/__webnode__/sw.js?v=b7"]);
    });

    it("registers nothing before the editor answers", async () => {
      const registered: string[] = [];
      await run({
        serviceWorker: {
          register: (path: string) => {
            registered.push(path);
            return new Promise(() => {});
          },
        },
      });
      expect(registered).toEqual([]);
    });

    it("tells the editor to reload when the host serves a newer build", async () => {
      const { elements, posted } = await run(
        { serviceWorker: { register: () => Promise.reject(new TypeError("bad status 409")) } },
        true,
        { build: "b1" },
        409,
      );
      expect(posted).toHaveLength(1);
      expect(posted[0].message.payload.message).toContain(STALE_BUILD_MESSAGE.slice(1));
      expect(elements.note.textContent).toContain("reload the page");
    });

    it("has no editor to tell when it is opened on its own", async () => {
      const { elements, posted } = await run({}, false);
      expect(elements.msg.textContent).toBe("This browser cannot show the preview.");
      expect(posted).toEqual([]);
    });
  });
});
