import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { isApplePlatform, isImeComposingKey, isLetterKey } from "./keyboardPlatform";

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

describe("isImeComposingKey", () => {
  it("is true while composing and for Safari's committing key, false otherwise", () => {
    expect(isImeComposingKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposingKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe("isLetterKey", () => {
  const key = (init: Partial<KeyboardEvent>) => ({
    key: "s",
    code: "KeyS",
    altKey: false,
    ...init,
  });

  it("reads the letter the layout types, in either case", () => {
    expect(isLetterKey(key({}), "s")).toBe(true);
    expect(isLetterKey(key({ key: "S" }), "s")).toBe(true);
  });

  it("falls back to the physical key where the layout types no Latin letter", () => {
    expect(isLetterKey(key({ key: "ы" }), "s")).toBe(true);
    expect(isLetterKey(key({ key: "ပ", code: "KeyP" }), "p")).toBe(true);
    expect(isLetterKey(key({ key: "ы" }), "z")).toBe(false);
  });

  it("lets a Latin letter win over the physical key, so Dvorak and AZERTY keep theirs", () => {
    // Dvorak types s on the physical O.
    expect(isLetterKey(key({ key: "s", code: "KeyO" }), "s")).toBe(true);
    expect(isLetterKey(key({ key: "s", code: "KeyO" }), "o")).toBe(false);
    expect(isLetterKey(key({ key: "a", code: "KeyS" }), "s")).toBe(false);
  });

  it("leaves a character picked with AltGr or Option to the layout", () => {
    // Polish AltGr+S types ś; Windows reports it with Ctrl and Alt held.
    expect(isLetterKey(key({ key: "ś", altKey: true }), "s")).toBe(false);
    expect(isLetterKey(key({ key: "s", altKey: true }), "s")).toBe(true);
  });

  it("is false for keys that are not letters", () => {
    expect(isLetterKey(key({ key: "Control", code: "ControlLeft" }), "s")).toBe(false);
    expect(isLetterKey(key({ key: "/", code: "Slash" }), "s")).toBe(false);
  });
});
