import type { ModalVoxCpm2VoiceProfile } from "../tts/profiles";

/**
 * The narration request pack's identity, and the engine a pack's takes need.
 * Kept apart from the export (requestPack.ts) so the notebook generator
 * (scripts/build-voxcpm2-colab-notebook.ts) can read them without loading the
 * Director: the pack and the notebook then state the engine through the same
 * function, and the notebook refuses a pack that names another.
 */

export const NARRATION_REQUEST_PACK_FORMAT = "next-editor-narration-requests";
export const NARRATION_REQUEST_PACK_VERSION = 1;

/** How a take must be synthesized to be the one its request hash names. */
export type NarrationPackEngine = Pick<
  ModalVoxCpm2VoiceProfile,
  | "model"
  | "modelRevision"
  | "packageVersion"
  | "voiceDesignId"
  | "cfgValue"
  | "inferenceTimesteps"
  | "sampleRate"
>;

export function narrationPackEngineOf(profile: ModalVoxCpm2VoiceProfile): NarrationPackEngine {
  return {
    model: profile.model,
    modelRevision: profile.modelRevision,
    packageVersion: profile.packageVersion,
    voiceDesignId: profile.voiceDesignId,
    cfgValue: profile.cfgValue,
    inferenceTimesteps: profile.inferenceTimesteps,
    sampleRate: profile.sampleRate,
  };
}
