import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { isApplePlatform } from "./keyboardPlatform";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubNavigator(platform: string, userAgentDataPlatform?: string) {
  vi.stubGlobal("navigator", {
    platform,
    ...(userAgentDataPlatform === undefined
      ? {}
      : { userAgentData: { platform: userAgentDataPlatform } }),
  });
}

describe("isApplePlatform", () => {
  it.each([
    ["MacIntel", true],
    ["iPad", true],
    ["iPhone", true],
    ["Win32", false],
    ["Linux x86_64", false],
    ["", false],
  ])("reads navigator.platform %j", (platform, expected) => {
    stubNavigator(platform);
    expect(isApplePlatform()).toBe(expected);
  });

  it("prefers Client Hints where the browser has them", () => {
    stubNavigator("Win32", "macOS");
    expect(isApplePlatform()).toBe(true);
    stubNavigator("MacIntel", "Windows");
    expect(isApplePlatform()).toBe(false);
  });

  it("is false without a navigator", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isApplePlatform()).toBe(false);
  });
});
