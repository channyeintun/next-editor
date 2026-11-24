import type { StudioPlanActionType, StudioRuntimeKind, StudioRuntimeMode } from "./plan";
import type { RenderClockKind } from "./renderClock";

/**
 * Receipts, render reports, and build manifests
 * (docs/agent-lesson-production.md §4.2, §8, §10). Receipts carry actual
 * start/end timestamps on the recording clock so timing gates compare planned
 * versus performed times without re-deriving anything from the artifact.
 */

export type ActionReceiptStatus = "ok" | "failed" | "skipped";

export interface ActionReceipt {
  actionId: string;
  actionType: StudioPlanActionType;
  status: ActionReceiptStatus;
  /** Planned start on the recording clock (ms). */
  plannedAtMs: number;
  /** Actual command start on the recording clock (ms); null when never started. */
  startedAtMs: number | null;
  /** Actual acknowledge time on the recording clock (ms); null when never finished. */
  endedAtMs: number | null;
  error?: string;
  /** Command-specific diagnostics (content hashes, console excerpts, modes). */
  detail?: Record<string, unknown>;
}

export type StudioRenderOutcome = "passed" | "failed";

export interface StudioCheckResult {
  id: string;
  ok: boolean;
  detail: string;
  /**
   * A check that reports without deciding: when it fails, the render still
   * passes, keeps its files, and goes on as a passed render goes on. It is
   * shown as a warning. A check is advisory while it has not yet run clean on
   * real lessons, so a false alarm cannot cost a good render.
   */
  advisory?: true;
  diagnostic?: {
    previewScreenshot: { dataUrl: string; height: number; width: number } | { error: string };
  };
}

/** Whether a check's result fails the render: it failed, and it is not advisory. */
export function checkFailsRender(check: StudioCheckResult): boolean {
  return !check.ok && check.advisory !== true;
}

/** The one rule for a render's outcome from its checks: no check fails it. */
export function renderOutcomeOf(checks: readonly StudioCheckResult[]): StudioRenderOutcome {
  return checks.some(checkFailsRender) ? "failed" : "passed";
}

/** The advisory checks that failed: warnings, which never fail the render. */
export function advisoryWarningsOf(checks: readonly StudioCheckResult[]): StudioCheckResult[] {
  return checks.filter((check) => !check.ok && check.advisory === true);
}

/** One printable line per advisory warning, for a terminal that shows a render's result. */
export function advisoryWarningLines(checks: readonly StudioCheckResult[]): string[] {
  return advisoryWarningsOf(checks).map((check) => `warning: ${check.id} — ${check.detail}`);
}

