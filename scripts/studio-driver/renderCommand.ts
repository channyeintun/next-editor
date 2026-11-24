/**
 * `render <slug…>` and `update <slug>`: one lesson at a time on a fresh
 * /studio page, started through the studio's automation surface, with each
 * run's report and manifest, the repeatability check and the bundle saved.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import type { StudioRuntimeMode } from "../../src/studio/plan.ts";
import type { RenderSpeed } from "../../src/studio/renderClock.ts";
import type { StudioWindowHandle, StudioWindowRun } from "../../src/studio/studioWindowHandle.ts";
import type { Command } from "./args.ts";
import {
  callAutomation,
  DriverError,
  firstPage,
  measurePageEnvironment,
  openStudio,
  readHandle,
  readSignIn,
  sleep,
} from "./browser.ts";
import { pageEnvironmentWarning, renderVerdict } from "./guards.ts";
import { localScriptText, resolveRenderedScripts } from "./publishedCheck.ts";
import type { RenderedScript } from "./scriptIds.ts";
import { guardStart, waitForReady } from "./studioSession.ts";
import {
  BUNDLE_TIMEOUT_MS,
  POLL_MS,
  renderWaitMsFor,
  WORKFLOW_UPLOAD_ALLOWANCE_MS,
} from "./waits.ts";

/** A folder for one command's output, named so runs never overwrite each other. */
export function outputFolder(out: string, name: string): string {
  const folder = join(out, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(folder, { recursive: true });
  return folder;
}

export function writeJson(folder: string, name: string, value: unknown): void {
  writeFileSync(join(folder, name), `${JSON.stringify(value, null, 2)}\n`);
}

// Whether this process has measured the page yet: once is enough to tell
// whether a driven Chrome paints like a visible tab.
let environmentMeasured = false;

async function recordPageEnvironment(page: Page, folder: string): Promise<void> {
  if (environmentMeasured) return;
  environmentMeasured = true;
  const environment = await measurePageEnvironment(page);
  writeJson(folder, "page-environment.json", environment);
  console.log(
    `  page: ${environment.visibilityState}, ${environment.framesPerSecond} animation frames per second`,
  );
  const warning = pageEnvironmentWarning(environment);
  if (warning) console.warn(`studio-render: warning: ${warning}`);
}

/** Poll the handle until the run count passes `before` and nothing runs; fail at once on `fatal`. */
async function waitForRun(
  page: Page,
  slug: string,
  before: number,
  waitMs: number,
): Promise<StudioWindowHandle> {
  const deadline = Date.now() + waitMs;
  let waitingFor: string | null = null;
  for (;;) {
    const handle = await readHandle(page);
    if (handle?.fatal) throw new DriverError(`${slug}: ${handle.fatal}`);
    if (handle && handle.runs.length > before && !handle.running) return handle;
    const now = handle?.waitingFor ?? null;
    if (now && now !== waitingFor) console.log(`  waiting for ${now}`);
    waitingFor = now;
    if (Date.now() > deadline) {
      throw new DriverError(
        `${slug}: the render did not finish in ${Math.round(waitMs / 60_000)} min${waitingFor ? ` (waiting for ${waitingFor})` : ""}`,
      );
    }
    await sleep(POLL_MS);
  }
}

export interface LessonRenderResult {
  runs: StudioWindowRun[];
  passed: boolean;
}

/**
 * Render one lesson `runs` times on the open studio page and save what each
 * run left. The page must be open and checked (waitForReady, guardStart).
 */
async function renderLessonRuns(input: {
  page: Page;
  slug: string;
  runtime: StudioRuntimeMode | null;
  speed: RenderSpeed;
  runs: number;
  folder: string;
}): Promise<LessonRenderResult> {
  const { page, slug, folder } = input;
  // Sized from the local script when there is one; the studio renders the
  // site's, which the published check has already said is the same or chosen.
  const waitMs = renderWaitMsFor(localScriptText(slug));
  console.log(
    `${slug}: ${input.runtime ?? "default runtime"}, ${input.speed} speed, ×${input.runs} → ${folder} (up to ${Math.round(waitMs / 60_000)} min per render)`,
  );
  await recordPageEnvironment(page, folder);

  const runs: StudioWindowRun[] = [];
  let handle: StudioWindowHandle | null = null;
  for (let run = 1; run <= input.runs; run++) {
    const before = (await readHandle(page))?.runs.length ?? 0;
    const started = await callAutomation(page, "startRender", {
      slug,
      ...(input.runtime ? { runtimeMode: input.runtime } : {}),
      speed: input.speed,
    });
    if ("refused" in started)
      throw new DriverError(`${slug}: the studio did not start: ${started.refused}`);
    try {
      handle = await waitForRun(page, slug, before, waitMs);
    } catch (error) {
      await page
        .screenshot({ path: join(folder, `run-${run}-stopped.png`), fullPage: true })
        .catch(() => {});
      throw error;
    }
    const entry = handle.runs[handle.runs.length - 1];
    runs.push(entry);
    console.log(
      `  render #${run}: ${entry.outcome}${entry.report.clock ? ` (${entry.report.clock} clock)` : ""}`,
    );
    writeJson(folder, `run-${run}-report.json`, entry.report);
    writeJson(folder, `run-${run}-manifest.json`, entry.manifest);
    if (entry.outcome !== "passed") {
      await page
        .screenshot({ path: join(folder, `run-${run}-failed.png`), fullPage: true })
        .catch(() => {});
    }
  }

  const verdict = renderVerdict(runs, handle?.comparison ?? null, input.runs);
  if (verdict.comparisonClean !== null) {
    writeJson(folder, "comparison.json", handle?.comparison ?? null);
    console.log(`  repeatability: ${verdict.comparisonClean ? "PASS" : "FAIL"}`);
  }

  if (runs.at(-1)?.outcome === "passed") {
    const bundle = await callAutomation(page, "latestBundle", undefined, BUNDLE_TIMEOUT_MS);
    if (bundle) {
      for (const file of bundle) {
        writeFileSync(join(folder, file.name), Buffer.from(file.base64, "base64"));
      }
      console.log(`  bundle: ${bundle.map((file) => file.name).join(", ")}`);
    } else {
      console.log("  bundle: the studio kept none");
    }
  }
  await page.screenshot({ path: join(folder, "final.png"), fullPage: true }).catch(() => {});
  return { runs, passed: verdict.passed };
}

/** Write which published script a folder's renders performed. */
function writeRenderedScript(
  folder: string,
  site: string,
  script: RenderedScript | undefined,
): void {
  writeJson(folder, "script.json", script ? { site, ...script } : { site, id: null });
}

/**
 * The driver opens the studio with no lesson of its own selected, so the
 * reason the page's Start button shows belongs to the studio's default lesson,
 * not to the one about to render. `startRender` gives the reason for the
 * lesson it is asked for, so readiness here waits only for the studio itself.
 */
const NO_PAGE_WIDE_REASON = (): null => null;

export async function runRenderCommand(
  context: BrowserContext,
  command: Extract<Command, { kind: "render" }>,
): Promise<boolean> {
  const { shared, guards } = command;
  const scripts = await resolveRenderedScripts({
    site: shared.url,
    slugs: command.slugs,
    published: guards.published,
  });
  const page = await firstPage(context);
  await openStudio(page, shared.url);
  const status = await waitForReady(page, NO_PAGE_WIDE_REASON);
  await guardStart(page, status, command.slugs, guards.allowSynthesis);

  let passed = true;
  for (const [position, slug] of command.slugs.entries()) {
    // A fresh page per lesson: the handle's runs and its repeatability check
    // are then this lesson's alone.
    if (position > 0) {
      await openStudio(page, shared.url);
      await waitForReady(page, NO_PAGE_WIDE_REASON);
    }
    const folder = outputFolder(shared.out, slug);
    writeRenderedScript(
      folder,
      shared.url,
      scripts.find((each) => each.slug === slug),
    );
    try {
      const result = await renderLessonRuns({
        page,
        slug,
        runtime: command.runtime,
        speed: guards.speed,
        runs: command.runs,
        folder,
      });
      passed &&= result.passed;
    } catch (error) {
      if (!(error instanceof DriverError)) throw error;
      console.error(`studio-render: ${error.message}`);
      passed = false;
    }
  }
  return passed;
}

export async function runUpdateCommand(
  context: BrowserContext,
  command: Extract<Command, { kind: "update" }>,
): Promise<boolean> {
  const { shared, guards, slug } = command;
  const signIn = await readSignIn(context, shared.url);
  if (!signIn.signedIn) {
    throw new DriverError(
      `update needs this profile signed in on ${shared.url}${signIn.problem ? ` (${signIn.problem})` : ""}: run "bun scripts/studio-render.ts login --url=${shared.url}"`,
    );
  }
  const scripts = await resolveRenderedScripts({
    site: shared.url,
    slugs: [slug],
    published: guards.published,
  });
  const page = await firstPage(context);
  await openStudio(page, shared.url);
  const status = await waitForReady(page, NO_PAGE_WIDE_REASON);

  // Find the published lesson before spending a render on it.
  const match = await callAutomation(page, "publishedLesson", {
    slug,
    ...(command.lesson ? { lesson: command.lesson } : {}),
  });
  if ("refused" in match) throw new DriverError(`${slug}: ${match.refused}`);
  const lesson = match.found;
  console.log(
    `${slug}: replaces "${lesson.title}" (/learn/${lesson.urlSlug}, ${lesson.status}, ${lesson.duration})`,
  );

  await guardStart(page, status, [slug], guards.allowSynthesis);
  const folder = outputFolder(shared.out, `${slug}-update`);
  writeRenderedScript(folder, shared.url, scripts[0]);
  const result = await renderLessonRuns({
    page,
    slug,
    runtime: null,
    speed: guards.speed,
    runs: 1,
    folder,
  });
  if (!result.passed) {
    console.error(
      `studio-render: ${slug}: the render did not pass; the published lesson is unchanged`,
    );
    return false;
  }

  // Comparing and replacing put the run's recording and narration in the
  // site's storage, which takes as long as an upload.
  const compared = await callAutomation(
    page,
    "replacePublishedLesson",
    { lessonId: lesson.lessonId, replace: false },
    WORKFLOW_UPLOAD_ALLOWANCE_MS,
  );
  if ("refused" in compared) throw new DriverError(`${slug}: ${compared.refused}`);
  if (!("compared" in compared))
    throw new DriverError(`${slug}: the studio replaced the lesson when asked only to compare`);
  writeJson(folder, "update-compared.json", compared.compared);
  printChange("would change", compared.compared);
  if (!command.replace) {
    console.log("  nothing on the site changed; pass --replace to put this render in its place");
    return true;
  }

  const replaced = await callAutomation(
    page,
    "replacePublishedLesson",
    { lessonId: lesson.lessonId, replace: true },
    WORKFLOW_UPLOAD_ALLOWANCE_MS,
  );
  if ("refused" in replaced) throw new DriverError(`${slug}: not replaced: ${replaced.refused}`);
  if (!("replaced" in replaced))
    throw new DriverError(`${slug}: the studio compared again instead of replacing`);
  writeJson(folder, "update-replaced.json", replaced.replaced);
  printChange("replaced", replaced.replaced);
  console.log(
    `  narration: ${replaced.replaced.audioFile}${
      replaced.replaced.removedAudioFile
        ? `, removed ${replaced.replaced.removedAudioFile}`
        : ", the old narration file was not removed"
    }`,
  );
  return true;
}

function printChange(
  verb: string,
  change: {
    urlSlug: string;
    changedCues: number;
    totalCues: number;
    examples: string[];
    publishedDurationMs: number;
    newDurationMs: number;
  },
): void {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  console.log(
    `  ${verb}: /learn/${change.urlSlug}: ${change.changedCues} of ${change.totalCues} caption cues differ; duration ${seconds(change.publishedDurationMs)} → ${seconds(change.newDurationMs)}`,
  );
  for (const example of change.examples) console.log(`    ${example}`);
}
