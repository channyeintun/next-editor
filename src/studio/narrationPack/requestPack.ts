import { narrationRequestsOf } from "../inPageDirector";
import type { LessonScript } from "../script/schema";
import { hasCachedDialogWav, isDialogCacheAvailable } from "../tts/dialogCache";
import { voxCpm2ReferenceWavBase64, voxCpm2TextLengthError } from "../tts/modalVoxCpm2Synth";
import type { ModalVoxCpm2VoiceProfile, VoiceProfile } from "../tts/profiles";
import {
  NARRATION_REQUEST_PACK_FORMAT,
  NARRATION_REQUEST_PACK_VERSION,
  narrationPackEngineOf,
  type NarrationPackEngine,
} from "./packFormat";

/**
 * Offline narration, the export half: the VoxCPM2 speech requests of one or
 * many lessons as a file, for a synthesizer that runs somewhere the studio
 * cannot call — the Colab notebook in integrations/colab. Each request keeps
 * the hash the dialog cache files its take under, so the audio the notebook
 * writes back (audioImport.ts) is found by the next render, which then asks no
 * speech service for it.
 *
 * The requests are the ones a render makes: they come from the Director
 * (narrationRequestsOf) and are never derived again here.
 */

export interface NarrationPackDialog {
  /** The dialog cache's key for this take; the notebook names its audio file by it. */
  hash: string;
  /** The lesson that asks for it, to report progress by. */
  lesson: string;
  text: string;
  seed: number;
}

export interface NarrationRequestPack {
  format: typeof NARRATION_REQUEST_PACK_FORMAT;
  version: typeof NARRATION_REQUEST_PACK_VERSION;
  createdAt: string;
  /** The notebook is built for one engine and refuses a pack that asks for another. */
  engine: NarrationPackEngine;
  /** The narrator's reference recording: a mono PCM16 WAV in base64. */
  reference: { sampleRate: number; wavBase64: string };
  dialogs: NarrationPackDialog[];
}

export interface NarrationPackLesson {
  slug: string;
  script: LessonScript;
  /** The render-time voice, as the render of this lesson gets it. */
  voiceProfile?: VoiceProfile;
}

export interface NarrationRequestPackExport {
  /** The file to hand to the notebook, or null when no dialog needs synthesis. */
  pack: NarrationRequestPack | null;
  lessonCount: number;
  /** Dialogs in the pack. */
  dialogCount: number;
  /** Characters of speech text in the pack. */
  characterCount: number;
  /** Dialogs left out because this browser already keeps their take. */
  cachedCount: number;
  /** Why this browser cannot tell which takes it keeps, so the pack has every dialog. */
  cacheUnavailable: string | null;
}

/** What the export asks of the rest of the studio; tests replace it. */
export interface NarrationRequestPackDeps {
  requestsOf: typeof narrationRequestsOf;
  hasCached: typeof hasCachedDialogWav;
  cacheAvailable: typeof isDialogCacheAvailable;
  referenceWavBase64: typeof voxCpm2ReferenceWavBase64;
}

/**
 * The requests of these lessons that this browser has no take for yet, with
 * the one narrator reference they all speak in. Throws for a lesson that is
 * not narrated by VoxCPM2, for lessons that do not share a narrator, and for a
 * dialog VoxCPM2 would refuse — naming the lesson.
 */
export async function buildNarrationRequestPack(
  lessons: readonly NarrationPackLesson[],
  { now = new Date(), deps = {} }: { now?: Date; deps?: Partial<NarrationRequestPackDeps> } = {},
): Promise<NarrationRequestPackExport> {
  const requestsOf = deps.requestsOf ?? narrationRequestsOf;
  const hasCached = deps.hasCached ?? hasCachedDialogWav;
  const cacheAvailable = deps.cacheAvailable ?? isDialogCacheAvailable;
  const referenceWavBase64 = deps.referenceWavBase64 ?? voxCpm2ReferenceWavBase64;
  let narrator: ModalVoxCpm2VoiceProfile | null = null;
  // Where Cache storage does not exist a lookup misses without a report, and
  // the audio could not be imported here either.
  let cacheUnavailable: string | null = cacheAvailable()
    ? null
    : "Cache storage is not available in this page";
  let cachedCount = 0;
  const dialogs = new Map<string, NarrationPackDialog>();

  for (const { slug, script, voiceProfile } of lessons) {
    const { profile, requests } = await requestsOf(script, { voiceProfile });
    if (profile.providerId !== "voxcpm2-modal") {
      throw new Error(
        `"${slug}" is not narrated by VoxCPM2 — offline narration packs carry the Burmese voice only`,
      );
    }
    if (narrator && narrator.id !== profile.id) {
      throw new Error(`"${slug}" uses another narrator than the lessons before it`);
    }
    narrator = profile;
    for (const request of requests) {
      const tooLong = voxCpm2TextLengthError(request.speechText);
      if (tooLong) {
        throw new Error(`"${slug}", ${request.label}: ${tooLong}`);
      }
      if (dialogs.has(request.requestHash)) continue;
      const cached = await hasCached(request.requestHash, (reason) => {
        cacheUnavailable ??= reason;
      });
      if (cached) {
        cachedCount += 1;
        continue;
      }
      dialogs.set(request.requestHash, {
        hash: request.requestHash,
        lesson: slug,
        text: request.speechText,
        seed: request.seed,
      });
    }
  }

  const counts = {
    lessonCount: lessons.length,
    dialogCount: dialogs.size,
    characterCount: [...dialogs.values()].reduce((sum, dialog) => sum + dialog.text.length, 0),
    cachedCount,
    cacheUnavailable,
  };
  if (!narrator || dialogs.size === 0) {
    return { pack: null, ...counts };
  }
  return {
    pack: {
      format: NARRATION_REQUEST_PACK_FORMAT,
      version: NARRATION_REQUEST_PACK_VERSION,
      createdAt: now.toISOString(),
      engine: narrationPackEngineOf(narrator),
      reference: {
        sampleRate: narrator.referenceSampleRate,
        wavBase64: await referenceWavBase64(narrator),
      },
      dialogs: [...dialogs.values()],
    },
    ...counts,
  };
}
