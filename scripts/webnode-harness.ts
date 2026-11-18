// Runs the webnode runtime in a real browser, for development and for the
// conformance cases in src/core/webnode/test/cases.
//
//   bun scripts/webnode-harness.ts serve            build, serve, and wait (open the printed URL)
//   bun scripts/webnode-harness.ts run '<command>'  run one shell command line and print its output
//   bun scripts/webnode-harness.ts cases [filter]   run each case under real node and under webnode
//   bun scripts/webnode-harness.ts script <file>    run a scenario script (default export: (api) => Promise)
//
// A scenario passes by returning and fails by throwing: the steps it is given
// (src/core/webnode/test/scenario.ts) throw when they do not hold. `run`,
// `cases` and `script` exit with a status other than 0 when what they ran
// failed, and so does every mode when the harness cannot take its port
// (WEBNODE_HARNESS_PORT, 5199 unless set).
//
// WEBNODE_HARNESS_MINIFY=1 builds the runtime's scripts minified, as a
// deployment ships them. WEBNODE_HARNESS_FS=kernel runs on the filesystem
// inside the kernel worker, to compare with the shared one.
//
// WEBNODE_HARNESS_TARGET=<editor origin> runs `run`, `cases` and `script`
// against hosts something else serves: a `wrangler dev` listener
// (http://localhost:8787, whose hosts are *.localhost:8787), or the deployment
// (https://nexteditor.dev, with WEBNODE_HARNESS_PREVIEW_HOST=<the domain its
// runtime and preview hosts live under>). The harness page is put on the
// editor origin by request interception; the hosts are the real ones.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { buildWebnodeBundles } from "../build/webnodeBundle";
import { webnodeHostAsset, webnodeHostResponse } from "../src/core/webnode/preview/hostResponses";
import { ScenarioFailure, failureMessage, scenarioTools } from "../src/core/webnode/test/scenario";
import type { PreviewFrame, ScenarioTools } from "../src/core/webnode/test/scenario";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// A second harness run at the same time needs its own port and build directory.
// `||`: an empty value must not make the repository root the output directory.
const OUT_DIR = resolve(ROOT, process.env.WEBNODE_HARNESS_OUT || "node_modules/.cache/webnode");
const CASES_DIR = resolve(ROOT, "src/core/webnode/test/cases");
const PORT = Number(process.env.WEBNODE_HARNESS_PORT ?? 5199);
/** The editor origin of a server that already serves the webnode hosts, when testing one. */
const TARGET = process.env.WEBNODE_HARNESS_TARGET
  ? new URL(process.env.WEBNODE_HARNESS_TARGET).origin
  : null;
/** The host a target's runtime and preview hosts live under, when it is not the editor's own. */
const TARGET_PREVIEW_HOST = process.env.WEBNODE_HARNESS_PREVIEW_HOST?.trim() || null;
/** Where the harness page lives on a target origin: a path the target never serves itself. */
const TARGET_PAGE_PATH = "/__webnode_harness__/";

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Cache-Control": "no-store",
};

const harnessHtml = (
  scriptUrl: string,
) => `<!doctype html><meta charset="utf-8"><title>webnode harness</title>
<body style="font:14px system-ui;margin:24px"><h1>webnode harness</h1>
<p>Open the console: <code>await webnodeHarness.boot()</code>, then <code>await webnodeHarness.run("sh", ["-c", "echo hi"])</code>.</p>
<iframe id="preview" style="width:100%;height:60vh;border:1px solid #888"></iframe>
<script src="${scriptUrl}"></script></body>`;

export async function buildAll(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await Promise.all([
    buildWebnodeBundles({ outDir: OUT_DIR, minify: process.env.WEBNODE_HARNESS_MINIFY === "1" }),
    build({
      input: resolve(ROOT, "src/core/webnode/test/harnessPage.ts"),
      platform: "browser",
      logLevel: "warn",
      output: { file: resolve(OUT_DIR, "harness.js"), format: "iife", codeSplitting: false },
    }),
  ]);
}

