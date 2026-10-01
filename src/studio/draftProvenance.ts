import type { StudioBuildManifest } from "./report";

/** What a completed studio run's draft description names (see StudioController). */
export interface DraftProvenanceRun {
  /** Human lesson title captured at render time. */
  title: string;
  result: { manifest: Pick<StudioBuildManifest, "planSlug" | "planHash" | "runtimeMode"> };
  /** TTS implementation that produced the narration, or null. */
  narrationProvider: string | null;
  /** Cloned-voice name used for the run, or null for the script default. */
  voiceName: string | null;
}

/**
 * The description pre-filled on a studio run's draft upload.
 *
 * Whatever lands in this field becomes the lesson's public meta, OpenGraph and
 * JSON-LD description once the draft is published, so it carries only what a
 * viewer should read: the lesson title and a plain disclosure that the
 * narration is AI-generated. The build provenance stays out of it — see
 * {@link describeDraftProvenance}.
 */
export function describeDraftDescription(run: Pick<DraftProvenanceRun, "title">): string {
  const title = run.title.trim();
  const lead = title ? `${title} — a narrated coding lesson.` : "A narrated coding lesson.";
  return `${lead} The narration is AI-generated.`;
}

/**
 * Internal build provenance of a studio run (plan, plan hash, runtime,
 * narration and cloned voice) plus the review reminder, for the studio panel
 * only — never the public description.
 */
export function describeDraftProvenance(run: DraftProvenanceRun): string {
  const { planSlug, planHash, runtimeMode } = run.result.manifest;
  const narration = run.narrationProvider ? `, ${run.narrationProvider} narration` : "";
  const voice = run.voiceName ? ` with the user-cloned voice "${run.voiceName}"` : "";
  return `AI-produced draft — rendered unattended by the Next Editor studio (plan ${planSlug}, plan sha256 ${planHash.slice(0, 16)}, ${runtimeMode} runtime${narration}${voice}). Review the full lesson before publishing.`;
}
