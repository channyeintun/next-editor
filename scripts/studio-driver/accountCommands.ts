/**
 * `login` and `status`: getting the driver's profile signed in on a site, and
 * saying what the studio there would render with.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext } from "playwright-core";
import type { Command, SharedOptions } from "./args.ts";
import {
  callAutomation,
  DriverError,
  firstPage,
  launchStudioBrowser,
  openStudio,
  readSignIn,
  type SignIn,
} from "./browser.ts";
import { chromeCandidates, LOGIN_EXITED_AT_ONCE_MS, loginChromeArgs } from "./chrome.ts";
import { localSessionCommands, localSessionCookie, localSessionSql } from "./localSession.ts";
import { studioPageUrl } from "./site.ts";
import { describeStatus } from "./studioSession.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function describeSignIn(site: string, signIn: SignIn): string {
  if (signIn.problem) return `${site}: cannot tell whether signed in: ${signIn.problem}`;
  if (!signIn.signedIn) return `${site}: not signed in`;
  const expires = signIn.cookieExpires
    ? `; the session cookie expires ${signIn.cookieExpires.toISOString()}`
    : "";
  return `${site}: signed in as ${signIn.user}${expires}`;
}

export async function runStatusCommand(
  context: BrowserContext,
  command: Extract<Command, { kind: "status" }>,
): Promise<boolean> {
  const { url } = command.shared;
  const signIn = await readSignIn(context, url);
  console.log(describeSignIn(url, signIn));
  const page = await firstPage(context);
  await openStudio(page, url);
  const status = await callAutomation(page, "status", undefined);
  console.log(
    `studio: ${status.ready ? "ready" : `not ready${status.waitingFor ? `, waiting for ${status.waitingFor}` : ""}`}`,
  );
  for (const line of describeStatus(status)) console.log(`  ${line}`);
  if (status.renderBlockedReason) console.log(`  render blocked: ${status.renderBlockedReason}`);
  if (status.workflowBlockedReason)
    console.log(`  workflow blocked: ${status.workflowBlockedReason}`);
  console.log("  (all of this is this profile's state for this site only)");
  return true;
}

function findChrome(override: string | null): string {
  if (override) {
    if (!existsSync(override)) throw new DriverError(`--chrome: ${override} does not exist`);
    return override;
  }
  const found = chromeCandidates(process.platform, {
    home: homedir(),
    localAppData: process.env.LOCALAPPDATA,
    programFiles: process.env.PROGRAMFILES,
    programFilesX86: process.env["PROGRAMFILES(X86)"],
  }).find((candidate) => existsSync(candidate));
  if (!found) throw new DriverError("could not find Google Chrome; name it with --chrome=<path>");
  return found;
}

/**
 * `login --url=<site>`: Chrome on the profile with no automation, for a
 * person to sign in; then a driven launch checks the sign-in. Two launches
 * in two shapes, but only the second is Playwright's: the first is a child
 * process the driver only waits for.
 */
async function loginByPerson(shared: SharedOptions, chrome: string): Promise<void> {
  mkdirSync(shared.profile, { recursive: true });
  const page = studioPageUrl(shared.url);
  console.log(`login: opening ${page} in Chrome on ${shared.profile}`);
  console.log("  sign in there, then close that Chrome window (quit it) to go on");
  const startedAt = Date.now();
  const code = await new Promise<number | null>((done, fail) => {
    const child = spawn(chrome, loginChromeArgs(shared.profile, page), { stdio: "ignore" });
    child.on("error", fail);
    child.on("exit", (exitCode) => done(exitCode));
  }).catch((error: unknown) => {
    throw new DriverError(
      `could not start ${chrome}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (Date.now() - startedAt < LOGIN_EXITED_AT_ONCE_MS) {
    console.warn(
      `studio-render: warning: Chrome exited at once (code ${code}); the profile may be open in another Chrome or studio-render command`,
    );
  }
}

/**
 * `login --local`: the dev server's local D1 gets the test user and a
 * session, and the profile gets its cookie. Nothing outside this machine's
 * wrangler state and the profile is written.
 */
function mintLocalSession(): { sessionId: string; nowMs: number } {
  const sessionId = randomUUID();
  const nowMs = Date.now();
  for (const args of localSessionCommands(localSessionSql({ sessionId, nowMs }))) {
    console.log(`login: ${args.slice(0, 6).join(" ")} …`);
    const result = spawnSync(args[0], args.slice(1), { cwd: REPO_ROOT, stdio: "inherit" });
    if (result.status !== 0) {
      throw new DriverError(
        `${args.slice(0, 5).join(" ")} failed (exit ${result.status ?? result.signal})`,
      );
    }
  }
  return { sessionId, nowMs };
}

/**
 * Run `login`. It launches the driven browser itself, after the person's
 * Chrome has closed, so the profile is never open twice.
 */
export async function runLoginCommand(
  command: Extract<Command, { kind: "login" }>,
): Promise<boolean> {
  const { shared } = command;
  let minted: { sessionId: string; nowMs: number } | null = null;
  if (command.local) {
    minted = mintLocalSession();
  } else {
    await loginByPerson(shared, findChrome(command.chrome));
  }

  const context = await launchStudioBrowser(shared);
  try {
    if (minted) {
      await context.addCookies([localSessionCookie({ site: shared.url, ...minted })]);
    }
    const signIn = await readSignIn(context, shared.url);
    console.log(describeSignIn(shared.url, signIn));
    if (!signIn.signedIn && command.local && !signIn.problem) {
      console.log(
        "  the session was written to local D1, but the Worker does not see it: is it the same wrangler state (bun run dev:worker)?",
      );
    }
    return signIn.signedIn;
  } finally {
    await context.close();
  }
}
