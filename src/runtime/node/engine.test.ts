import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const bootWebNode = vi.hoisted(() => vi.fn<(options: object) => Promise<object>>());
vi.mock("../../core/webnode/api", () => ({ WebNode: { boot: bootWebNode } }));

/** The engine module as a page loaded at `/code` sees it. */
async function loadPage() {
  vi.resetModules();
  window.history.replaceState(null, "", "/code");
  return import("./engine");
}

beforeEach(() => {
  bootWebNode.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("webnodePreviewBaseFor", () => {
  const editor = { protocol: "https:", hostname: "nexteditor.dev", host: "nexteditor.dev" };
  const local = { protocol: "http:", hostname: "localhost", host: "localhost:5173" };

  it("uses the host the build names", async () => {
    const { webnodePreviewBaseFor } = await loadPage();
    expect(webnodePreviewBaseFor(editor, "nexteditor.dev")).toEqual({
      protocol: "https:",
      host: "nexteditor.dev",
    });
    expect(webnodePreviewBaseFor(editor, " nexteditor-preview.dev ")).toEqual({
      protocol: "https:",
      host: "nexteditor-preview.dev",
    });
  });

  it("has none where the build names none", async () => {
    const { webnodePreviewBaseFor } = await loadPage();
    expect(webnodePreviewBaseFor(editor, undefined)).toBeNull();
    expect(webnodePreviewBaseFor(editor, "  ")).toBeNull();
  });

  it("uses the local hosts in development, whatever the build names", async () => {
    const { webnodePreviewBaseFor } = await loadPage();
    const base = { protocol: "http:", host: "localhost:5173" };
    expect(webnodePreviewBaseFor(local, undefined)).toEqual(base);
    // A deployment's hosts would refuse a local editor.
    expect(webnodePreviewBaseFor(local, "nexteditor.dev")).toEqual(base);
  });

  it("has none for a configured value that is not a host and nothing else", async () => {
    const { webnodePreviewBaseFor } = await loadPage();
    for (const value of [
      "not a host",
      "https://nexteditor.dev",
      "nexteditor.dev/",
      "nexteditor.dev/path",
      "user@nexteditor.dev",
    ]) {
      expect(webnodePreviewBaseFor(editor, value)).toBeNull();
    }
  });

  it("normalises the case of a configured host and keeps its port", async () => {
    const { webnodePreviewBaseFor } = await loadPage();
    expect(webnodePreviewBaseFor(editor, "NextEditor.dev:8443")).toEqual({
      protocol: "https:",
      host: "nexteditor.dev:8443",
    });
  });
});

describe("bootRuntimeEngine", () => {
  it("boots webnode on the hosts of this page", async () => {
    const instance = { name: "webnode" };
    bootWebNode.mockResolvedValue(instance);
    const engine = await loadPage();

    expect(engine.runtimeUnavailableReason()).toBeNull();
    await expect(engine.bootRuntimeEngine()).resolves.toBe(instance);
    expect(bootWebNode).toHaveBeenCalledWith(
      expect.objectContaining({ previewBase: { protocol: "http:", host: window.location.host } }),
    );
  });

  it("fails as webnode fails: there is nothing to fall back to", async () => {
    bootWebNode.mockRejectedValue(new Error("webnode: the runtime did not answer"));
    const engine = await loadPage();

    await expect(engine.bootRuntimeEngine()).rejects.toThrow("the runtime did not answer");
  });

  it("does not start in a lesson embedded on another site, and says where it does", async () => {
    // webnode's hosts let only the editor's own origin frame them.
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    const engine = await loadPage();

    expect(engine.runtimeUnavailableReason()).toContain(
      `Open this lesson on ${window.location.host}`,
    );
    await expect(engine.bootRuntimeEngine()).rejects.toThrow("inside another site's page");
    expect(bootWebNode).not.toHaveBeenCalled();
  });
});
