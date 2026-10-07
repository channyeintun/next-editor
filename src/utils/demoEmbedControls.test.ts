import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { isLandingDemoFrame } from "./demoEmbedControls";

const DEMO_SEARCH = "?url=/lessons/introduction/introduction.ne&readOnly=true&largeControls=true";

function frameAt(search: string, parent: object) {
  window.history.replaceState(null, "", `/code${search}`);
  vi.spyOn(window, "parent", "get").mockReturnValue(parent as Window);
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("isLandingDemoFrame", () => {
  it("is the landing page's demo: both flags, framed by this origin", () => {
    frameAt(DEMO_SEARCH, { location: { origin: window.location.origin } });
    expect(isLandingDemoFrame()).toBe(true);
  });

  it("is not a top-level visit to the same URL", () => {
    window.history.replaceState(null, "", `/code${DEMO_SEARCH}`);
    expect(isLandingDemoFrame()).toBe(false);
  });

  it("is not another same-origin frame", () => {
    frameAt("?url=/lessons/introduction/introduction.ne&readOnly=true", {
      location: { origin: window.location.origin },
    });
    expect(isLandingDemoFrame()).toBe(false);
  });

  it("is not a third-party frame, whose location can't be read", () => {
    frameAt(DEMO_SEARCH, {
      get location(): never {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
    });
    expect(isLandingDemoFrame()).toBe(false);
  });
});
