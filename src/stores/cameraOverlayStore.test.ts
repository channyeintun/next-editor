import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, createMachine } from "xstate";
import {
  createCameraOverlayStore,
  selectCameraOverlayMinimized,
  selectCameraOverlayVisible,
  selectLivePreviewOn,
} from "./cameraOverlayStore";

const VISIBLE_KEY = "next-editor-camera-overlay-visible";
const MINIMIZED_KEY = "next-editor-camera-overlay-minimized";

function ctx(store: ReturnType<typeof createCameraOverlayStore>) {
  return store.getSnapshot().context;
}

const editor = () => createActor(createMachine({}));

// Reading `window.localStorage` throws where the browser denies the document storage, as
// for an embedded lesson whose third-party storage is blocked.
function blockStorage(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Access is denied for this document.", "SecurityError");
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
  };
}

let unblockStorage: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  unblockStorage?.();
  unblockStorage = null;
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("cameraOverlayStore", () => {
  it("shows the camera, expanded, with no live preview by default", () => {
    const store = createCameraOverlayStore();

    expect(selectCameraOverlayVisible(ctx(store))).toBe(true);
    expect(selectCameraOverlayMinimized(ctx(store))).toBe(false);
    expect(ctx(store).livePreviewEditor).toBeNull();
  });

  it("starts from the stored choices", () => {
    window.localStorage.setItem(VISIBLE_KEY, "false");
    window.localStorage.setItem(MINIMIZED_KEY, "true");
    const store = createCameraOverlayStore();

    expect(selectCameraOverlayVisible(ctx(store))).toBe(false);
    expect(selectCameraOverlayMinimized(ctx(store))).toBe(true);
  });

  it("takes a stored value it never writes for the default", () => {
    window.localStorage.setItem(VISIBLE_KEY, "no");
    window.localStorage.setItem(MINIMIZED_KEY, "yes");
    const store = createCameraOverlayStore();

    expect(selectCameraOverlayVisible(ctx(store))).toBe(true);
    expect(selectCameraOverlayMinimized(ctx(store))).toBe(false);
  });

  it("remembers each choice when it changes, and only that one", () => {
    const store = createCameraOverlayStore();

    store.trigger.toggleVisible();
    expect(window.localStorage.getItem(VISIBLE_KEY)).toBe("false");
    expect(window.localStorage.getItem(MINIMIZED_KEY)).toBeNull();

    store.trigger.setMinimized({ minimized: true });
    expect(window.localStorage.getItem(MINIMIZED_KEY)).toBe("true");

    const rehydrated = createCameraOverlayStore();
    expect(selectCameraOverlayVisible(ctx(rehydrated))).toBe(false);
    expect(selectCameraOverlayMinimized(ctx(rehydrated))).toBe(true);

    store.trigger.toggleVisible();
    expect(window.localStorage.getItem(VISIBLE_KEY)).toBe("true");
  });

  it("never stores the live preview", () => {
    const store = createCameraOverlayStore();
    store.trigger.toggleLivePreview({ editor: editor() });

    expect(window.localStorage.length).toBe(0);
  });

  it("switches the live preview on and off for one editor only", () => {
    const store = createCameraOverlayStore();
    const first = editor();
    const next = editor();

    store.trigger.toggleLivePreview({ editor: first });
    expect(selectLivePreviewOn(ctx(store), first)).toBe(true);
    // An editor mounted later starts with its camera off.
    expect(selectLivePreviewOn(ctx(store), next)).toBe(false);

    store.trigger.toggleLivePreview({ editor: first });
    expect(selectLivePreviewOn(ctx(store), first)).toBe(false);
  });

  it("stops an editor's live preview when its player bar goes, and no one else's", () => {
    const store = createCameraOverlayStore();
    const first = editor();
    const next = editor();
    store.trigger.toggleLivePreview({ editor: first });

    store.trigger.stopLivePreview({ editor: next });
    expect(selectLivePreviewOn(ctx(store), first)).toBe(true);

    store.trigger.stopLivePreview({ editor: first });
    expect(ctx(store).livePreviewEditor).toBeNull();
  });

  it("imports with its defaults and keeps working when storage is blocked", async () => {
    window.localStorage.setItem(VISIBLE_KEY, "false");
    unblockStorage = blockStorage();
    vi.resetModules();

    // A module-level singleton, created while the module is evaluated.
    const { cameraOverlayStore } = await import("./cameraOverlayStore");
    expect(selectCameraOverlayVisible(cameraOverlayStore.getSnapshot().context)).toBe(true);

    cameraOverlayStore.trigger.toggleVisible();
    cameraOverlayStore.trigger.setMinimized({ minimized: true });
    expect(selectCameraOverlayVisible(cameraOverlayStore.getSnapshot().context)).toBe(false);
    expect(selectCameraOverlayMinimized(cameraOverlayStore.getSnapshot().context)).toBe(true);
  });

  it("keeps a change when the origin's storage is full", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    const store = createCameraOverlayStore();

    expect(() => store.trigger.setMinimized({ minimized: true })).not.toThrow();
    expect(selectCameraOverlayMinimized(ctx(store))).toBe(true);
  });
});
