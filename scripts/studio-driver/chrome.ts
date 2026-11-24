/**
 * System Chrome, for the two ways the driver starts it: driven by Playwright
 * (every command but `login`), and on its own for `login`, where a person signs
 * in. Google's sign-in may refuse a browser that automation drives, so `login`
 * starts Chrome with no automation at all.
 */

import { join } from "node:path";

/**
 * The places Chrome's binary is installed, most usual first. `--chrome=<path>`
 * names another.
 */
export function chromeCandidates(
  platform: NodeJS.Platform,
  env: { home: string; localAppData?: string; programFiles?: string; programFilesX86?: string },
): string[] {
  switch (platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        join(env.home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      ];
    case "win32":
      return [env.localAppData, env.programFiles, env.programFilesX86]
        .filter((dir): dir is string => Boolean(dir))
        .map((dir) => `${dir}\\Google\\Chrome\\Application\\chrome.exe`);
    default:
      return [
        "/opt/google/chrome/chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
      ];
  }
}

/**
 * Chrome's flags for `login`. Playwright launches Chrome with
 * `--use-mock-keychain --password-store=basic`, which keep cookies encrypted
 * with a key of Chrome's own rather than the system keychain's; a profile is
 * readable only by launches that use the same two flags. So the person signs
 * in under them too, and the driven launches after can read the cookie. The
 * profile must never be opened in a plain Chrome for the same reason.
 */
export function loginChromeArgs(profile: string, pageUrl: string): string[] {
  return [
    `--user-data-dir=${profile}`,
    "--use-mock-keychain",
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    pageUrl,
  ];
}

/**
 * A Chrome started on a profile another Chrome holds hands its window to that
 * one and exits at once. A `login` window that closes this soon was never the
 * person's.
 */
export const LOGIN_EXITED_AT_ONCE_MS = 5_000;
