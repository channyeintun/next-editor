// The real editor on a served build, in headless Chrome: the page a visitor
// gets, not the harness page. It opens the editor's default project twice in
// one browser profile and checks that
//   - the runtime that booted is webnode, of the build the server names;
//   - the project's preview renders its page, both times;
//   - a minute into the first visit the editor's page keeps the prepared
//     forms of the project's large modules (src/core/webnode/preparedStorage.ts),
//     and the second visit asks for them again.
// For the built files before a deploy (a local Worker serving dist/), and for
// production after one:
//
//   bun run build
//   npx wrangler dev --config infra/wrangler.toml --port 8788 \
//     --infer-origin-from-routes=false --var WEBNODE_PREVIEW_HOST:localhost \
//     --var PUBLIC_URL:http://localhost:8788
//   bun scripts/webnode-scenarios/editor-check.ts http://localhost:8788
//
//   bun scripts/webnode-scenarios/editor-check.ts https://nexteditor.dev
//
// VISITS=1 opens it once and skips what needs a second visit. PREVIEW_WAIT=<s>
// (240) is how long a preview may take: the install is the registry's speed.
// Exit status 0 only when every check held.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";

const origin = new URL(process.argv[2] ?? "http://localhost:8788").origin;
const visits = Number(process.env.VISITS ?? 2);
/** What the default project's page shows once its dev server answers. */
const PREVIEW_TEXT = "Welcome to TanStack Start";
/** The kernel has an entry made a minute after the last module was asked for, then hands it over. */
const KEPT_AFTER_MS = 80_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const failures: string[] = [];

function check(label: string, holds: boolean, detail = ""): void {
  console.log(`${holds ? "ok  " : "FAIL"} ${label}${holds || !detail ? "" : `\n     ${detail}`}`);
  if (!holds) {
    failures.push(label);
  }
}

interface KeptRecord {
  key: string;
  version: string;
  size: number;
  usedAt: number;
}

/** What the editor's page keeps of prepared modules: its IndexedDB records. */
function keptRecords(page: Page): Promise<KeptRecord[]> {
  return page.evaluate(
    () =>
      new Promise<KeptRecord[]>((resolve) => {
        const open = indexedDB.open("webnode-prepared-modules");
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains("records")) {
            database.close();
            resolve([]);
            return;
          }
          const all = database.transaction("records").objectStore("records").getAll();
          all.onsuccess = () => {
            database.close();
            resolve(all.result as KeptRecord[]);
          };
          all.onerror = () => {
            database.close();
            resolve([]);
          };
        };
      }),
  );
}

/** Waits until the editor's preview frame shows the default project's page. */
async function previewShown(
  page: Page,
  timeoutMs: number,
): Promise<{ ms: number; url: string } | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || !/^https?:\/\/[a-z0-9]+-\d+\./.test(frame.url())) {
        continue;
      }
      try {
        const text = await frame.evaluate(() => document.body?.innerText ?? "");
        if (text.includes(PREVIEW_TEXT)) {
          return { ms: Date.now() - started, url: new URL(frame.url()).origin };
        }
      } catch {
        // The frame is navigating.
      }
    }
    await sleep(500);
  }
  return null;
}

const profile = mkdtempSync(join(tmpdir(), "webnode-editor-check-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: true,
  viewport: { width: 1440, height: 900 },
});
try {
  const served = (await (await fetch(`${origin}/webnode/build.json`)).json()) as { id: string };
  console.log(`${origin}: runtime build ${served.id}`);
  let firstUse: KeptRecord[] = [];
  for (let visit = 1; visit <= visits; visit += 1) {
    console.log(`\n== visit ${visit}`);
    const page = await context.newPage();
    const errors: string[] = [];
    const scripts: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message.slice(0, 200)));
    page.on("console", (message) => {
      if (message.type() === "warning" && message.text().includes("webnode did not start")) {
        errors.push(message.text().slice(0, 200));
      }
    });
    page.on("request", (request) => {
      if (/\/__webnode__\/(kernel|process)\.js/.test(request.url())) {
        scripts.push(request.url().replace(/^https?:\/\/[^/]+/, ""));
      }
    });
    await page.goto(`${origin}/code`, { waitUntil: "domcontentloaded" });
    // A first visit starts with the tour over the page: closed, as a visitor closes it.
    await page
      .getByRole("button", { name: "Close", exact: true })
      .click({ timeout: 15_000 })
      .catch(() => undefined);
    // The preview's frame exists only while its panel is open, and the panel starts closed.
    await page.getByRole("button", { name: "Preview", exact: true }).click({ timeout: 60_000 });
    const shown = await previewShown(page, Number(process.env.PREVIEW_WAIT ?? 240) * 1000);
    // What the editor's terminals show, for a preview that never came.
    const terminals = shown
      ? ""
      : await page.evaluate(() =>
          [...document.querySelectorAll(".xterm-rows")]
            .map((rows) => (rows as HTMLElement).innerText.replace(/\n{2,}/g, "\n").slice(-1200))
            .join("\n---\n"),
        );
    check(
      `the preview shows the default project's page${shown ? ` (${(shown.ms / 1000).toFixed(1)} s, ${shown.url})` : ""}`,
      shown !== null,
      `frames: ${page
        .frames()
        .map((frame) => frame.url().slice(0, 80))
        .join(" | ")}\n     the terminals show:\n${terminals}`,
    );
    check(
      "the runtime is webnode, of the build the server names",
      scripts.length > 0 && scripts.every((url) => url.includes(`v=${served.id}`)),
      `scripts asked for: ${[...new Set(scripts)].join(", ") || "none"}`,
    );
    check("no page error, and webnode did not fall back", errors.length === 0, errors.join(" || "));
    if (visit === 1 && shown) {
      await sleep(KEPT_AFTER_MS);
      firstUse = await keptRecords(page);
      const megabytes = firstUse.reduce((sum, record) => sum + record.size, 0) / 2 ** 20;
      check(
        `a minute on, the page keeps the project's large modules (${firstUse.length}, ${megabytes.toFixed(1)} MB)`,
        firstUse.length > 0,
      );
    }
    if (visit === 2 && shown) {
      const again = await keptRecords(page);
      const asked = again.filter((record) =>
        firstUse.some((first) => first.key === record.key && record.usedAt > first.usedAt),
      );
      check(
        `the second visit asked for what was kept (${asked.length} of ${firstUse.length})`,
        firstUse.length > 0 && asked.length > 0,
      );
    }
    await page.close();
  }
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `\nFAIL: ${failures.join("; ")}` : "\nPASS");
process.exit(failures.length ? 1 : 0);
