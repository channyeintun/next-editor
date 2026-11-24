/**
 * What the driver checks before it lets the studio start, and how it reads
 * the result. Each rule says what it refuses in a line a person can act on.
 */

import type { StudioCheckResult } from "../../src/studio/report.ts";
import type {
  StudioAutomationCoverage,
  StudioAutomationStatus,
  StudioWindowRun,
} from "../../src/studio/studioWindowHandle.ts";

/**
 * A render that records the screen asks for a screen picker no one is there
 * to answer.
 */
export function screenRecordingRefusal(status: StudioAutomationStatus): string | null {
  return status.screenRecording
    ? "this profile records the screen with a render, and no one is here to answer the screen picker; turn screen recording off for this site (open the profile with login --url and switch it off in the studio)"
    : null;
}

/**
 * A paid narration provider charges for every dialog this profile has not
 * kept. Refuse to spend unless told to, saying how many dialogs it would be.
 */
export function narrationCostRefusal(input: {
  status: StudioAutomationStatus;
  coverage: { lessons: StudioAutomationCoverage[]; cacheUnavailable: string | null };
  allowSynthesis: boolean;
}): string | null {
  const { status, coverage, allowSynthesis } = input;
  if (!status.providerIsPaid || allowSynthesis) return null;
  const voice = status.voice ? ` with the voice "${status.voice}"` : "";
  if (coverage.cacheUnavailable) {
    const dialogs = coverage.lessons.reduce((sum, lesson) => sum + lesson.dialogs, 0);
    return `${status.provider}${voice} would synthesize all ${dialogs} dialogs: this browser cannot keep narration (${coverage.cacheUnavailable}); pass --allow-synthesis to pay for them`;
  }
  const missing = coverage.lessons.filter((lesson) => lesson.missing > 0);
  if (!missing.length) return null;
  const total = missing.reduce((sum, lesson) => sum + lesson.missing, 0);
  const perLesson = missing.map((lesson) => `${lesson.slug} ${lesson.missing}/${lesson.dialogs}`);
  return `${status.provider}${voice} would synthesize ${total} dialog${total === 1 ? "" : "s"} this profile has not kept (${perLesson.join(", ")}); pass --allow-synthesis to pay for them`;
}

/** What the studio is still waiting for, or why it would not start, when it is not ready. */
export function notReadyReason(status: StudioAutomationStatus, blocked: string | null): string {
  if (status.lessons.status === "error") {
    return `the studio could not read the lesson index: ${status.lessons.error ?? "unknown error"}`;
  }
  if (status.waitingFor) return `the studio is still waiting for ${status.waitingFor}`;
  return blocked ?? "the studio is not ready and gives no reason";
}

/** Whether a lesson's renders passed: every run, and the repeatability check when there were two or more. */
export function renderVerdict(
  runs: readonly StudioWindowRun[],
  comparison: readonly StudioCheckResult[] | null,
  requestedRuns: number,
): { passed: boolean; comparisonClean: boolean | null } {
  const allPassed = runs.length === requestedRuns && runs.every((run) => run.outcome === "passed");
  if (requestedRuns < 2) return { passed: allPassed, comparisonClean: null };
  const comparisonClean = Boolean(comparison?.length && comparison.every((check) => check.ok));
  return { passed: allPassed && comparisonClean, comparisonClean };
}

export interface PageEnvironment {
  visibilityState: string;
  /** Animation frames the page ran in one second. */
  framesPerSecond: number;
}

/** Below this the studio's editor, preview and whiteboard paint too seldom to render faithfully. */
const MIN_FRAMES_PER_SECOND = 30;

/** A warning when the page cannot paint as a render needs; null when it can. */
export function pageEnvironmentWarning(environment: PageEnvironment): string | null {
  if (environment.visibilityState === "hidden") {
    return "the studio page is hidden: Chrome runs no animation frames there, and a render holds until it is visible";
  }
  if (environment.framesPerSecond < MIN_FRAMES_PER_SECOND) {
    return `the studio page ran ${environment.framesPerSecond} animation frames in one second (under ${MIN_FRAMES_PER_SECOND}): renders may be slow or miss what they check`;
  }
  return null;
}