export interface TimingStats {
  /** Per-action |actual − planned| start deltas (ms). */
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface StudioRenderReport {
  outcome: StudioRenderOutcome;
  planSlug: string;
  runtimeMode: StudioRuntimeMode;
  /**
   * The clock the render performed on (renderClock.ts). Null when the render
   * failed before its take started, so it performed nothing on any clock.
   * Absent from reports made before renders could run off the wall clock,
   * which were all real.
   */
  clock?: RenderClockKind | null;
  startedAtIso: string;
  wallDurationMs: number;
  recordingDurationMs: number | null;
  receipts: ActionReceipt[];
  timing: TimingStats | null;
  checks: StudioCheckResult[];
  /** Console/page errors observed while performing. */
  errors: string[];
}

export interface StudioBuildManifest {
  manifestVersion: 2;
  planSlug: string;
  planTitle: string;
  planHash: string;
  seed: number;
  workspaceHash: string;
  /**
   * SHA-256 and type of the PCM16 WAV narration the render played — the
   * timing master, not what the bundle ships (see `artifact.audioMimeType`).
   */
  narrationAudioHash: string;
  narrationMimeType: string;
  captionsHash: string;
  runtimeKind: StudioRuntimeKind;
  runtimeMode: StudioRuntimeMode;
  runtimeContract: {
    kind: "webcontainer";
    adapterVersion: 1;
    initCommand: string;
    runCommand: string;
    expectedPort: number | null;
    /** Null when the lesson pins no lockfile. */
    lockfilePath: string | null;
    /** Null when lockfilePath is null. */
    lockfileSha256: string | null;
    environmentSha256: string;
  } | null;
  environment: {
    userAgent: string;
    appMode: string;
    /**
     * The clock the render performed on (renderClock.ts); null when the render
     * failed before its take started.
     */
    clock: RenderClockKind | null;
  };
  artifact: {
    neBytes: number;
    neHash: string;
    audioFileName: string;
    /** Type of the audio file the bundle actually ships (Ogg/Opus). */
    audioMimeType: string;
    recordingDurationMs: number;
    finalWorkspaceHash: string;
  } | null;
}

/**
 * The plan's timing gate (§8): reject builds whose actions started too far
 * from their planned marks. No successful timed receipts also fails — a build
 * that performed nothing measurable must not pass a timing gate.
 *
 * On a virtual clock the performer moves time to an action's planned start
 * when it is not there yet, and no action waits for anything real. An action
 * can still start late when the actions before it took longer than their plan
 * allowed (a retried run, say), since time never moves back. The gate runs
 * the same way, and its detail says which clock the starts were read on and
 * where any drift on it comes from.
 */
export function timingGateCheck(
  timing: TimingStats | null,
  maxP95Ms: number,
  clock: RenderClockKind = "real",
): StudioCheckResult {
  if (!timing) {
    return { id: "timing.p95", ok: false, detail: "no timed receipts to gate" };
  }
  const measured = `p95 |actual − planned| = ${timing.p95Ms}ms (max ${maxP95Ms}ms; worst ${timing.maxMs}ms over ${timing.samples} actions)`;
  return {
    id: "timing.p95",
    ok: timing.p95Ms <= maxP95Ms,
    detail:
      clock === "virtual"
        ? `${measured}; virtual clock: an action waits for nothing real, so any drift comes from the actions before it overrunning their plan`
        : measured,
  };
}

/**
 * How far each timed action started from where it was due, in ms (positive is
 * late), by action id. The one definition of "due" for the timing gate and the
 * repeatability comparison alike.
 *
 * `dependencies` are the plan's afterAction dependencies (dependent id →
 * predecessor id). A dependent is due when its predecessor actually
 * acknowledged; deterministic edit chains also carry a modeled planned time,
 * while runtime and preview waits use a placeholder. This keeps a Node.js runtime
 * runtime chain (start → waitForReady → preview.open) from failing a gate by
 * construction when dependency install, readiness or a page load takes an
 * unbounded, unknowable time (STUDIO-03). Falls back to the planned time when
 * the predecessor's ack is unavailable (e.g. it never finished).
 *
 * expect.* actions are QA gates whose start waits on prior completions, not
 * lesson content — they are not timed (§5), and neither is an action that did
 * not run.
 */
export function actionStartDriftsMs(
  receipts: readonly ActionReceipt[],
  dependencies?: Readonly<Record<string, string>>,
): Record<string, number> {
  const endedById = new Map(receipts.map((receipt) => [receipt.actionId, receipt.endedAtMs]));
  const referenceFor = (receipt: ActionReceipt): number => {
    const predecessorId = dependencies?.[receipt.actionId];
    if (predecessorId !== undefined) {
      const predecessorEnd = endedById.get(predecessorId);
      if (predecessorEnd !== null && predecessorEnd !== undefined) {
        return predecessorEnd;
      }
    }
    return receipt.plannedAtMs;
  };
  return Object.fromEntries(
    receipts
      .filter(
        (receipt) =>
          receipt.status === "ok" &&
          receipt.startedAtMs !== null &&
          !receipt.actionType.startsWith("expect."),
      )
      .map((receipt) => [
        receipt.actionId,
        (receipt.startedAtMs as number) - referenceFor(receipt),
      ]),
  );
}

export function computeTimingStats(
  receipts: readonly ActionReceipt[],
  /** The plan's afterAction dependencies — see {@link actionStartDriftsMs}. */
  dependencies?: Readonly<Record<string, string>>,
): TimingStats | null {
  return timingStatsOf(Object.values(actionStartDriftsMs(receipts, dependencies)).map(Math.abs));
}

/**
 * Nearest-rank statistics, rounded, over time differences that are already
 * absolute; null when there are none. The timing gate and the comparison of
 * two recordings' tracks both report these, so they are computed in one place.
 */
export function timingStatsOf(deltasMs: readonly number[]): TimingStats | null {
  if (deltasMs.length === 0) {
    return null;
  }
  const sorted = [...deltasMs].sort((left, right) => left - right);
  const percentile = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

  return {
    samples: sorted.length,
    p50Ms: Math.round(percentile(50)),
    p95Ms: Math.round(percentile(95)),
    maxMs: Math.round(sorted[sorted.length - 1]),
  };
}
