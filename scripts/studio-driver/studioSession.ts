/**
 * The checks every command that renders makes on the open studio before it
 * asks it to start: ready, not recording the screen, not about to spend on
 * narration nobody allowed.
 */

import type { Page } from "playwright-core";
import type { StudioAutomationStatus } from "../../src/studio/studioWindowHandle.ts";
import { callAutomation, DriverError, sleep } from "./browser.ts";
import { narrationCostRefusal, notReadyReason, screenRecordingRefusal } from "./guards.ts";
import { COVERAGE_TIMEOUT_MS, POLL_MS, READY_GRACE_MS } from "./waits.ts";

/**
 * Wait until the studio says it could start. Past the grace the reason it
 * gives (what it waits for, or why the start is blocked) is the failure.
 */
export async function waitForReady(
  page: Page,
  blockedOf: (status: StudioAutomationStatus) => string | null,
): Promise<StudioAutomationStatus> {
  const deadline = Date.now() + READY_GRACE_MS;
  for (;;) {
    const status = await callAutomation(page, "status", undefined);
    if (status.lessons.status === "error") {
      throw new DriverError(notReadyReason(status, blockedOf(status)));
    }
    if (status.ready && !blockedOf(status)) return status;
    if (Date.now() > deadline) throw new DriverError(notReadyReason(status, blockedOf(status)));
    await sleep(POLL_MS);
  }
}

export function describeStatus(status: StudioAutomationStatus): string[] {
  return [
    `narration: ${status.provider}${status.providerIsPaid ? " (paid)" : ""}, voice ${status.voice ?? "the provider's own"}`,
    `screen recording: ${status.screenRecording ? "on" : "off"}`,
    `lesson index: ${status.lessons.status}, ${status.lessons.count} lessons from ${status.lessons.source ?? "nowhere yet"}${
      status.lessons.error ? ` (${status.lessons.error})` : ""
    }`,
  ];
}

/** Refuse a start that would ask for the screen, or spend on narration without --allow-synthesis. */
export async function guardStart(
  page: Page,
  status: StudioAutomationStatus,
  slugs: readonly string[],
  allowSynthesis: boolean,
): Promise<void> {
  const screen = screenRecordingRefusal(status);
  if (screen) throw new DriverError(screen);
  if (!status.providerIsPaid || !slugs.length) return;
  // Reading a profile's narration cache for a whole course takes longer than one plain read.
  const coverage = await callAutomation(page, "narrationCoverage", [...slugs], COVERAGE_TIMEOUT_MS);
  if ("refused" in coverage) throw new DriverError(`narration coverage: ${coverage.refused}`);
  const refusal = narrationCostRefusal({ status, coverage, allowSynthesis });
  if (refusal) throw new DriverError(refusal);
  const missing = coverage.lessons.reduce((sum, lesson) => sum + lesson.missing, 0);
  if (missing > 0) console.log(`  narration: synthesizing ${missing} dialogs (--allow-synthesis)`);
}
