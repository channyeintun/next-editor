import type { ModalVoxCpm2VoiceProfile } from "./profiles";

interface ErrorPayload {
  error?: unknown;
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

  const response = await fetch("/api/studio/tts/voxcpm2", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "audio/wav",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: speechText, seed }),
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
