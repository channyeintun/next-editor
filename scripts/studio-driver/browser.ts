/**
 * The driver's one browser: system Chrome on the driver's own profile,
 * launched once per process, and the reads and calls it makes into /studio.
 *
 * Once per process because a second Chrome launch inside one bun process has
 * lost its DevTools pipe before, and then every call into the page hangs for
 * ever. For the same reason every call into the page has a timeout here.
 */

import { mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { StudioAutomation, StudioWindowHandle } from "../../src/studio/studioWindowHandle.ts";
import type { PageEnvironment } from "./guards.ts";
import { authMeUrl, isLoopbackUrl, studioPageUrl } from "./site.ts";
import { HOST_SESSION_COOKIE, SESSION_COOKIE } from "./localSession.ts";
import { EVALUATE_TIMEOUT_MS, PAGE_LOAD_TIMEOUT_MS, POLL_MS } from "./waits.ts";

/**
 * Every driven launch uses these, so `login`'s check, `render` and `workflow`
 * lay the studio out alike and like earlier recordings: Playwright's own
 * default viewport is 1280×720. Narration starts without a click.
 */
export const LAUNCH_OPTIONS = {
  channel: "chrome",
  viewport: { width: 1440, height: 900 },
  args: ["--autoplay-policy=no-user-gesture-required"],
} as const;

/** An error a person can act on, printed as it is with no stack. */
export class DriverError extends Error {}

let launched = false;

function profileInUse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("profile is already in use") ||
    message.includes("ProcessSingleton") ||
    message.includes("Opening in existing browser session")
  );
}

/** Launch Chrome on the profile. Call it once per process. */
export async function launchStudioBrowser(input: {
  profile: string;
  headed: boolean;
}): Promise<BrowserContext> {
  if (launched) throw new Error("the driver launches Chrome once per process");
  launched = true;
  mkdirSync(input.profile, { recursive: true });
  try {
    return await chromium.launchPersistentContext(input.profile, {
      ...LAUNCH_OPTIONS,
      viewport: { ...LAUNCH_OPTIONS.viewport },
      args: [...LAUNCH_OPTIONS.args],
      headless: !input.headed,
    });
  } catch (error) {
    if (profileInUse(error)) {
      throw new DriverError(
        `the profile ${input.profile} is in use by another studio-render command (or a Chrome opened on it); one driver per profile at a time`,
      );
    }
    throw error;
  }
}

/** The context's first tab, which a persistent context opens with. */
export async function firstPage(context: BrowserContext): Promise<Page> {
  return context.pages()[0] ?? (await context.newPage());
}

