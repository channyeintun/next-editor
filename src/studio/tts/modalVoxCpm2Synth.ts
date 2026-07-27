import { getCustomVoice, MAX_SAMPLE_SECONDS, MIN_VOXCPM2_REFERENCE_SECONDS } from "./customVoices";
import type { ModalVoxCpm2VoiceProfile } from "./profiles";
import { encodeWavPcm16, floatTo16BitPcm } from "./wav";

interface ErrorPayload {
  error?: unknown;
}

const referenceAudioCache = new Map<string, Promise<string>>();

function base64Of(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

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
      const durationSeconds = voice.samples.length / voice.sampleRate;
      if (durationSeconds < MIN_VOXCPM2_REFERENCE_SECONDS || durationSeconds > MAX_SAMPLE_SECONDS) {
        throw new Error(
          `Burmese narration requires ${MIN_VOXCPM2_REFERENCE_SECONDS}–${MAX_SAMPLE_SECONDS}s of reference speech`,
        );
      }
      return base64Of(encodeWavPcm16(floatTo16BitPcm(voice.samples), profile.referenceSampleRate));
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
  if (profile.sampleRate !== 48_000 || profile.mimeType !== "audio/wav") {
    throw new Error(`Unsupported VoxCPM2 profile "${profile.id}"`);
  }
  const referenceAudioBase64 = await loadReferenceAudioBase64(profile);

  const response = await fetch("/api/studio/tts/voxcpm2", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "audio/wav",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: speechText, seed, referenceAudioBase64 }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ErrorPayload | null;
    const detail =
      typeof payload?.error === "string"
        ? payload.error
        : `request failed with HTTP ${response.status}`;
    throw new Error(`VoxCPM2 narration: ${detail}`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("audio/wav")) {
    throw new Error("VoxCPM2 narration returned a non-WAV response");
  }

  return new Uint8Array(await response.arrayBuffer());
}
