// How the editor's end starts the runtime frame: what it asks for, and how it
// gives up on a host that is not serving a runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./buildId", () => ({
  BUILD_ID: "b2",
  BUILD_PARAMETER: "v",
  STALE_BUILD_MESSAGE: "the editor was updated; reload the page to run code again",
  versionedPath: (path: string, buildId = "b2") => (buildId ? `${path}?v=${buildId}` : path),
}));

const { WebNode } = await import("./api");

const BASE = { protocol: "https:" as const, host: "preview.example.dev" };
const RUNTIME = "https://runtime.preview.example.dev";

function runtimeFrame(): HTMLIFrameElement {
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="webnode runtime"]');
  if (!frame) {
    throw new Error("no runtime frame");
  }
  return frame;
}

/** Delivers `data` as a message from the runtime frame. */
function fromFrame(data: unknown, ports: MessagePort[] = [], origin = RUNTIME): void {
  window.dispatchEvent(
    new MessageEvent("message", { data, origin, source: runtimeFrame().contentWindow, ports }),
  );
}

/**
 * Boots and waits until the frame is in the page. The boot is handed back
 * inside an object: an async function that returned the promise would wait for it.
 */
async function startBoot(): Promise<{ boot: Promise<unknown> }> {
  const boot = WebNode.boot({ previewBase: BASE });
  boot.catch(() => {});
  // Claiming the session takes a few promise turns; then the frame is appended.
  await vi.advanceTimersByTimeAsync(0);
  runtimeFrame();
  return { boot };
}

