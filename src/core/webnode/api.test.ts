// How the editor's end starts the runtime frame: what it asks for, and how it
// gives up on a host that is not serving a runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./buildId", () => ({
  BUILD_ID: "b2",
  BUILD_PARAMETER: "v",
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
