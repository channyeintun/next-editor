import type { StudioBuildManifest } from "./report";

/** What a completed studio run's draft description names (see StudioController). */
export interface DraftProvenanceRun {
  /** Human lesson title captured at render time. */
  title: string;
  result: { manifest: Pick<StudioBuildManifest, "planSlug" | "planHash" | "runtimeMode"> };
  /** TTS implementation that produced the narration, or null. */
  narrationProvider: string | null;
  /** Display name of the run's chosen voice, or null for the script default. */
  voiceName: string | null;
  /**
   * What `voiceName` names: a Pocket-TTS voice cloned from the user's sample, a
   * VoxCPM2 narrator reference, or a voice from the user's AthanLab account.
   */
  voiceKind: "cloned" | "reference" | "athanlab" | null;
}

const VOICE_KIND_PHRASES: Record<NonNullable<DraftProvenanceRun["voiceKind"]>, string> = {
  cloned: "the user-cloned voice",
  reference: "the reference voice",
  athanlab: "the AthanLab voice",
};

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
 * narration and voice) plus the review reminder, for the studio panel only —
 * never the public description.
 */
export function describeDraftProvenance(run: DraftProvenanceRun): string {
  const { planSlug, planHash, runtimeMode } = run.result.manifest;
  const narration = run.narrationProvider ? `, ${run.narrationProvider} narration` : "";
  const voicePhrase = run.voiceKind ? VOICE_KIND_PHRASES[run.voiceKind] : "the voice";
  const voice = run.voiceName ? ` with ${voicePhrase} "${run.voiceName}"` : "";
  return `AI-produced draft — rendered unattended by the Next Editor studio (plan ${planSlug}, plan sha256 ${planHash.slice(0, 16)}, ${runtimeMode} runtime${narration}${voice}). Review the full lesson before publishing.`;
}