beforeEach(() => {
  vi.stubGlobal("crossOriginIsolated", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.sessionStorage.clear();
});

describe("starting the runtime frame", () => {
  it("asks the runtime host for the frame of its own build, hidden and isolated", async () => {
    await startBoot();
    const frame = runtimeFrame();
    expect(frame.getAttribute("src")).toBe(`${RUNTIME}/__webnode__/runtime.html?v=b2`);
    expect(frame.hidden).toBe(true);
    expect(frame.getAttribute("allow")).toBe("cross-origin-isolated");
  });

  it("gives up soon after a frame loads without answering as a runtime", async () => {
    const { boot } = await startBoot();
    runtimeFrame().dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(5000);

    await expect(boot).rejects.toThrow(`${RUNTIME} did not answer as a runtime`);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("gives up after the start timeout when the frame never loads", async () => {
    const { boot } = await startBoot();
    await vi.advanceTimersByTimeAsync(30000);

    await expect(boot).rejects.toThrow("did not start");
  });

  it("fails with what the host says when the host serves another build", async () => {
    const { boot } = await startBoot();
    fromFrame({ type: "webnode:runtime-error", message: "the editor was updated" });

    await expect(boot).rejects.toThrow("webnode: the editor was updated");
  });

  it("refuses a runtime of another build", async () => {
    const { boot } = await startBoot();
    fromFrame({ type: "webnode:runtime-ready", buildId: "b1" }, [new MessageChannel().port1]);

    await expect(boot).rejects.toThrow("the editor was updated; reload the page");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("ignores a ready message from any other origin or window", async () => {
    const { boot } = await startBoot();
    fromFrame({ type: "webnode:runtime-ready" }, [new MessageChannel().port1], "https://evil.test");
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "webnode:runtime-ready" },
        origin: RUNTIME,
        source: window,
        ports: [new MessageChannel().port1],
      }),
    );
    await vi.advanceTimersByTimeAsync(30000);

    await expect(boot).rejects.toThrow("did not start");
  });

  it("arms one grace timer however often the frame loads", async () => {
    const { boot } = await startBoot();
    runtimeFrame().dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(4000);
    runtimeFrame().dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(4000);
    // The first timer was replaced, not left to fire.
    expect(document.querySelector("iframe")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);

    await expect(boot).rejects.toThrow("did not answer as a runtime");
  });
});

describe("waiting for the kernel", () => {
  /** A frame that said it is ready, with the kernel's end of the port kept here. */
  async function readyFrame() {
    const started = await startBoot();
    const channel = new MessageChannel();
    fromFrame({ type: "webnode:runtime-ready", buildId: "b2" }, [channel.port1]);
    await vi.advanceTimersByTimeAsync(0);
    return { ...started, kernel: channel.port2 };
  }

  it("fails with the frame's report when the kernel worker did not load", async () => {
    const { boot } = await readyFrame();
    fromFrame({ type: "webnode:runtime-error", message: "the kernel worker failed to start" });

    await expect(boot).rejects.toThrow("webnode: the kernel worker failed to start");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("gives up on a kernel that never answers", async () => {
    const { boot } = await readyFrame();
    await vi.advanceTimersByTimeAsync(30000);

    await expect(boot).rejects.toThrow(`the kernel at ${RUNTIME} did not answer`);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("takes a report of failure from the runtime frame only", async () => {
    const { boot } = await readyFrame();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "webnode:runtime-error", message: "from elsewhere" },
        origin: "https://evil.test",
        source: runtimeFrame().contentWindow,
      }),
    );
    await vi.advanceTimersByTimeAsync(30000);

    await expect(boot).rejects.toThrow("did not answer");
  });

  it("boots once the kernel answers, and stops waiting", async () => {
    const { boot, kernel } = await readyFrame();
    kernel.onmessage = (event: MessageEvent<{ id: number }>) => {
      kernel.postMessage({
        id: event.data.id,
        ok: true,
        value: { workdir: "/home/app", path: "/bin" },
      });
    };
    // A MessagePort delivers on a real task.
    vi.useRealTimers();
    const instance = (await boot) as { workdir: string; teardown(): void };

    expect(instance.workdir).toBe("/home/app");
    instance.teardown();
  });
});

describe("a running runtime", () => {
  type Api = typeof import("./api");

  /** The api as a fresh page load has it. */
  async function freshPage(): Promise<Api> {
    vi.resetModules();
    return import("./api");
  }

  /** Boots `api` against a fake frame and kernel; the kernel answers every request. */
  async function bootRuntime(api: Api, sessionKey?: string) {
    const boot = api.WebNode.boot({ previewBase: BASE, sessionKey });
    for (let i = 0; i < 50 && !document.querySelector("iframe"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const frameWindow = runtimeFrame().contentWindow;
    const channel = new MessageChannel();
    const kernel = channel.port2;
    kernel.onmessage = (event: MessageEvent<{ id: number; method: string }>) => {
      const { id, method } = event.data;
      if (id === 0) {
        kernel.postMessage({ id, ok: true, value: { workdir: "/home/app", path: "/bin" } });
      } else if (id > 0) {
        kernel.postMessage({ id, ok: true, value: method === "spawn" ? 7 : undefined });
      }
    };
    fromFrame({ type: "webnode:runtime-ready", buildId: "b2" }, [channel.port1]);
    const instance = await boot;
    /** The URL the runtime gives a server that starts listening on `port`. */
    const serverUrl = (port: number) =>
      new Promise<string>((resolve) => {
        const stop = instance.on("server-ready", (_port, url) => {
          stop();
          resolve(url);
        });
        kernel.postMessage({ event: "port", port, type: "open" });
      });
    return { instance, kernel, frameWindow, serverUrl };
  }

  let fetches: { url: string; init: RequestInit | undefined }[] = [];

  beforeEach(() => {
    vi.useRealTimers();
    fetches = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetches.push({ url, init });
      return new Response(null, { status: 204 });
    });
  });

  it("tells its error listeners what the runtime frame reports after boot", async () => {
    const { instance, frameWindow } = await bootRuntime(await freshPage());
    const errors: { message: string }[] = [];
    instance.on("error", (error) => errors.push(error));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "webnode:runtime-error", message: "boom" },
        origin: RUNTIME,
        source: frameWindow,
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "webnode:runtime-error", message: "not ours" },
        origin: "https://evil.test",
        source: frameWindow,
      }),
    );
    expect(errors).toEqual([{ message: "webnode: boom" }]);
    instance.teardown();
  });

  it("settles the exit of every process still running at teardown", async () => {
    const { instance } = await bootRuntime(await freshPage());
    const process = await instance.spawn("node", ["server.js"]);
    instance.teardown();
    await expect(process.exit).resolves.toBe(137);
  });

  it("gives the next project of a page new preview origins", async () => {
    const api = await freshPage();
    const first = await bootRuntime(api);
    const lessonA = await first.serverUrl(5173);
    first.instance.teardown();
    const second = await bootRuntime(api);
    const lessonB = await second.serverUrl(5173);
    expect(lessonB).not.toBe(lessonA);
    second.instance.teardown();
  });

  it("keeps the preview origins across a reload of the same page", async () => {
    const before = await bootRuntime(await freshPage());
    const url = await before.serverUrl(5173);
    // The page unloads without a teardown.
    document.body.replaceChildren();
    const after = await bootRuntime(await freshPage());
    expect(await after.serverUrl(5173)).toBe(url);
    expect(fetches).toEqual([]);
    after.instance.teardown();
  });

  it("gives a reload into another project new origins, and clears the old ones", async () => {
    const before = await bootRuntime(await freshPage(), "/lesson/a");
    const url = await before.serverUrl(5173);
    document.body.replaceChildren();
    const after = await bootRuntime(await freshPage(), "/lesson/b");
    expect(await after.serverUrl(5173)).not.toBe(url);
    expect(fetches.map((entry) => entry.url)).toEqual([`${url}__webnode__/clear`]);
    after.instance.teardown();
  });

  it("clears the preview origins of a session it gives up", async () => {
    const { instance, serverUrl } = await bootRuntime(await freshPage());
    const url = await serverUrl(5173);
    instance.teardown();
    expect(fetches).toHaveLength(1);
    expect(fetches[0].url).toBe(`${url}__webnode__/clear`);
    expect(fetches[0].init).toMatchObject({ method: "POST", mode: "no-cors" });
  });
});
