import type { StudioPlanActionType, StudioRuntimeKind, StudioRuntimeMode } from "./plan";

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
  diagnostic?: {
    previewScreenshot: { dataUrl: string; height: number; width: number } | { error: string };
  };
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
    /** Null for Python (WASI python3 installs nothing, so there is no lockfile). */
    lockfilePath: string | null;
    lockfileSha256: string;
    environmentSha256: string;
  } | null;
  environment: {
    userAgent: string;
    appMode: string;
  };
  artifact: {
    neBytes: number;
    neHash: string;
    audioFileName: string;
    recordingDurationMs: number;
    finalWorkspaceHash: string;
  } | null;
}

/**
 * The plan's timing gate (§8): reject builds whose actions started too far
 * from their planned marks. No successful timed receipts also fails — a build
 * that performed nothing measurable must not pass a timing gate.
 */
export function timingGateCheck(timing: TimingStats | null, maxP95Ms: number): StudioCheckResult {
  if (!timing) {
    return { id: "timing.p95", ok: false, detail: "no timed receipts to gate" };
  }
  return {
    id: "timing.p95",
    ok: timing.p95Ms <= maxP95Ms,
    detail: `p95 |actual − planned| = ${timing.p95Ms}ms (max ${maxP95Ms}ms; worst ${timing.maxMs}ms over ${timing.samples} actions)`,
  };
}

export function computeTimingStats(
  receipts: readonly ActionReceipt[],
  /**
   * afterAction dependencies (dependent id → predecessor id) from the plan. An
   * action gated on another has a dependency-driven start, so its planned `at`
   * is only a placeholder; its drift is measured against when the predecessor
   * actually acknowledged instead. This keeps a WebContainer runtime chain
   * (start → waitForReady → preview.open) from failing the gate by construction
   * when dependency install/readiness takes an unbounded, unknowable time
   * (STUDIO-03). Falls back to the planned time when the predecessor's ack is
   * unavailable (e.g. it never finished).
   */
  dependencies?: Readonly<Record<string, string>>,
): TimingStats | null {
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
  const deltas = receipts
    // expect.* actions are QA gates whose start waits on prior completions,
    // not lesson content — they don't belong in the timing distribution (§5).
    .filter(
      (receipt) =>
        receipt.status === "ok" &&
        receipt.startedAtMs !== null &&
        !receipt.actionType.startsWith("expect."),
    )
    .map((receipt) => Math.abs((receipt.startedAtMs as number) - referenceFor(receipt)))
    .sort((left, right) => left - right);

  if (deltas.length === 0) {
    return null;
  }

  const percentile = (p: number) =>
    deltas[Math.min(deltas.length - 1, Math.ceil((p / 100) * deltas.length) - 1)];

  return {
    samples: deltas.length,
    p50Ms: Math.round(percentile(50)),
    p95Ms: Math.round(percentile(95)),
    maxMs: Math.round(deltas[deltas.length - 1]),
  };
}
