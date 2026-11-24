// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chromeCandidates, loginChromeArgs } from "./chrome.ts";

describe("chrome", () => {
  it("looks for Chrome where each platform installs it", () => {
    expect(chromeCandidates("darwin", { home: "/Users/me" })).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]);
    expect(chromeCandidates("linux", { home: "/home/me" })[0]).toBe("/opt/google/chrome/chrome");
    expect(
      chromeCandidates("win32", { home: "C:\\Users\\me", programFiles: "C:\\Program Files" }),
    ).toEqual(["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]);
  });

  it("starts the login Chrome with the cookie storage Playwright's launches can read", () => {
    expect(loginChromeArgs("/p", "https://nexteditor.dev/studio")).toEqual([
      "--user-data-dir=/p",
      "--use-mock-keychain",
      "--password-store=basic",
      "--no-first-run",
      "--no-default-browser-check",
      "https://nexteditor.dev/studio",
    ]);
  });
});
