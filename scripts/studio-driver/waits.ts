/**
 * How long the driver waits for the studio before it calls something stuck.
 * Every wait here is an upper bound on a hang, never a pause: the driver polls
 * and goes on the moment the studio answers.
 */

import {
  estimateNarrationMsForRenderWait,
  studioRenderWaitMs,
} from "../../src/studio/renderLaunch.ts";
import { extractScriptNarration } from "../../src/studio/script/markers.ts";
import { parseLessonScriptYaml } from "../../src/studio/script/parseYaml.ts";

/** How often the driver reads the studio's window handle. */
export const POLL_MS = 1_000;

/** The longest one plain read of the page may take; a longer one is the browser's pipe gone. */
export const EVALUATE_TIMEOUT_MS = 30_000;

/** Handing a bundle across the page boundary moves the lesson and its narration as base64. */
export const BUNDLE_TIMEOUT_MS = 180_000;

/** Counting a course's kept narration reads the profile's narration cache for every dialog. */
export const COVERAGE_TIMEOUT_MS = 120_000;

/**
 * How long the studio may take to load and say it is ready (sign-in,
 * capabilities, the voice library, the lesson index). These are a few
 * requests; past this the reason it gives is the answer.
 */
export const READY_GRACE_MS = 60_000;

/** How long the studio page may take to load at all and put its handle on the window. */
export const PAGE_LOAD_TIMEOUT_MS = 90_000;

/**
 * Time a workflow lesson may spend outside the render (upload, publish,
 * playlist) before the driver calls it stuck: an upload of a long lesson's
 * recording and narration on a slow line.
 */
export const WORKFLOW_UPLOAD_ALLOWANCE_MS = 600_000;

/**
 * The narration length a render wait is sized from, from the local script.
 * Null text (no local script) or a script this checkout cannot parse gives 0,
 * and the wait falls back to its fixed part: it only sizes a timeout.
 */
export function estimatedNarrationMs(yamlText: string | null): number {
  if (yamlText === null) return 0;
  try {
    const extracted = extractScriptNarration(parseLessonScriptYaml(yamlText));
    return estimateNarrationMsForRenderWait(extracted.tokens.length);
  } catch {
    return 0;
  }
}

/** How long one render of a lesson may take, sized as the studio-render command always has. */
export function renderWaitMsFor(yamlText: string | null): number {
  return studioRenderWaitMs(estimatedNarrationMs(yamlText));
}

/**
 * How long a workflow may go without visible progress (a lesson's status, the
 * narration pass's lesson or phase) before the driver calls it stuck: the
 * longest single lesson's render plus its upload. A narration pass reports
 * each lesson and each dialog, so it moves well inside that.
 */
export function workflowStallMs(renderWaitsMs: readonly number[]): number {
  return Math.max(studioRenderWaitMs(0), ...renderWaitsMs) + WORKFLOW_UPLOAD_ALLOWANCE_MS;
}
