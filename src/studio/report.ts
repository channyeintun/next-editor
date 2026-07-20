import type { StudioPlanActionType, StudioRuntimeMode } from "./plan";

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
  manifestVersion: 1;
  planSlug: string;
  planTitle: string;
  planHash: string;
  seed: number;
  workspaceHash: string;
  narrationAudioHash: string;
  narrationMimeType: string;
  captionsHash: string;
  runtimeKind: "go-playground";
  runtimeMode: StudioRuntimeMode;
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

export function computeTimingStats(receipts: readonly ActionReceipt[]): TimingStats | null {
  const deltas = receipts
    // expect.* actions are QA gates whose start waits on prior completions,
    // not lesson content — they don't belong in the timing distribution (§5).
    .filter(
      (receipt) =>
        receipt.status === "ok" &&
        receipt.startedAtMs !== null &&
        !receipt.actionType.startsWith("expect."),
    )
    .map((receipt) => Math.abs((receipt.startedAtMs as number) - receipt.plannedAtMs))
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
