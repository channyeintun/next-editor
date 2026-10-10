import {
  getCustomVoice,
  isVoxCpm2ReferenceReady,
  MAX_SAMPLE_SECONDS,
  MIN_VOXCPM2_REFERENCE_SECONDS,
} from "./customVoices";
import type { ModalVoxCpm2VoiceProfile } from "./profiles";
import type { DialogSynthProvider } from "./synthProvider";
import { decodeWavPcm16, encodeWavPcm16, floatTo16BitPcm, trimSilencePcm16 } from "./wav";
import { DROPPED_CONNECTION_ATTEMPTS, postStudioTtsWav, retryDroppedConnection } from "./workerTts";
import { bytesToBase64 } from "../../shared/base64";

const referenceAudioCache = new Map<string, Promise<string>>();

async function loadReferenceAudioBase64(profile: ModalVoxCpm2VoiceProfile): Promise<string> {
  const referenceVoiceId = profile.referenceVoiceId;
  const referenceVoiceSha256 = profile.referenceVoiceSha256;
  if (!referenceVoiceId || !referenceVoiceSha256) {
    throw new Error("Burmese VoxCPM2 narration requires a recorded reference voice");
  }
  const key = `${referenceVoiceId}|${referenceVoiceSha256}`;
  let promise = referenceAudioCache.get(key);
  if (!promise) {
    promise = (async () => {
      const voice = await getCustomVoice(referenceVoiceId);
      if (!voice || voice.sampleSha256 !== referenceVoiceSha256) {
        throw new Error(
          `Reference voice "${referenceVoiceId}" is not in this browser — record or upload it again`,
        );
      }
      if (voice.sampleRate !== profile.referenceSampleRate) {
        throw new Error(
          `Reference voice uses ${voice.sampleRate}Hz audio; expected ${profile.referenceSampleRate}Hz`,
        );
      }
      if (!isVoxCpm2ReferenceReady(voice)) {
        throw new Error(
          `Burmese narration requires ${MIN_VOXCPM2_REFERENCE_SECONDS}–${MAX_SAMPLE_SECONDS}s of reference speech`,
        );
      }
      return bytesToBase64(
        encodeWavPcm16(floatTo16BitPcm(voice.samples), profile.referenceSampleRate),
      );
    })();
    promise.catch(() => referenceAudioCache.delete(key));
    referenceAudioCache.set(key, promise);
  }
  return promise;
}

/**
 * Synthesize one dialog through the same-origin Worker. The profile is used for
 * cache identity and local validation only: model settings and Modal
 * credentials are fixed server-side, so browser input cannot select arbitrary
 * infrastructure or inference code.
 */
export async function synthesizeModalVoxCpm2Wav(
  profile: ModalVoxCpm2VoiceProfile,
  speechText: string,
  seed: number,
): Promise<Uint8Array> {
  const referenceAudioBase64 = await loadReferenceAudioBase64(profile);
  const body = JSON.stringify({ text: speechText, seed, referenceAudioBase64 });

  return retryDroppedConnection(
    () => requestSynthesis(body),
    (error) =>
      new Error(
        `VoxCPM2 narration: the connection failed ${DROPPED_CONNECTION_ATTEMPTS} times (${error.message})`,
        { cause: error },
      ),
  );
}

/**
 * Trim the lead-in and tail silence VoxCPM2 leaves around the speech, the way
 * every provider's takes are (see trimSilence), so speech starts where the
 * schedule puts the dialog. Neither Modal nor the Worker trims, and the dialog
 * cache keeps the take as returned, so this runs on every build. The rate is
 * the take's own: re-encoding at the profile's would hide a wrong-rate take
 * from the Director's validation.
 */
export function prepareModalVoxCpm2Take(wav: Uint8Array): Uint8Array {
  const { pcm, sampleRate } = decodeWavPcm16(wav);
  return encodeWavPcm16(trimSilencePcm16(pcm, sampleRate), sampleRate);
}

/** The Director's Modal VoxCPM2 provider: the script's seed goes to Modal as it is. */
export function voxCpm2SynthProvider(
  profile: ModalVoxCpm2VoiceProfile,
  buildSeed: number,
): DialogSynthProvider {
  return {
    sampleRate: profile.sampleRate,
    mimeType: profile.mimeType,
    seed: buildSeed,
    // The first synthesis request intentionally owns any scale-to-zero
    // cold start; a separate preload request would spend Modal credits
    // without producing reusable audio.
    preload: async () => undefined,
    synthesize: async (speechText) => ({
      wav: await synthesizeModalVoxCpm2Wav(profile, speechText, buildSeed),
      hitFrameCap: false,
    }),
    prepareTake: prepareModalVoxCpm2Take,
  };
}

async function requestSynthesis(body: string): Promise<Uint8Array> {
  const result = await postStudioTtsWav("voxcpm2", body);
  if (result.kind === "error") {
    throw new Error(`VoxCPM2 narration: ${result.detail}`);
  }
  if (result.kind === "not-wav") {
    throw new Error("VoxCPM2 narration returned a non-WAV response");
  }
  return result.bytes;
}
