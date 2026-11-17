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

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";
const FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:139.0) Gecko/20100101 Firefox/139.0";

function browser(userAgent: string): void {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
}

describe("selectedRuntimeEngine", () => {
  it("is webnode in a Chromium browser", async () => {
    browser(CHROME);
    expect((await loadPage()).selectedRuntimeEngine()).toBe("webnode");
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBeNull();
  });

  it.each([
    ["Safari", SAFARI],
    ["Firefox", FIREFOX],
  ])("is WebContainer in %s, where webnode is not verified", async (_name, userAgent) => {
    browser(userAgent);
    expect((await loadPage()).selectedRuntimeEngine()).toBe("webcontainer");
  });

  it("tries webnode in any browser when the link asks for it", async () => {
    browser(SAFARI);
    expect((await loadPage("?runtime=webnode")).selectedRuntimeEngine()).toBe("webnode");
  });

  it("leaves webnode for WebContainer when a link asks, and remembers it", async () => {
    browser(CHROME);
    expect((await loadPage("?runtime=webcontainer")).selectedRuntimeEngine()).toBe("webcontainer");
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBe("webcontainer");

    // Later page loads, without the link, stay on WebContainer.
    expect((await loadPage()).selectedRuntimeEngine()).toBe("webcontainer");
  });

  it("comes back to webnode when a link asks, and forgets the opt-out", async () => {
    browser(CHROME);
    window.localStorage.setItem(PREFERENCE_KEY, "webcontainer");
    expect((await loadPage("?runtime=webnode")).selectedRuntimeEngine()).toBe("webnode");
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBeNull();
    expect((await loadPage()).selectedRuntimeEngine()).toBe("webnode");
  });

  it("keeps the engine it chose when the address changes within the page load", async () => {
    browser(CHROME);
    const engine = await loadPage();
    expect(engine.selectedRuntimeEngine()).toBe("webnode");

    window.history.replaceState(null, "", "/learn?runtime=webcontainer");
    expect(engine.selectedRuntimeEngine()).toBe("webnode");
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBeNull();
  });

  it("is WebContainer in a lesson embedded on another site", async () => {
    // webnode's hosts let only the editor's own origin frame them.
    browser(CHROME);
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    expect((await loadPage()).selectedRuntimeEngine()).toBe("webcontainer");
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
  it("boots webnode by default in a Chromium browser", async () => {
    browser(CHROME);
    const instance = { name: "webnode" };
    boots.webnode.mockResolvedValue(instance);
    const engine = await loadPage();

    await expect(engine.bootRuntimeEngine()).resolves.toBe(instance);
    expect(boots.webnode).toHaveBeenCalledWith(
      expect.objectContaining({ previewBase: { protocol: "http:", host: window.location.host } }),
    );
    expect(boots.webcontainer).not.toHaveBeenCalled();
  });

  it("falls back to WebContainer for the page load when webnode does not start", async () => {
    browser(CHROME);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const instance = { name: "webcontainer" };
    boots.webnode.mockRejectedValue(new Error("webnode: the runtime did not answer"));
    boots.webcontainer.mockResolvedValue(instance);
    const engine = await loadPage();

    await expect(engine.bootRuntimeEngine()).resolves.toBe(instance);
    expect(warn).toHaveBeenCalledOnce();
    // Reloading the preview, and a second boot in this page, use WebContainer too.
    expect(engine.selectedRuntimeEngine()).toBe("webcontainer");
    await engine.bootRuntimeEngine();
    expect(boots.webnode).toHaveBeenCalledOnce();
    expect(boots.webcontainer).toHaveBeenCalledTimes(2);

    // Nothing is remembered: the next page load tries webnode again.
    expect(window.localStorage.getItem(PREFERENCE_KEY)).toBeNull();
    expect((await loadPage()).selectedRuntimeEngine()).toBe("webnode");
  });

  it("boots WebContainer for a visitor who left webnode", async () => {
    browser(CHROME);
    window.localStorage.setItem(PREFERENCE_KEY, "webcontainer");
    const instance = { name: "webcontainer" };
    boots.webcontainer.mockResolvedValue(instance);
    const engine = await loadPage();

    await expect(engine.bootRuntimeEngine()).resolves.toBe(instance);
    expect(boots.webnode).not.toHaveBeenCalled();
  });
});
