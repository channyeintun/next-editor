import type { RenderSemantics } from "./compare";
import type { StudioRuntimeMode } from "./plan";

/**
 * Selection ↔ completed-run reconciliation for the Studio console
 * (docs/agent-lesson-production.md §10). Pure so the exposure and repeatability
 * rules that keep a render's artifact bound to the lesson that produced it can
 * be tested without mounting the controller.
 */

/** djb2 — a cheap, synchronous content hash for imported-script revisions. */
function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * A synchronous identity for a selected source, so a completed run's metadata
 * can be matched against the current selection without recompiling the plan.
 * Built-in scripts are stable across the session; an imported script's revision
 * tracks its YAML so a re-import (same slug, new content) invalidates the
 * previous run's downloadable bundle (STUDIO-02).
 */
export function sourceRevisionOf(slug: string, importedScripts: Record<string, string>): string {
  const yamlText = importedScripts[slug];
  return yamlText === undefined ? `builtin:${slug}` : `imported:${hashString(yamlText)}`;
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

/** Prior run as the repeatability baseline sees it — mode plus its render semantics. */
export interface PriorRunSemantics {
  mode: StudioRuntimeMode;
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
    .find((run) => run.mode === mode && run.semantics?.planSha256 === currentPlanHash)?.semantics;
  return fromHistory ?? storedBaseline;
}
