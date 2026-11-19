import { describe, expect, it, vi } from "vite-plus/test";
import { createIframeReloadHoldScript, IFRAME_RELOAD_HOLD_STORAGE_KEY } from "./iframeReloadHold";

const HREF = "http://abc-5173.localhost/menu?tab=1";

class FakeSheet {
  css = "";
  replaceSync(css: string) {
    this.css = css;
  }
}

interface FakeOptions {
  /** What the old document left, as stored text. */
  stored?: string;
  href?: string;
  hash?: string;
  /** False: a browser without cross-document view transitions. */
  viewTransitions?: boolean;
  readyState?: string;
  failStorage?: boolean;
}

/** A preview window, as far as the script reaches into one. */
function createFrameWindow(options: FakeOptions = {}) {
  const storage = new Map<string, string>();
  if (options.stored !== undefined) storage.set(IFRAME_RELOAD_HOLD_STORAGE_KEY, options.stored);
  const windowListeners = new Map<string, (event: unknown) => void>();
  const navigationListeners = new Map<string, (event: unknown) => void>();
  const frames: (() => void)[] = [];
  const timers: (() => void)[] = [];
  const document = {
    readyState: options.readyState ?? "loading",
    adoptedStyleSheets: [] as FakeSheet[],
    documentElement: {},
  };
  /** What the document's sheets held each time its styles were worked out. */
  const styleUpdates: string[] = [];
  const frameWindow: Record<string, unknown> = {
    document,
    navigation: {
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        navigationListeners.set(type, listener),
    },
    CSSStyleSheet: FakeSheet,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (options.failStorage) throw new Error("storage is off");
        storage.set(key, value);
      },
      removeItem: (key: string) => storage.delete(key),
    },
    location: {
      href: options.href ?? HREF,
      hash: options.hash ?? "",
      replace: vi.fn<(url: string) => void>(),
      reload: vi.fn<() => void>(),
    },
    scrollX: 0,
    scrollY: 240,
    scrollTo: vi.fn<(x: number, y: number) => void>(),
    getComputedStyle: () => {
      styleUpdates.push(document.adoptedStyleSheets.map((sheet) => sheet.css).join(""));
      return { opacity: "1" };
    },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      windowListeners.set(type, listener),
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    setTimeout: (callback: () => void) => timers.push(callback),
  };
  if (options.viewTransitions !== false) {
    frameWindow.CSSViewTransitionRule = class {};
    frameWindow.onpagereveal = null;
  }
  new Function("window", createIframeReloadHoldScript("__TEST_RELOAD_HOLD__"))(frameWindow);

  return {
    storage,
    document,
    location: frameWindow.location as {
      replace: ReturnType<typeof vi.fn>;
      reload: ReturnType<typeof vi.fn>;
    },
    scrollTo: frameWindow.scrollTo as ReturnType<typeof vi.fn>,
    styleUpdates,
    hasNavigateListener: () => navigationListeners.has("navigate"),
    /** The page navigates; answers whether the script cancelled it. */
    navigate(navigationType: string, cancelable = true): boolean {
      const preventDefault = vi.fn<() => void>();
      navigationListeners.get("navigate")?.({ navigationType, cancelable, preventDefault });
      return preventDefault.mock.calls.length > 0;
    },
    fire(type: string, event: unknown = {}) {
      windowListeners.get(type)?.(event);
    },
    /** Runs the animation frames asked for so far. */
    runFrames() {
      for (const frame of frames.splice(0)) frame();
    },
    runTimers() {
      for (const timer of timers.splice(0)) timer();
    },
    rules: () => document.adoptedStyleSheets.map((sheet) => sheet.css).join(""),
  };
}

const note = (overrides: object = {}) =>
  JSON.stringify({ at: Date.now(), href: HREF, x: 0, y: 240, ...overrides });

describe("createIframeReloadHoldScript: the document that reloads", () => {
  it("reloads as a replace navigation to the same address, and leaves a note", () => {
    const frame = createFrameWindow();

    expect(frame.navigate("reload")).toBe(true);
    expect(frame.location.replace).toHaveBeenCalledWith(HREF);
    expect(JSON.parse(frame.storage.get(IFRAME_RELOAD_HOLD_STORAGE_KEY)!)).toMatchObject({
      href: HREF,
      x: 0,
      y: 240,
    });
    // The document it leaves allows the transition.
    expect(frame.rules()).toContain("@view-transition{navigation:auto}");
  });

  it("has its styles worked out with the rule in place before it navigates", () => {
    // The browser hears of the rule at a style update; a navigation that
    // commits before the next frame's would otherwise get no transition.
    const frame = createFrameWindow();
    frame.location.replace.mockImplementation(() => {
      expect(frame.styleUpdates).toHaveLength(1);
    });

    frame.navigate("reload");

    expect(frame.location.replace).toHaveBeenCalledTimes(1);
    expect(frame.styleUpdates[0]).toContain("@view-transition{navigation:auto}");
  });

  it("leaves every other navigation alone", () => {
    const frame = createFrameWindow();

    expect(frame.navigate("push")).toBe(false);
    expect(frame.navigate("replace")).toBe(false);
    expect(frame.navigate("traverse")).toBe(false);
    expect(frame.location.replace).not.toHaveBeenCalled();
  });

  it("leaves a reload it cannot cancel alone", () => {
    const frame = createFrameWindow();

    expect(frame.navigate("reload", false)).toBe(false);
    expect(frame.location.replace).not.toHaveBeenCalled();
  });

  it("leaves a reload alone at an address with a fragment, where navigating there only scrolls", () => {
    const frame = createFrameWindow({ href: `${HREF}#prices`, hash: "#prices" });

    expect(frame.navigate("reload")).toBe(false);
    expect(frame.location.replace).not.toHaveBeenCalled();
  });

  it("reloads as usual when it cannot leave a note", () => {
    const frame = createFrameWindow({ failStorage: true });

    expect(frame.navigate("reload")).toBe(false);
    expect(frame.location.replace).not.toHaveBeenCalled();
  });

  it("does nothing in a browser without cross-document view transitions", () => {
    const frame = createFrameWindow({ viewTransitions: false, stored: note() });

    expect(frame.hasNavigateListener()).toBe(false);
    expect(frame.rules()).toBe("");
    // The note is not its to take.
    expect(frame.storage.has(IFRAME_RELOAD_HOLD_STORAGE_KEY)).toBe(true);
  });
});

