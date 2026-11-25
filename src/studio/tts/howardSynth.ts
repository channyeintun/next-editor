import { getCustomVoice, MAX_SAMPLE_SECONDS, type SavedCustomVoice } from "./customVoices";
import type { CachedDialogWav } from "./dialogCache";
import {
  HOWARD_MIN_REFERENCE_SECONDS,
  howardFrameCapOf,
  howardTakeHitFrameCap,
  isHowardReferenceReady,
} from "./howard/protocol";
import {
  fetchHowardServerModel,
  howardServerUrl,
  isUnknownHowardVoice,
  registerHowardVoice,
  requestHowardSpeech,
  type HowardServerReport,
} from "./howard/server";
import { howardProfileOf, type HowardVoiceProfile } from "./profiles";
import type { DialogSynthProvider } from "./synthProvider";
import { decodeWavPcm16, encodeWavPcm16, floatTo16BitPcm, trimWavSilence } from "./wav";
import { bytesToBase64 } from "../../shared/base64";

/**
 * Howard synthesis adapter: one request per dialog to the server the author
 * runs on this computer (howard/server.ts). The narrator's reference
 * recording is registered with that server once as a cloned voice; every
 * dialog then names the voice, so one speaker narrates the whole lesson.
 */

/** The narrator recording a Howard voice is cloned from. */
export type HowardReference = Pick<HowardVoiceProfile, "referenceVoiceId" | "referenceVoiceSha256">;

/**
 * The profile a render narrates with now: the selected narrator reference,
 * keyed by the model the author's server named. Throws what is missing. The
 * server does not have to be answering: a lesson narrated earlier then renders
 * from the dialog cache.
 */
export function howardNarrationProfileOf(
  voice: SavedCustomVoice | null,
  server: HowardServerReport,
): HowardVoiceProfile {
  if (server.modelId === null) {
    throw new Error(server.reason ?? "Start the Howard server on this computer first.");
  }
  if (!voice || !isHowardReferenceReady(voice, MAX_SAMPLE_SECONDS)) {
    throw new Error(
      `Howard narration requires a ${HOWARD_MIN_REFERENCE_SECONDS}–${MAX_SAMPLE_SECONDS}s narrator reference. Record or upload one first.`,
    );
  }
  return howardProfileOf(voice, server.modelId);
}

/** Voices this page has registered, by server and recording: each resolves to the voice's name. */
const registeredVoices = new Map<string, Promise<string>>();

function registrationKeyOf(serverUrl: string, reference: HowardReference): string {
  return `${serverUrl}|${reference.referenceVoiceId}|${reference.referenceVoiceSha256}`;
}

/** The recording as the server takes it: a mono PCM16 WAV in base64. */
async function referenceWavBase64(reference: HowardReference): Promise<string> {
  const voice = await getCustomVoice(reference.referenceVoiceId);
  if (!voice || voice.sampleSha256 !== reference.referenceVoiceSha256) {
    throw new Error(
      `Reference voice "${reference.referenceVoiceId}" is not in this browser — record or upload it again`,
    );
  }
  if (!isHowardReferenceReady(voice, MAX_SAMPLE_SECONDS)) {
    throw new Error(
      `Howard narration requires ${HOWARD_MIN_REFERENCE_SECONDS}–${MAX_SAMPLE_SECONDS}s of reference speech`,
    );
  }
  return bytesToBase64(encodeWavPcm16(floatTo16BitPcm(voice.samples), voice.sampleRate));
}

/** Register the recording with the server, once per page, and resolve to the voice's name. */
function registerReference(serverUrl: string, reference: HowardReference): Promise<string> {
  const key = registrationKeyOf(serverUrl, reference);
  let registration = registeredVoices.get(key);
  if (!registration) {
    registration = (async () => {
      // The server lowercases names; a hex digest already is.
      const name = `ne-${reference.referenceVoiceSha256.slice(0, 32)}`;
      await registerHowardVoice(serverUrl, name, await referenceWavBase64(reference));
      return name;
    })();
    registration.catch(() => registeredVoices.delete(key));
    registeredVoices.set(key, registration);
  }
  return registration;
}

/**
 * Synthesize one dialog on the author's Howard server. The take is flagged
 * when it ran to its frame cap, which means the model never ended the
 * sentence itself.
 */
export async function synthesizeHowardDialog(
  reference: HowardReference,
  speechText: string,
  seed: number,
): Promise<CachedDialogWav> {
  const serverUrl = howardServerUrl();
  const input = speechText.trim();
  const frameCap = howardFrameCapOf(input);
  const speak = async () =>
    requestHowardSpeech(serverUrl, {
      input,
      voice: await registerReference(serverUrl, reference),
      seed,
      maxNewTokens: frameCap,
    });

  let wav: Uint8Array;
  try {
    wav = await speak();
  } catch (error) {
    // The server keeps its voices in memory, so one that was restarted has
    // forgotten the voice this page registered. Register it again, once.
    if (!isUnknownHowardVoice(error)) throw error;
    registeredVoices.delete(registrationKeyOf(serverUrl, reference));
    wav = await speak();
  }
  return { wav, hitFrameCap: howardTakeHitFrameCap(decodeWavPcm16(wav).pcm.length, frameCap) };
}

/**
 * What a build does before its first uncached dialog: check that the server
 * still runs the model the profile is keyed by, then register the narrator. A
 * server that is off, or that now runs another talker, stops the build here
 * with the reason instead of filing takes under the wrong model.
 */
async function prepareServer(profile: HowardVoiceProfile): Promise<void> {
  const serverUrl = howardServerUrl();
  const model = await fetchHowardServerModel(serverUrl);
  if (model !== profile.serverModelId) {
    throw new Error(
      `Howard: the server at ${serverUrl} now runs "${model}", not "${profile.serverModelId}" — check the server in the Render tab, then render again`,
    );
  }
  await registerReference(serverUrl, profile);
}

/** The Director's Howard provider: the script's seed goes to the server as it is. */
export function howardSynthProvider(
  profile: HowardVoiceProfile,
  buildSeed: number,
): DialogSynthProvider {
  return {
    sampleRate: profile.sampleRate,
    mimeType: profile.mimeType,
    seed: buildSeed,
    preload: () => prepareServer(profile),
    synthesize: (speechText) => synthesizeHowardDialog(profile, speechText, buildSeed),
    // The server returns the take as the model made it, lead-in silence and all.
    prepareTake: trimWavSilence,
  };
}

/** synthesizeHowardDialog's WAV alone, trimmed, for one-off previews. */
export async function synthesizeHowardWav(
  reference: HowardReference,
  speechText: string,
  seed: number,
): Promise<Uint8Array> {
  return trimWavSilence((await synthesizeHowardDialog(reference, speechText, seed)).wav);
}
