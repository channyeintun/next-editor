import type { StudioBuildManifest } from "./report";

/** What a completed studio run's draft description names (see StudioController). */
export interface DraftProvenanceRun {
  result: { manifest: Pick<StudioBuildManifest, "planSlug" | "planHash" | "runtimeMode"> };
  /** TTS implementation that produced the narration, or null. */
  narrationProvider: string | null;
  /** Cloned-voice name used for the run, or null for the script default. */
  voiceName: string | null;
}

/**
 * The description pre-filled on a studio run's draft upload: the AI-production
 * disclosure plus the build provenance (plan, plan hash, runtime, narration and
 * cloned voice) the reviewer reads before publishing.
 */
export function describeDraftProvenance(run: DraftProvenanceRun): string {
  const { planSlug, planHash, runtimeMode } = run.result.manifest;
  const narration = run.narrationProvider ? `, ${run.narrationProvider} narration` : "";
  const voice = run.voiceName ? ` with the user-cloned voice "${run.voiceName}"` : "";
  return `AI-produced draft — rendered unattended by the Next Editor studio (plan ${planSlug}, plan sha256 ${planHash.slice(0, 16)}, ${runtimeMode} runtime${narration}${voice}). Review the full lesson before publishing.`;
}
