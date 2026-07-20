/**
 * Unattended studio render command (docs/agent-lesson-production.md §12 M2/M3).
 *
 *   bun scripts/studio-render.ts [slug] [--runtime=fixture|live] [--runs=2]
 *                                [--url=http://localhost:5173] [--out=studio-out]
 *
 * Drives the /studio route in headless Chrome (playwright-core, system Chrome
 * channel — no browser download), performs the requested number of renders,
 * saves the downloaded lesson bundle plus render reports, the repeatability
 * comparison, and diagnostic screenshots, and exits non-zero unless every
 * render passed and the repeatability comparison is clean.
 *
 * Requires a running dev server (`bun run dev`); the script fails fast with
 * that instruction rather than spawning servers behind your back.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";

interface CliOptions {
  slug: string;
  runtime: "fixture" | "live";
  runs: number;
  baseUrl: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    slug: "go-cube-tour",
    runtime: "fixture",
    runs: 2,
    baseUrl: "http://localhost:5173",
    outDir: "studio-out",
  };
  for (const arg of argv) {
    if (arg.startsWith("--runtime=")) {
      const value = arg.slice("--runtime=".length);
      if (value !== "fixture" && value !== "live") {
        throw new Error(`--runtime must be fixture or live, got "${value}"`);
      }
      options.runtime = value;
    } else if (arg.startsWith("--runs=")) {
      options.runs = Math.max(1, Number.parseInt(arg.slice("--runs=".length), 10) || 2);
    } else if (arg.startsWith("--url=")) {
      options.baseUrl = arg.slice("--url=".length);
    } else if (arg.startsWith("--out=")) {
      options.outDir = arg.slice("--out=".length);
    } else if (!arg.startsWith("--")) {
      options.slug = arg;
    }
  }
  return options;
}

interface StudioWindowState {
  runs: { index: number; mode: string; outcome: string; report: unknown; manifest: unknown }[];
  comparison: { id: string; ok: boolean; detail: string }[] | null;
  running: boolean;
}

async function readStudioState(page: Page): Promise<StudioWindowState | null> {
  return page.evaluate(() => {
    const handle = (window as { __NEXT_EDITOR_STUDIO__?: unknown }).__NEXT_EDITOR_STUDIO__;
    return handle ? (JSON.parse(JSON.stringify(handle)) as never) : null;
  });
}

async function waitForRunCount(
  page: Page,
  count: number,
  timeoutMs: number,
): Promise<StudioWindowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readStudioState(page);
    if (state && state.runs.length >= count && !state.running) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for render #${count} to finish`);
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 1_000));
  }
}

const options = parseArgs(process.argv.slice(2));
const outDir = resolve(
  options.outDir,
  `${options.slug}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
mkdirSync(outDir, { recursive: true });

// Fail fast if the dev server isn't up.
try {
  await fetch(options.baseUrl, { signal: AbortSignal.timeout(3_000) });
} catch {
  console.error(`studio-render: no dev server at ${options.baseUrl} — start one with: bun run dev`);
  process.exit(1);
}

console.log(`studio-render: ${options.slug} (${options.runtime}) ×${options.runs} → ${outDir}`);

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});

let exitCode = 0;
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.log(`  [page:error] ${message.text().slice(0, 300)}`);
    }
  });

  const url = `${options.baseUrl}/studio?plan=${encodeURIComponent(options.slug)}&runtime=${options.runtime}&autostart=1`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  let finalState: StudioWindowState | null = null;
  for (let run = 1; run <= options.runs; run++) {
    console.log(`  render #${run}…`);
    if (run > 1) {
      await page.getByRole("button", { name: "Render again" }).click();
    }
    try {
      finalState = await waitForRunCount(page, run, 180_000);
    } catch (error) {
      await page.screenshot({ path: join(outDir, `run-${run}-timeout.png`), fullPage: true });
      throw error;
    }
    const entry = finalState.runs[run - 1];
    console.log(`  render #${run}: ${entry.outcome}`);
    writeFileSync(join(outDir, `run-${run}-report.json`), JSON.stringify(entry.report, null, 2));
    writeFileSync(
      join(outDir, `run-${run}-manifest.json`),
      JSON.stringify(entry.manifest, null, 2),
    );
    if (entry.outcome !== "passed") {
      exitCode = 1;
      await page.screenshot({ path: join(outDir, `run-${run}-failed.png`), fullPage: true });
    }
  }

  // Repeatability verdict (published by the controller after run ≥ 2).
  if (finalState && options.runs >= 2) {
    writeFileSync(join(outDir, "comparison.json"), JSON.stringify(finalState.comparison, null, 2));
    const comparisonOk = Boolean(
      finalState.comparison?.length && finalState.comparison.every((check) => check.ok),
    );
    console.log(`  repeatability: ${comparisonOk ? "PASS" : "FAIL"}`);
    if (!comparisonOk) {
      exitCode = 1;
    }
  }

  // Pull the lesson bundle from the last passing render via the download button.
  const lastEntry = finalState?.runs.at(-1);
  if (lastEntry?.outcome === "passed") {
    const downloads: Promise<void>[] = [];
    page.on("download", (download) => {
      downloads.push(download.saveAs(join(outDir, download.suggestedFilename())));
    });
    await page.getByRole("button", { name: "Download bundle" }).click();
    // Four programmatic downloads fire back-to-back; give them a beat to register.
    await page.waitForTimeout(3_000);
    await Promise.all(downloads);
    console.log(`  bundle: ${downloads.length} files saved`);
  }

  await page.screenshot({ path: join(outDir, "final.png"), fullPage: true });
} catch (error) {
  exitCode = 1;
  console.error(`studio-render: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser.close();
}

console.log(exitCode === 0 ? "studio-render: PASS" : "studio-render: FAIL");
process.exit(exitCode);
