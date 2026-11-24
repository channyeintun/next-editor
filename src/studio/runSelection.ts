import { compareRenderSemantics, type RenderSemantics } from "./compare";
import type { StudioRuntimeMode } from "./plan";
import type { StudioCheckResult, StudioRenderOutcome } from "./report";

/**
 * Selection ↔ completed-run reconciliation for the Studio console
 * (docs/agent-lesson-production.md §10). Pure (appendCompletedRun touches only
 * the history array it is handed) so the exposure, retention and repeatability
 * rules that keep a render's artifact bound to the lesson that produced it can
 * be tested without mounting the controller.
 */

/**
 * A synchronous identity for a selected source, so a completed run's metadata
 * can be matched against the current selection without recompiling the plan.
 * A published script is named by its id, the hash of its bytes, so a lesson
 * published again (same slug, new content) is a new revision. An imported
 * script's revision tracks its YAML, so a re-import invalidates the previous
 * run's downloadable bundle (STUDIO-02). A render passes the id its script
 * was loaded with when it started, not whatever the index names when it ends.
 */
export function sourceRevisionOf(
  slug: string,
  importedScripts: Record<string, string>,
  publishedId: string | null,
): string {
  const yamlText = importedScripts[slug];
  // Use the exact imported bytes as the identity. A 32-bit convenience hash can
  // collide, which would re-expose an older recording for different YAML—the
  // precise cross-revision mix-up this guard exists to prevent. Keep imported
  // and published identities in disjoint namespaces as well.
  if (yamlText !== undefined) return `imported:${yamlText}`;
  // A slug that is neither imported nor published has no content to name.
  return publishedId === null ? `unknown:${slug}` : `published:${publishedId}`;
}

/** The immutable per-run identity a completed run carries for reconciliation. */
export interface RunSelectionIdentity {
  slug: string;
  sourceRevision: string;
}

/**
 * Whether a completed run's bundle/report/draft may be exposed for the current
 * selection: only when the selected slug and its source revision still match the
 * run that produced them and nothing is rendering. This is the guard that stops
 * lesson A's recording being downloaded or drafted under a since-selected lesson
 * B, and hides a stale passing artifact while a new render is in flight
 * (STUDIO-02).
 */
export function runExposedForSelection(
  run: RunSelectionIdentity | null,
  planSlug: string,
  selectedSourceRevision: string,
  running: boolean,
): boolean {
  return (
    run !== null &&
    !running &&
    run.slug === planSlug &&
    run.sourceRevision === selectedSourceRevision
  );
}

/**
 * Append a completed run to the session's run history, releasing the artifacts
 * (bundle, audio, decoded recording) of the run it supersedes. Only the newest
 * run is ever exposed (runExposedForSelection is asked about it alone), so an
 * older run's artifacts are unreachable yet would otherwise stay in memory for
 * the whole session. Its report, manifest and semantics stay: the window handle
 * and the repeatability baseline still read them.
 */
export function appendCompletedRun<Run extends { result: { artifacts: unknown } }>(
  history: Run[],
  run: Run,
): void {
  const previous = history.at(-1);
  if (previous?.result.artifacts) {
    history[history.length - 1] = { ...previous, result: { ...previous.result, artifacts: null } };
  }
  history.push(run);
}

/** Prior run as the repeatability baseline sees it — mode plus its render semantics. */
export interface PriorRunSemantics {
  mode: StudioRuntimeMode;
  outcome: StudioRenderOutcome;
  semantics: RenderSemantics | null;
}

/**
 * Pick the prior render to compare the just-finished render against. A valid
 * baseline is a render of the SAME compiled plan: it must match on runtime mode
 * AND plan hash. Matching by mode alone made A → B → A compare the second A
 * against B and spuriously reset the baseline (STUDIO-04). History (most recent
 * first) wins; otherwise this slug's stored baseline is the fallback across
 * reloads. The raw candidate is returned — callers still re-check `planSha256`
 * before comparing so a hash-mismatched stored baseline surfaces a reset.
 */
export function selectRepeatabilityBaseline(
  priorRuns: readonly PriorRunSemantics[],
  mode: StudioRuntimeMode,
  currentPlanHash: string,
  storedBaseline: RenderSemantics | null,
): RenderSemantics | null {
  const fromHistory = [...priorRuns]
    .reverse()
    .find(
      (run) =>
        run.outcome === "passed" &&
        run.mode === mode &&
        run.semantics?.planSha256 === currentPlanHash,
    )?.semantics;
  return fromHistory ?? storedBaseline;
}

export const BASELINE_RESET_NOTE =
  "Script changed since the previous run — repeatability baseline reset. Render again to compare.";

/** A passing render's repeatability result, as the studio console shows it. */
export interface RepeatabilityOutcome {
  /** The check-by-check comparison with the baseline, or null when there is none to compare. */
  comparison: StudioCheckResult[] | null;
  /** Set when the only baseline was rendered from a different plan, so none was used. */
  baselineNote: string | null;
}

/**
 * Compare a just-finished passing render against its baseline (see
 * selectRepeatabilityBaseline). Repeatability only means something between renders
 * of the SAME compiled plan, so the baseline must match on plan hash, not merely on
 * runtime mode (STUDIO-04). A stored baseline from an edited script is not compared;
 * it resets the baseline with a note, which is how "no baseline" and "script
 * changed" stay distinguishable.
 */
export function checkRepeatability(
  priorRuns: readonly PriorRunSemantics[],
  mode: StudioRuntimeMode,
  current: RenderSemantics,
  storedBaseline: RenderSemantics | null,
): RepeatabilityOutcome {
  const baseline = selectRepeatabilityBaseline(priorRuns, mode, current.planSha256, storedBaseline);
  if (baseline && baseline.planSha256 === current.planSha256) {
    return { comparison: compareRenderSemantics(baseline, current), baselineNote: null };
  }
  return { comparison: null, baselineNote: baseline ? BASELINE_RESET_NOTE : null };
}
