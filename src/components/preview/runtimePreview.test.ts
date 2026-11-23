import { describe, expect, it } from "vite-plus/test";
import {
  applyRouteToRuntimePreviewLocation,
  createRuntimePreviewLocationFromUrl,
  getPreviewTabTarget,
  normalizePreviewRoute,
  previewTabSharesEditorSite,
  runtimePreviewSrcNeedsReset,
} from "./runtimePreview";

// The Node.js runtime server-ready URL is origin-only (no trailing slash). The
// `iframe.src` PROPERTY reflects the parsed/re-serialized URL — which gains a
// trailing "/" — so it never equals the raw runtime URL. The guard must compare
// the exact attribute string instead: any `src` assignment (even of the same
// value) navigates the frame, and re-assigning on every effect run reloaded the
// live preview whenever the panel re-rendered (e.g. switching files while
// recording), resetting its scroll/SPA state — and baking spurious reloads into
// recordings, which then replayed as scroll resets.
const RUNTIME_URL = "https://abc--3000--xyz.local-corp.webcontainer-api.io";

describe("runtimePreviewSrcNeedsReset", () => {
  it("requests a reset for a fresh iframe (no src yet)", () => {
    const iframe = document.createElement("iframe");

    expect(runtimePreviewSrcNeedsReset(iframe, RUNTIME_URL)).toBe(true);
  });

  it("does NOT request a reset when the iframe already points at the runtime URL", () => {
    const iframe = document.createElement("iframe");
    iframe.src = RUNTIME_URL;

    // Precondition of the regression: the reflected property is normalized and
    // never string-equal to the assigned origin-only URL.
    expect(iframe.src).not.toBe(RUNTIME_URL);
    expect(iframe.src).toBe(`${RUNTIME_URL}/`);

    expect(runtimePreviewSrcNeedsReset(iframe, RUNTIME_URL)).toBe(false);
  });

  it("requests a reset while a placeholder srcdoc document is showing", () => {
    const iframe = document.createElement("iframe");
    iframe.src = RUNTIME_URL;
    iframe.srcdoc = "<!doctype html><p>placeholder</p>";

    expect(runtimePreviewSrcNeedsReset(iframe, RUNTIME_URL)).toBe(true);
  });

  it("requests a reset when the runtime URL itself changes", () => {
    const iframe = document.createElement("iframe");
    iframe.src = RUNTIME_URL;

    expect(
      runtimePreviewSrcNeedsReset(
        iframe,
        "https://other--3000--xyz.local-corp.webcontainer-api.io",
      ),
    ).toBe(true);
  });
});

describe("normalizePreviewRoute", () => {
  it("keeps absolute paths and roots everything else", () => {
    expect(normalizePreviewRoute("  /todos?done=1#top  ")).toBe("/todos?done=1#top");
    expect(normalizePreviewRoute("todos")).toBe("/todos");
    expect(normalizePreviewRoute("?q=1")).toBe("/?q=1");
    expect(normalizePreviewRoute("#section")).toBe("/#section");
    expect(normalizePreviewRoute("   ")).toBe("/");
  });

  it("takes the path, query and hash of a full URL", () => {
    expect(normalizePreviewRoute(`${RUNTIME_URL}/todos?done=1#top`)).toBe("/todos?done=1#top");
    expect(normalizePreviewRoute(RUNTIME_URL)).toBe("/");
    // A non-special scheme can have an empty pathname.
    expect(normalizePreviewRoute("foo://host")).toBe("/");
  });
});

describe("createRuntimePreviewLocationFromUrl", () => {
  it("derives the route from the preview URL", () => {
    expect(createRuntimePreviewLocationFromUrl(RUNTIME_URL, 3000)?.route).toBe("/");
    expect(createRuntimePreviewLocationFromUrl(`${RUNTIME_URL}/a?b=1#c`, null)?.route).toBe(
      "/a?b=1#c",
    );
  });
});

describe("getPreviewTabTarget", () => {
  // The deployment's shape: the preview's host is a subdomain of the editor's.
  const EDITOR_HOST = "editor.test";
  const PREVIEW_URL = "https://k3j2h1x9ab-5173.editor.test";
  const location = createRuntimePreviewLocationFromUrl(PREVIEW_URL, 5173);

  it("is the live preview's address, at the route it shows", () => {
    expect(getPreviewTabTarget(location, true, EDITOR_HOST)).toEqual({ url: `${PREVIEW_URL}/` });
    expect(
      getPreviewTabTarget(
        applyRouteToRuntimePreviewLocation(location, "/todos?done=1#top"),
        true,
        EDITOR_HOST,
      ),
    ).toEqual({ url: `${PREVIEW_URL}/todos?done=1#top` });
  });

  it("has no address while no live runtime answers there", () => {
    // A replay, or a recorded snapshot's address: its runtime session is gone.
    const none = { url: null, reason: "no-live-preview" };
    expect(getPreviewTabTarget(location, false, EDITOR_HOST)).toEqual(none);
    expect(getPreviewTabTarget(null, true, EDITOR_HOST)).toEqual(none);
    // An unparsable preview URL is kept as is for the address bar's label.
    expect(
      getPreviewTabTarget(
        createRuntimePreviewLocationFromUrl("not a url", 3000),
        true,
        EDITOR_HOST,
      ),
    ).toEqual(none);
  });

  it("has no address where the browser would keep the tab apart from the editor's frame", () => {
    // A dev server: every *.localhost is a site of its own, so the tab would
    // find no service worker and show the "not connected" page.
    const dev = createRuntimePreviewLocationFromUrl("http://k3j2h1x9ab-5173.localhost:5173", 5173);
    expect(getPreviewTabTarget(dev, true, "localhost")).toEqual({
      url: null,
      reason: "separate-site",
    });
  });
});

describe("previewTabSharesEditorSite", () => {
  it("holds for a preview on a subdomain of the editor's host", () => {
    expect(
      previewTabSharesEditorSite("https://abcdefghij-4173.nexteditor.dev/", "nexteditor.dev"),
    ).toBe(true);
    expect(
      previewTabSharesEditorSite("https://ABCDEFGHIJ-4173.NextEditor.dev/a", "nexteditor.DEV"),
    ).toBe(true);
  });

  it("does not hold for a host with no domain of its own, or for another site", () => {
    expect(previewTabSharesEditorSite("http://abcdefghij-5173.localhost:5173/", "localhost")).toBe(
      false,
    );
    expect(previewTabSharesEditorSite("http://abcdefghij-5173.127.0.0.1/", "127.0.0.1")).toBe(
      false,
    );
    expect(previewTabSharesEditorSite("http://abcdefghij-5173.localhost/", "[::1]")).toBe(false);
    expect(previewTabSharesEditorSite("https://abcdefghij-4173.other.dev/", "nexteditor.dev")).toBe(
      false,
    );
    // Not a subdomain: only the same suffix.
    expect(previewTabSharesEditorSite("https://evilnexteditor.dev/", "nexteditor.dev")).toBe(false);
    expect(previewTabSharesEditorSite("not a url", "nexteditor.dev")).toBe(false);
  });
});