export async function serve(): Promise<{ stop(): void; url: string }> {
  const file = (name: string) => readFileSync(resolve(OUT_DIR, name), "utf8");

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://internal");
    const hostname = (request.headers.host ?? "").split(":")[0];
    const send = (status: number, headers: Record<string, string>, body: string) => {
      response.writeHead(status, headers);
      response.end(body);
    };
    const script = (name: string) =>
      send(
        200,
        { ...ISOLATION_HEADERS, "Content-Type": "text/javascript; charset=utf-8" },
        file(name),
      );

    if (hostname !== "localhost" && hostname.endsWith(".localhost")) {
      // A preview or runtime host: nothing of the harness page is served there.
      const asset = webnodeHostAsset(url.pathname);
      const header = (name: string) => {
        const value = request.headers[name];
        return typeof value === "string" ? value : null;
      };
      const answer = webnodeHostResponse(url.pathname, {
        editorOrigin: `http://localhost:${PORT}`,
        assetSource: asset ? file(asset) : null,
        method: request.method,
        requestOrigin: header("origin"),
        destination: header("sec-fetch-dest"),
      });
      send(answer.status, answer.headers, answer.body);
      return;
    }

    switch (url.pathname) {
      case "/":
        send(
          200,
          { ...ISOLATION_HEADERS, "Content-Type": "text/html; charset=utf-8" },
          harnessHtml("/harness.js"),
        );
        return;
      case "/harness.js":
        script("harness.js");
        return;
      default:
        send(404, ISOLATION_HEADERS, "not found");
    }
  });
  await new Promise<void>((ready, failed) => {
    // A port another run holds: say so and fail, instead of waiting for ever.
    server.once("error", (error: NodeJS.ErrnoException) =>
      failed(
        new Error(
          `the harness cannot listen on port ${PORT} (${error.code ?? error.message}): ` +
            "another run holds it, name a free one in WEBNODE_HARNESS_PORT",
        ),
      ),
    );
    server.listen(PORT, "127.0.0.1", ready);
  });
  return {
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
    url: `http://localhost:${PORT}/`,
  };
}

