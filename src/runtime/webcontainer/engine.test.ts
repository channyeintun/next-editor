import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const boots = vi.hoisted(() => ({
  webnode: vi.fn<(options: object) => Promise<object>>(),
  webcontainer: vi.fn<(options: object) => Promise<object>>(),
}));
vi.mock("../../core/webnode/api", () => ({ WebNode: { boot: boots.webnode } }));
vi.mock("@webcontainer/api", () => ({ WebContainer: { boot: boots.webcontainer } }));

const PREFERENCE_KEY = "next-editor:runtime-engine";

/** The engine module as a page loaded at `/code<search>` sees it. */
async function loadPage(search = "") {
  vi.resetModules();
  window.history.replaceState(null, "", `/code${search}`);
  return import("./engine");
}

beforeEach(() => {
  window.localStorage.clear();
  boots.webnode.mockReset();
  boots.webcontainer.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("selectedRuntimeEngine", () => {
  it("is WebContainer unless the visitor chose webnode", async () => {
    expect((await loadPage()).selectedRuntimeEngine()).toBe("webcontainer");
  });

  it("lets a link choose webnode for the page load without remembering it", async () => {
    const engine = await loadPage("?runtime=webnode");
    expect(engine.selectedRuntimeEngine()).toBe("webnode");
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBeNull();

    // The next page load, without the link, is back on WebContainer.
    expect((await loadPage()).selectedRuntimeEngine()).toBe("webcontainer");
  });

  it("keeps the engine it chose when the address changes within the page load", async () => {
    const engine = await loadPage("?runtime=webnode");
    expect(engine.selectedRuntimeEngine()).toBe("webnode");

    window.history.replaceState(null, "", "/learn?runtime=webcontainer");
    expect(engine.selectedRuntimeEngine()).toBe("webnode");
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBeNull();
  });

  it("follows the choice the visitor stored", async () => {
    window.localStorage.setItem(PREFERENCE_KEY, "webnode");
    expect((await loadPage()).selectedRuntimeEngine()).toBe("webnode");
  });

  it("forgets a stored choice of webnode when a link asks for WebContainer", async () => {
    window.localStorage.setItem(PREFERENCE_KEY, "webnode");
    expect((await loadPage("?runtime=webcontainer")).selectedRuntimeEngine()).toBe("webcontainer");
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBeNull();
  });
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
  it("boots webnode when it is the engine of the page load", async () => {
    const instance = { name: "webnode" };
    boots.webnode.mockResolvedValue(instance);
    const engine = await loadPage("?runtime=webnode");

    await expect(engine.bootRuntimeEngine()).resolves.toBe(instance);
    expect(boots.webnode).toHaveBeenCalledWith(
      expect.objectContaining({ previewBase: { protocol: "http:", host: window.location.host } }),
    );
    expect(boots.webcontainer).not.toHaveBeenCalled();
  });

  it("falls back to WebContainer when webnode does not start, and stays there", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const instance = { name: "webcontainer" };
    boots.webnode.mockRejectedValue(new Error("webnode: the runtime did not answer"));
    boots.webcontainer.mockResolvedValue(instance);
    window.localStorage.setItem(PREFERENCE_KEY, "webnode");
    const engine = await loadPage();

    await expect(engine.bootRuntimeEngine()).resolves.toBe(instance);
    expect(warn).toHaveBeenCalledOnce();
    // Reloading the preview, and the next page load, use WebContainer too.
    expect(engine.selectedRuntimeEngine()).toBe("webcontainer");
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBeNull();

    await engine.bootRuntimeEngine();
    expect(boots.webnode).toHaveBeenCalledOnce();
    expect(boots.webcontainer).toHaveBeenCalledTimes(2);
  });

  it("boots WebContainer by default", async () => {
    const instance = { name: "webcontainer" };
    boots.webcontainer.mockResolvedValue(instance);
    const engine = await loadPage();

    await expect(engine.bootRuntimeEngine()).resolves.toBe(instance);
    expect(boots.webnode).not.toHaveBeenCalled();
  });
});
