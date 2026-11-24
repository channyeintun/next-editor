/**
 * `workflow <slug…>`: take lessons through the studio workflow (render, and
 * draft and publish when asked) on a bare /studio page, through the studio's
 * automation surface, printing each lesson's progress and leaving
 * workflow.json and each failed lesson's issue report.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import type {
  StudioAutomationFile,
  StudioAutomationStart,
  StudioAutomationWorkflowInput,
  StudioWindowHandle,
} from "../../src/studio/studioWindowHandle.ts";
import type { StudioWorkflow } from "../../src/studio/workflow/workflowQueue.ts";
import type { Command } from "./args.ts";
import {
  callAutomation,
  DriverError,
  firstPage,
  openStudio,
  readHandle,
  sleep,
} from "./browser.ts";
import { localScriptText, resolveRenderedScripts } from "./publishedCheck.ts";
import { outputFolder, writeJson } from "./renderCommand.ts";
import type { RenderedScript } from "./scriptIds.ts";
import { guardStart, waitForReady } from "./studioSession.ts";
import { thumbnailTypeOf } from "./thumbnails.ts";
import { POLL_MS, READY_GRACE_MS, renderWaitMsFor, workflowStallMs } from "./waits.ts";
import {
  isWorkflowSettled,
  slugsStillToRender,
  workflowChanges,
  workflowIssueReports,
  workflowProgressKey,
  type WorkflowLook,
  workflowSummary,
} from "./workflowReport.ts";

/** Starting stores the thumbnails in the page's IndexedDB before the first lesson. */
const START_TIMEOUT_MS = 120_000;

function readThumbnails(folder: string): StudioAutomationFile[] {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new DriverError(`--thumbnails: ${folder} is not a folder`);
  }
  const files: StudioAutomationFile[] = [];
  for (const name of readdirSync(folder).sort()) {
    const type = thumbnailTypeOf(name);
    if (!type) continue;
    files.push({ name, type, base64: readFileSync(join(folder, name)).toString("base64") });
  }
  if (!files.length) throw new DriverError(`--thumbnails: ${folder} holds no PNG or JPEG image`);
  return files;
}

function storedWorkflowOf(handle: StudioWindowHandle | null): StudioWorkflow | null {
  return handle?.workflow ?? null;
}

export async function runWorkflowCommand(
  context: BrowserContext,
  command: Extract<Command, { kind: "workflow" }>,
): Promise<boolean> {
  const { shared, guards } = command;
  const page = await firstPage(context);
  await openStudio(page, shared.url);
  const status = await waitForReady(page, (each) =>
    command.resume ? null : each.workflowBlockedReason,
  );

  const stored = storedWorkflowOf(await readHandle(page));
  let toRender: string[];
  if (command.resume) {
    if (!stored)
      throw new DriverError(
        `there is no stored workflow to resume on ${shared.url} in this profile`,
      );
    const storedSlugs = stored.lessons.map((lesson) => lesson.slug);
    if (command.slugs.length && command.slugs.join(" ") !== storedSlugs.join(" ")) {
      throw new DriverError(
        `the stored workflow is for ${storedSlugs.join(" ")}, not ${command.slugs.join(" ")}`,
      );
    }
    toRender = slugsStillToRender(stored);
  } else {
    toRender = command.slugs;
  }

  const scripts = await resolveRenderedScripts({
    site: shared.url,
    slugs: toRender,
    published: guards.published,
  });
  await guardStart(page, status, toRender, guards.allowSynthesis);

  const folder = outputFolder(shared.out, "workflow");
  const previousId = stored?.id ?? null;
  let started: StudioAutomationStart;
  if (command.resume) {
    started = await callAutomation(page, "resumeWorkflow", undefined, START_TIMEOUT_MS);
  } else {
    const input: StudioAutomationWorkflowInput = {
      slugs: command.slugs,
      settings: {
        createDraft: command.mode !== "render",
        publish: command.mode === "publish",
        defaultThumbnailWhenMissing: command.defaultThumbnail,
        playlistId: command.playlist,
        narrateFirst: command.narrateFirst,
        fullSpeed: guards.speed === "full",
      },
      thumbnails: command.thumbnails ? readThumbnails(command.thumbnails) : [],
    };
    started = await callAutomation(page, "startWorkflow", input, START_TIMEOUT_MS);
  }
  if ("refused" in started) throw new DriverError(`the workflow did not start: ${started.refused}`);
  console.log(`workflow: ${command.resume ? "resumed" : "started"} → ${folder}`);

  const workflow = await followWorkflow({
    page,
    previousId: command.resume ? null : previousId,
    resumedId: command.resume ? previousId : null,
    stallMs: workflowStallMs(toRender.map((slug) => renderWaitMsFor(localScriptText(slug)))),
    onSettle: (settled) => writeWorkflowOutput(folder, shared.url, settled, scripts),
  });
  return (
    workflow.state === "finished" && workflow.lessons.every((lesson) => lesson.status === "done")
  );
}

function writeWorkflowOutput(
  folder: string,
  site: string,
  workflow: StudioWorkflow,
  scripts: readonly RenderedScript[],
): void {
  writeJson(folder, "workflow.json", workflowSummary(site, workflow, scripts));
  for (const { slug, report } of workflowIssueReports(workflow)) {
    writeFileSync(join(folder, `${slug}.issue.md`), report);
    console.log(`  issue report: ${join(folder, `${slug}.issue.md`)}`);
  }
}

/**
 * Poll the handle until the started workflow settles, printing what moves.
 * A fresh start is the workflow whose id is not the one stored before; a
 * resume keeps its id, so it counts as settled only once it was seen running
 * (or after the grace, for one that finished before the first look).
 */
async function followWorkflow(input: {
  page: Page;
  previousId: string | null;
  resumedId: string | null;
  stallMs: number;
  onSettle: (workflow: StudioWorkflow) => void;
}): Promise<StudioWorkflow> {
  const { page } = input;
  const startedAt = Date.now();
  let before: WorkflowLook = { workflow: null, narration: null };
  let progressKey = "";
  let progressAt = Date.now();
  let seenRunning = false;
  let latest: StudioWorkflow | null = null;
  for (;;) {
    const handle = await readHandle(page);
    const workflow = storedWorkflowOf(handle);
    const ours =
      workflow &&
      (input.resumedId !== null
        ? workflow.id === input.resumedId
        : workflow.id !== input.previousId)
        ? workflow
        : null;
    const now: WorkflowLook = { workflow: ours, narration: handle?.narration ?? null };
    for (const line of workflowChanges(before, now)) console.log(line);
    before = now;
    if (ours) {
      latest = ours;
      if (!isWorkflowSettled(ours)) seenRunning = true;
      const settledForUs =
        isWorkflowSettled(ours) &&
        (input.resumedId === null || seenRunning || Date.now() - startedAt > READY_GRACE_MS);
      if (settledForUs) {
        input.onSettle(ours);
        return ours;
      }
    }
    const key = workflowProgressKey(ours, now.narration);
    if (key !== progressKey) {
      progressKey = key;
      progressAt = Date.now();
    } else if (Date.now() - progressAt > input.stallMs) {
      if (latest) input.onSettle(latest);
      // Stop after the lesson in hand, so a later --resume goes on from a clean place.
      await callAutomation(page, "stopWorkflow", undefined).catch(() => {});
      throw new DriverError(
        `the workflow made no progress in ${Math.round(input.stallMs / 60_000)} min; it was asked to stop, and --resume goes on with it`,
      );
    }
    await sleep(POLL_MS);
  }
}