/** Run `fn` in the page, failing after `timeoutMs` instead of waiting for ever. */
export async function evaluateWithin<R, A>(
  page: Page,
  what: string,
  fn: (arg: A) => R | Promise<R>,
  arg: A,
  timeoutMs: number = EVALUATE_TIMEOUT_MS,
): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DriverError(
            `${what} got no answer from the page in ${Math.round(timeoutMs / 1000)} s`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([page.evaluate(fn as never, arg) as Promise<R>, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The studio's window handle as plain data (its automation functions dropped). */
export async function readHandle(page: Page): Promise<StudioWindowHandle | null> {
  return evaluateWithin(
    page,
    "reading the studio",
    () => {
      const handle = window.__NEXT_EDITOR_STUDIO__;
      return handle ? (JSON.parse(JSON.stringify(handle)) as StudioWindowHandle) : null;
    },
    undefined,
  );
}

type AutomationMethod = {
  [K in keyof StudioAutomation]: StudioAutomation[K] extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof StudioAutomation];

/** Call one automation function in the page and return its answer. */
export async function callAutomation<M extends AutomationMethod>(
  page: Page,
  method: M,
  input: Parameters<StudioAutomation[M]>[0] | undefined,
  timeoutMs: number = EVALUATE_TIMEOUT_MS,
): Promise<Awaited<ReturnType<StudioAutomation[M]>>> {
  return evaluateWithin(
    page,
    `automation.${method}`,
    async ([name, arg]: [string, unknown]) => {
      const automation = window.__NEXT_EDITOR_STUDIO__?.automation as
        | Record<string, (value?: unknown) => unknown>
        | undefined;
      if (!automation) throw new Error("the studio has no automation surface");
      return automation[name](arg);
    },
    [method, input] as [string, unknown],
    timeoutMs,
  ) as Promise<Awaited<ReturnType<StudioAutomation[M]>>>;
}

/**
 * Open the bare studio page and wait for its automation surface. The studio
 * puts one on the window only when the browser is driven (navigator.webdriver).
 */
export async function openStudio(page: Page, site: string): Promise<void> {
  try {
    await page.goto(studioPageUrl(site), {
      waitUntil: "domcontentloaded",
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });
  } catch (error) {
    throw new DriverError(
      `could not open ${studioPageUrl(site)}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}${
        isLoopbackUrl(site) ? " (is `bun run dev` running?)" : ""
      }`,
    );
  }
  if (
    !(await evaluateWithin(
      page,
      "reading navigator.webdriver",
      () => navigator.webdriver,
      undefined,
    ))
  ) {
    throw new DriverError(
      "navigator.webdriver is false: the studio offers its automation surface only to a driven browser",
    );
  }
  const deadline = Date.now() + PAGE_LOAD_TIMEOUT_MS;
  for (;;) {
    const present = await evaluateWithin(
      page,
      "looking for the studio's automation surface",
      () => typeof window.__NEXT_EDITOR_STUDIO__?.automation?.status === "function",
      undefined,
    );
    if (present) return;
    if (Date.now() > deadline) {
      throw new DriverError(
        `${studioPageUrl(site)} has no automation surface after ${Math.round(PAGE_LOAD_TIMEOUT_MS / 1000)} s: the site runs a studio older than this driver, or the page did not load`,
      );
    }
    await sleep(POLL_MS);
  }
}

export interface SignIn {
  signedIn: boolean;
  /** Who, when signed in. */
  user: string | null;
  /** The session cookie's expiry; null when there is no cookie or it lasts for the session only. */
  cookieExpires: Date | null;
  /** Set when the site could not say (for example the dev server's Worker is not running). */
  problem: string | null;
}

/**
 * Whether the profile is signed in on the site: GET /api/auth/me with the
 * profile's cookies. The cookie alone proves nothing (its session row may be
 * gone), so the site's answer decides.
 */
export async function readSignIn(context: BrowserContext, site: string): Promise<SignIn> {
  const cookies = await context.cookies(site);
  const cookie = cookies.find(
    (each) => each.name === SESSION_COOKIE || each.name === HOST_SESSION_COOKIE,
  );
  const cookieExpires = cookie && cookie.expires > 0 ? new Date(cookie.expires * 1000) : null;
  let response;
  try {
    response = await context.request.get(authMeUrl(site), { timeout: EVALUATE_TIMEOUT_MS });
  } catch (error) {
    return {
      signedIn: false,
      user: null,
      cookieExpires,
      problem: `could not ask ${authMeUrl(site)}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    };
  }
  if (response.status() === 401) {
    return { signedIn: false, user: null, cookieExpires, problem: null };
  }
  if (!response.ok()) {
    return {
      signedIn: false,
      user: null,
      cookieExpires,
      problem: `${authMeUrl(site)} answered ${response.status()}${
        response.status() >= 500
          ? " (under bun run dev, is the Worker running? bun run dev:worker)"
          : ""
      }`,
    };
  }
  const body = (await response.json().catch(() => null)) as {
    user?: { email?: string; name?: string; username?: string };
  } | null;
  const user = body?.user;
  return {
    signedIn: Boolean(user),
    user: user ? (user.email ?? user.username ?? user.name ?? "signed in") : null,
    cookieExpires,
    problem: user ? null : `${authMeUrl(site)} answered without a user`,
  };
}

/**
 * Whether the page is visible and how many animation frames it runs in one
 * second. A hidden or starved page paints too seldom for a render.
 */
export async function measurePageEnvironment(page: Page): Promise<PageEnvironment> {
  return evaluateWithin(
    page,
    "measuring the page's frame rate",
    () =>
      new Promise<{ visibilityState: string; framesPerSecond: number }>((done) => {
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - start < 1_000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        // A hidden page runs no frames at all, so the second is timed with a timer.
        setTimeout(
          () => done({ visibilityState: document.visibilityState, framesPerSecond: frames }),
          1_000,
        );
      }),
    undefined,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