describe("createIframeReloadHoldScript: the document that arrives", () => {
  it("keeps the old picture until it has loaded and painted, then returns to its place", () => {
    const frame = createFrameWindow({ stored: note() });
    const skipTransition = vi.fn<() => void>();

    // The note is taken, and the old picture is held on top.
    expect(frame.storage.has(IFRAME_RELOAD_HOLD_STORAGE_KEY)).toBe(false);
    expect(frame.rules()).toContain("::view-transition-old(root)");
    expect(frame.rules()).toContain(
      "::view-transition-new(root){animation:none!important;opacity:0",
    );

    frame.fire("pagereveal", { viewTransition: { skipTransition } });
    frame.fire("load");
    frame.runFrames();
    expect(skipTransition).not.toHaveBeenCalled();
    frame.runFrames();

    expect(frame.scrollTo).toHaveBeenCalledWith(0, 240);
    expect(skipTransition).toHaveBeenCalledTimes(1);
    expect(frame.rules()).toBe("");
  });

  it("does not wait for a load that already happened", () => {
    const frame = createFrameWindow({ stored: note(), readyState: "complete" });

    frame.runFrames();
    frame.runFrames();

    expect(frame.rules()).toBe("");
  });

  it("drops the old picture after a second when the page has still not loaded", () => {
    const frame = createFrameWindow({ stored: note() });
    const skipTransition = vi.fn<() => void>();
    frame.fire("pagereveal", { viewTransition: { skipTransition } });

    frame.runTimers();

    expect(skipTransition).toHaveBeenCalledTimes(1);
    expect(frame.rules()).toBe("");
    // The load that comes later changes nothing more.
    frame.fire("load");
    frame.runFrames();
    frame.runFrames();
    expect(skipTransition).toHaveBeenCalledTimes(1);
  });

  it("ends a transition that only starts after the picture was dropped", () => {
    const frame = createFrameWindow({ stored: note() });
    const skipTransition = vi.fn<() => void>();

    frame.runTimers();
    frame.fire("pagereveal", { viewTransition: { skipTransition } });

    expect(skipTransition).toHaveBeenCalledTimes(1);
  });

  it("makes a reload that comes while the old picture is up wait until the page is painted", () => {
    const frame = createFrameWindow({ stored: note() });
    const skipTransition = vi.fn<() => void>();
    frame.fire("pagereveal", { viewTransition: { skipTransition } });

    // Two more edits before this document has drawn anything: neither reloads yet.
    expect(frame.navigate("reload")).toBe(true);
    expect(frame.navigate("reload")).toBe(true);
    expect(frame.location.replace).not.toHaveBeenCalled();
    expect(frame.location.reload).not.toHaveBeenCalled();
    expect(frame.storage.has(IFRAME_RELOAD_HOLD_STORAGE_KEY)).toBe(false);

    frame.fire("load");
    frame.runFrames();
    frame.runFrames();

    // The page is on screen, at its place: now they reload, once.
    expect(frame.scrollTo).toHaveBeenCalledWith(0, 240);
    expect(skipTransition).toHaveBeenCalledTimes(1);
    expect(frame.location.reload).toHaveBeenCalledTimes(1);

    // That reload is held as any reload of a drawn page is.
    expect(frame.navigate("reload")).toBe(true);
    expect(frame.location.replace).toHaveBeenCalledWith(HREF);
  });

  it("reloads no more once the page is drawn and no reload waited", () => {
    const frame = createFrameWindow({ stored: note(), readyState: "complete" });

    frame.runFrames();
    frame.runFrames();

    expect(frame.location.reload).not.toHaveBeenCalled();
  });

  it("stays at the top when the old document was there", () => {
    const frame = createFrameWindow({ stored: note({ y: 0 }), readyState: "complete" });

    frame.runFrames();
    frame.runFrames();

    expect(frame.scrollTo).not.toHaveBeenCalled();
  });

  it("holds nothing for a note that is old, for another address, or unreadable", () => {
    for (const stored of [
      note({ at: Date.now() - 60_000 }),
      note({ href: "http://abc-5173.localhost/other" }),
      "{not json",
    ]) {
      const frame = createFrameWindow({ stored });

      expect(frame.rules()).toBe("");
      expect(frame.storage.has(IFRAME_RELOAD_HOLD_STORAGE_KEY)).toBe(false);
    }
  });

  it("holds nothing on an ordinary load", () => {
    const frame = createFrameWindow();

    expect(frame.rules()).toBe("");
    expect(frame.hasNavigateListener()).toBe(true);
  });
});
