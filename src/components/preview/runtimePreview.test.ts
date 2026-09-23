import { describe, expect, it } from "vite-plus/test";
import {
  createRuntimePreviewLocationFromUrl,
  normalizePreviewRoute,
  runtimePreviewSrcNeedsReset,
} from "./runtimePreview";

// The WebContainer server-ready URL is origin-only (no trailing slash). The
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