export interface HarnessApi extends ScenarioTools {
  page: Page;
  /** Calls a method of `window.webnodeHarness`. */
  call<T>(method: string, ...args: unknown[]): Promise<T>;
  /** Runs a shell command line to its exit. */
  sh(
    line: string,
    options?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<{ code: number | null; output: string; timedOut: boolean }>;
  /** What the scenario's sections reported as failed so far. */
  readonly failures: readonly string[];
}

/** What the harness page reads from its address (test/harnessPage.ts). */
function pageQuery(): string {
  const query = new URLSearchParams();
  if (TARGET_PREVIEW_HOST) {
    query.set("previewHost", TARGET_PREVIEW_HOST);
  }
  if (process.env.WEBNODE_HARNESS_FS === "kernel") {
    query.set("fs", "kernel");
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** Puts the harness page on the target origin; every other request reaches the target. */
async function interceptHarnessPage(page: Page, target: string): Promise<string> {
  const script = readFileSync(resolve(OUT_DIR, "harness.js"), "utf8");
  await page.route(`${target}${TARGET_PAGE_PATH}**`, (route) => {
    const isScript = new URL(route.request().url()).pathname.endsWith("/harness.js");
    return route.fulfill({
      status: 200,
      headers: {
        ...ISOLATION_HEADERS,
        "Content-Type": isScript ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
      },
      body: isScript ? script : harnessHtml(`${TARGET_PAGE_PATH}harness.js`),
    });
  });
  return `${target}${TARGET_PAGE_PATH}${pageQuery()}`;
}

/** The title of the page a preview origin serves before a runtime is connected (preview/connectPage.ts). */
const PREVIEW_CONNECT_TITLE = "Connecting to preview…";

/** The page's preview frame (the `<iframe id="preview">` of `harnessHtml`), for a scenario's steps. */
function previewFrame(page: Page): PreviewFrame {
  const frameOf = (url: string) => page.frames().find((frame) => frame.url().startsWith(url));
  return {
    async show(url) {
      await page.evaluate((address) => {
        (document.getElementById("preview") as HTMLIFrameElement).src = address;
      }, url);
    },
    async read(url) {
      try {
        const view = await frameOf(url)?.evaluate(() => ({
          title: document.title,
          text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim(),
          overlay:
            document
              .querySelector("vite-error-overlay")
              ?.shadowRoot?.textContent?.replace(/\s+/g, " ")
              .trim() ?? null,
        }));
        // Until the editor connects it, a preview origin shows a page of its own.
        return view && view.title !== PREVIEW_CONNECT_TITLE ? view : null;
      } catch {
        // The frame is navigating: it has no document to ask.
        return null;
      }
    },
    async click(url, selector) {
      const frame = frameOf(url);
      if (!frame) {
        throw new ScenarioFailure(`no preview of ${url} to click ${selector} in`);
      }
      await frame.click(selector);
    },
  };
}

export async function withBrowser<T>(use: (api: HarnessApi) => Promise<T>): Promise<T> {
  if (TARGET && !TARGET_PREVIEW_HOST && new URL(TARGET).hostname !== "localhost") {
    throw new Error(
      "WEBNODE_HARNESS_TARGET is a deployment: name the domain of its runtime hosts in WEBNODE_HARNESS_PREVIEW_HOST",
    );
  }
  const server = TARGET ? null : await serve();
  const browser = await chromium.launch({
    channel: "chrome",
    headless: process.env.WEBNODE_HARNESS_HEADED !== "1",
    // An intercepted page has no address, so Chrome takes it for a public one
    // and refuses to let it frame a loopback target's hosts.
    args:
      TARGET && new URL(TARGET).hostname === "localhost"
        ? ["--disable-features=LocalNetworkAccessChecks"]
        : [],
  });
  try {
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (process.env.WEBNODE_HARNESS_CONSOLE === "1" || message.type() === "error") {
        console.error(`[browser ${message.type()}] ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => console.error(`[browser pageerror] ${error.message}`));
    page.on("requestfailed", (request) => {
      if (process.env.WEBNODE_HARNESS_CONSOLE === "1") {
        console.error(`[browser requestfailed] ${request.url()} ${request.failure()?.errorText}`);
      }
    });
    await page.goto(
      server ? `${server.url}${pageQuery()}` : await interceptHarnessPage(page, TARGET!),
    );
    const call = <R>(method: string, ...args: unknown[]) =>
      page.evaluate(
        ([name, parameters]) =>
          (
            window as unknown as {
              webnodeHarness: Record<string, (...args: unknown[]) => unknown>;
            }
          ).webnodeHarness[name as string](...(parameters as unknown[])),
        [method, args] as const,
      ) as Promise<R>;
    await call("boot");
    const { tools, failures } = scenarioTools(call, previewFrame(page));
    return await use({
      ...tools,
      page,
      call,
      sh: (line, options) => call("run", "sh", ["-c", line], options ?? {}),
      failures,
    });
  } finally {
    await browser.close();
    server?.stop();
  }
}

async function runCases(filter: string | undefined): Promise<number> {
  const names = readdirSync(CASES_DIR)
    .filter((name) => /\.(?:c|m)?js$/.test(name) && (!filter || name.includes(filter)))
    .sort();
  let failures = 0;
  await withBrowser(async (api) => {
    for (const name of names) {
      const source = readFileSync(resolve(CASES_DIR, name), "utf8");
      // Real Node runs the case in an empty directory, as webnode does.
      const sandbox = mkdtempSync(resolve(tmpdir(), "webnode-case-"));
      writeFileSync(resolve(sandbox, name), source);
      const expected = spawnSync("node", [name], {
        cwd: sandbox,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      rmSync(sandbox, { recursive: true, force: true });
      await api.call("mount", { [name]: { file: { contents: source } } });
      const actual = await api.call<{ code: number | null; output: string }>(
        "run",
        "node",
        [name],
        { env: { NO_COLOR: "1" }, timeoutMs: 20000 },
      );
      const want = (expected.stdout + expected.stderr).trimEnd();
      const got = actual.output.trimEnd();
      if (want === got && expected.status === actual.code) {
        console.log(`ok   ${name}`);
      } else {
        failures += 1;
        console.log(`FAIL ${name} (exit ${actual.code}, node ${expected.status})`);
        console.log(`--- node\n${want}\n--- webnode\n${got}\n---`);
      }
    }
  });
  console.log(`${names.length - failures}/${names.length} cases match`);
  return failures;
}

/** Runs a scenario script. Answers the exit status: 0 only when every step held. */
async function runScenario(file: string): Promise<number> {
  const scenario = (await import(file)) as { default: (api: HarnessApi) => Promise<void> };
  const failures: string[] = [];
  try {
    await withBrowser(async (api) => {
      try {
        await scenario.default(api);
      } finally {
        failures.push(...api.failures);
      }
    });
  } catch (error) {
    failures.push(failureMessage(error));
  }
  if (failures.length === 0) {
    console.log(`\nPASS ${basename(file)}`);
    return 0;
  }
  console.log(`\nFAIL ${basename(file)}: ${failures.length} failed`);
  for (const failure of failures) {
    console.log(`- ${failure}`);
  }
  return 1;
}

if (import.meta.main) {
  const [mode, argument] = process.argv.slice(2);
  await buildAll();
  if (mode === "serve") {
    const server = await serve();
    console.log(`webnode harness at ${server.url}`);
    await new Promise(() => {});
  } else if (mode === "run") {
    const result = await withBrowser((api) => api.sh(argument ?? "echo hello"));
    process.stdout.write(result.output);
    console.log(`\n[exit ${result.code}${result.timedOut ? ", timed out" : ""}]`);
    process.exit(result.code === 0 ? 0 : 1);
  } else if (mode === "cases") {
    process.exit((await runCases(argument)) === 0 ? 0 : 1);
  } else if (mode === "script" && argument) {
    process.exit(await runScenario(resolve(argument)));
  } else {
    console.error(
      "usage: bun scripts/webnode-harness.ts serve | run '<command>' | cases [filter] | script <file>",
    );
    process.exit(2);
  }
}
