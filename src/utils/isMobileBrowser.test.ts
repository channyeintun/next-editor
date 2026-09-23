import { afterEach, describe, expect, it, vi } from "vitest";
import { isMobileBrowser } from "./isMobileBrowser";

describe("isMobileBrowser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubNavigator = (navigator: Partial<Navigator> & Record<string, unknown>) => {
    vi.stubGlobal("navigator", navigator);
  };

  it("honors the userAgentData.mobile client hint when present", () => {
    stubNavigator({ userAgent: "Mozilla/5.0", userAgentData: { mobile: true } });
    expect(isMobileBrowser()).toBe(true);

    stubNavigator({ userAgent: "Mozilla/5.0", userAgentData: { mobile: false } });
    expect(isMobileBrowser()).toBe(false);
  });

  it("detects phone user agents", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      maxTouchPoints: 5,
    });
    expect(isMobileBrowser()).toBe(true);

    stubNavigator({
      userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile Safari/537.36",
      maxTouchPoints: 5,
    });
    expect(isMobileBrowser()).toBe(true);
  });

  it("treats a touch-capable Macintosh as iPadOS (tablet)", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Safari/605.1.15",
      maxTouchPoints: 5,
    });
    expect(isMobileBrowser()).toBe(true);
  });

  it("treats a real desktop (no touch) as not mobile", () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      maxTouchPoints: 0,
    });
    expect(isMobileBrowser()).toBe(false);
  });
});
