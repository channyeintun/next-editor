import { fetchPublishedDeck } from "../googleSlides/fetchPublishedDeck";
import { sha256Hex, sha256HexOfJson } from "./hash";
import type { StudioPlan } from "./plan";
import { compileLessonScript } from "./script/compile";
import { resolveScriptSlides } from "./script/googleSlides";
import { splitIntoDialogs, type NarrationDialog } from "./script/dialogs";
import { isBurmeseLocale } from "./narrationLanguage";
import { LEXICON_V1, speechTextOf, type PronunciationLexicon } from "./script/lexicon";
import { extractScriptNarration } from "./script/markers";
import { scheduleDialogs } from "./script/schedule";
import type { LessonScript } from "./script/schema";
import {
  deleteCachedDialogWav,
  getCachedDialogWav,
  putCachedDialogWav,
  type CachedDialogWav,
} from "./tts/dialogCache";
import { narrationNoiseSeed } from "./tts/pocket/noise";
import { preloadPocket, synthesizePocketDialog } from "./tts/pocketSynth";
import { requireVoiceProfile, ttsRequestHash, type VoiceProfile } from "./tts/profiles";
import { levelNarrationDialogs, NARRATION_LEVELING } from "./tts/loudness";
import { synthesizeModalVoxCpm2Wav } from "./tts/modalVoxCpm2Synth";
import { synthesizeAthanLabWav } from "./tts/athanlabSynth";
import { decodeWavPcm16, stitchPcmSegments, validateDialogWav } from "./tts/wav";

/**
 * The in-page Director stage (narration + compile at render time): split the
 * script's narration at its markers into dialogs, synthesize each with
 * the selected voice provider (per-dialog content-addressed cache),
 * level every dialog to one shared loudness, schedule dialogs jointly with
 * the actions, stitch one narration WAV, and compile the absolute-time plan.
 * Every dialog is content-addressed by its request, so edits only
 * re-synthesize the changed spans. Pocket-TTS and Modal VoxCPM2 are seeded,
 * so repeat builds reproduce identical audio: Pocket-TTS dialogs share one
 * noise seed, and Modal VoxCPM2 dialogs additionally reuse one recorded
 * reference for stable speaker identity. AthanLab is not seedable: its
 * dialogs pin one AthanLab voice, and a take is reproduced from the cache
 * (or, within 24 h, from the AthanLab job already bought for that request).
 */

export interface BuiltNarration {
  blob: Blob;
  bytes: Uint8Array;
  durationMs: number;
  /** sha256 of the stitched WAV — the manifest's narration hash. */
  audioSha256: string;
}

export interface InPageDirectorResult {
  plan: StudioPlan;
  narration: BuiltNarration;
  dialogCount: number;
  /** Dialogs actually synthesized this build (the rest were cache hits). */
  synthesizedCount: number;
  warnings: string[];
}

export interface InPageDirectorOptions {
  onPhase?: (phase: string) => void;
  /**
   * Render-time voice override — e.g. a cloned voice from this browser's
   * IndexedDB. When set it replaces the script's pinned `build.voiceProfile`;
   * the profile (including the sample hash) keys every dialog's cache entry.
   */
  voiceProfile?: VoiceProfile;
}

interface InPageSynthProvider {
  sampleRate: number;
  mimeType: string;
  preload(): Promise<unknown>;
  synthesize(speechText: string): Promise<CachedDialogWav>;
  /** Shared narration seed folded into each dialog's request hash. */
  seed: number;
}

function providerFor(
  profile: VoiceProfile,
  buildSeed: number,
  onPhase?: (phase: string) => void,
): InPageSynthProvider {
  switch (profile.providerId) {
    case "pocket-tts-web": {
      const noiseSeed = narrationNoiseSeed(buildSeed);
      return {
        sampleRate: profile.sampleRate,
        mimeType: profile.mimeType,
        seed: noiseSeed,
        preload: () => preloadPocket(profile, onPhase),
        synthesize: async (speechText) => {
          const { wav, cappedChunkCount } = await synthesizePocketDialog(
            profile,
            speechText,
            noiseSeed,
          );
          return { wav, hitFrameCap: cappedChunkCount > 0 };
        },
      };
    }
    case "voxcpm2-modal":
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
      };
    case "athanlab":
      return {
        sampleRate: profile.sampleRate,
        mimeType: profile.mimeType,
        // AthanLab takes no seed. A fixed one keeps a change to the script's
        // seed from re-keying — and so buying again — every AthanLab take.
        seed: 0,
        // Nothing to warm up: each dialog is one Worker request, and a
        // separate request would only spend the user's AthanLab balance.
        preload: async () => undefined,
        synthesize: async (speechText) => ({
          wav: await synthesizeAthanLabWav(profile, speechText),
          hitFrameCap: false,
        }),
      };
  }
}

/**
 * LEXICON_V1's respellings ("struckt", "funk", letter-by-letter initialisms)
 * are tuned for the English Pocket voice. Handed to the Burmese narrator they
 * are just misspelled English, so Burmese narration speaks (and aligns
 * captions on) its display tokens as written.
 */
const NO_RESPELLINGS: PronunciationLexicon = { version: 0, entries: {} };

function narrationLexiconFor(locale: string): PronunciationLexicon {
  return isBurmeseLocale(locale) ? NO_RESPELLINGS : LEXICON_V1;
}

const LABEL_PREVIEW_TOKENS = 6;

/**
 * How far a dialog may end from the narration's shared loudness before the
 * Director warns. Only a take that is very peaky or far too quiet ends off it.
 */
const MAX_LEVEL_DEVIATION_LU = 1;

/** `dialog 3/12 "intro.2" ("Go functions can return two values…")` — for errors and warnings. */
function dialogLabelOf(dialog: NarrationDialog, index: number, count: number): string {
  const preview = dialog.tokens.slice(0, LABEL_PREVIEW_TOKENS).join(" ");
  const ellipsis = dialog.tokens.length > LABEL_PREVIEW_TOKENS ? "…" : "";
  return `dialog ${index + 1}/${count} "${dialog.id}" ("${preview}${ellipsis}")`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface DialogTake extends CachedDialogWav {
  durationMs: number;
}

/**
 * A cached take, re-validated on the way out: an entry written before takes
 * were validated (or damaged in storage) is evicted and reported, and the
 * caller synthesizes it again instead of every later render failing on it
 * until site data is cleared.
 */
async function readCachedTake(
  requestHash: string,
  sampleRate: number,
  onInvalid: (reason: string) => void,
): Promise<DialogTake | null> {
  const cached = await getCachedDialogWav(requestHash);
  if (!cached) {
    return null;
  }
  try {
    return { ...cached, durationMs: validateDialogWav(cached.wav, sampleRate) };
  } catch (error) {
    await deleteCachedDialogWav(requestHash);
    onInvalid(errorMessageOf(error));
    return null;
  }
}

/**
 * Synthesize and validate one dialog. Validation happens before the caller
 * caches the take, so a truncated, wrong-rate, empty, or silent response fails
 * this render only rather than being replayed by every later one.
 */
async function synthesizeTake(
  provider: InPageSynthProvider,
  speechText: string,
  label: string,
): Promise<DialogTake> {
  let synthesized: CachedDialogWav;
  try {
    synthesized = await provider.synthesize(speechText);
  } catch (error) {
    throw new Error(`Narration ${label}: ${errorMessageOf(error)}`, { cause: error });
  }
  try {
    return {
      ...synthesized,
      durationMs: validateDialogWav(synthesized.wav, provider.sampleRate),
    };
  } catch (error) {
    const reason = errorMessageOf(error);
    throw new Error(`Narration ${label}: synthesized audio is unusable — ${reason}`, {
      cause: error,
    });
  }
}

export async function buildPlanFromScript(
  script: LessonScript,
  { onPhase, voiceProfile }: InPageDirectorOptions = {},
): Promise<InPageDirectorResult> {
  const profile = voiceProfile ?? requireVoiceProfile(script.build.voiceProfile);
  const provider = providerFor(profile, script.build.seed, onPhase);

  // Slide resolution doesn't depend on the narration, so its deck fetch and
  // image ingest round trips start now and overlap synthesis; the "slides"
  // stage below awaits the result. The no-op catch only stops a deck failure
  // from being reported as unhandled while synthesis runs (or after it throws
  // first) — awaiting the promise still rejects with it.
  const slidesResolution = resolveScriptSlides(script.lesson.slides, fetchPublishedDeck);
  slidesResolution.catch(() => {});

  const extracted = extractScriptNarration(script);
  const dialogs = splitIntoDialogs(extracted);
  const lexicon = narrationLexiconFor(script.lesson.locale);

  // ---- Per-dialog synthesis through the content-addressed cache -----------
  const takes: Uint8Array[] = [];
  const labels: string[] = [];
  const durationsMs: number[] = [];
  const dialogHashes: string[] = [];
  const synthesisWarnings: string[] = [];
  let synthesizedCount = 0;
  // The request hashes never need the engine, so it loads on the first cache
  // miss: Pocket builds four ONNX sessions from a ~125 MB bundle on the main
  // thread, which a fully cached render (the usual edit-and-rerender loop)
  // would otherwise pay on every page load for nothing.
  let providerLoaded = false;
  for (let i = 0; i < dialogs.length; i++) {
    onPhase?.(`synthesize ${i + 1}/${dialogs.length}`);
    const speechText = speechTextOf(dialogs[i].tokens, lexicon);
    const requestHash = await ttsRequestHash({
      profile,
      speechText,
      // The lexicon's whole effect is the speech text, which is hashed above,
      // so this stays the lexicon release for every language: a Burmese
      // dialog the English respellings never touched keeps its request hash
      // (and its paid Modal or AthanLab take); one they did touch re-keys by
      // its text.
      lexiconVersion: LEXICON_V1.version,
      seed: provider.seed,
    });
    dialogHashes.push(requestHash);

    const label = dialogLabelOf(dialogs[i], i, dialogs.length);
    labels.push(label);
    let take = await readCachedTake(requestHash, provider.sampleRate, (reason) =>
      synthesisWarnings.push(
        `Cached audio for ${label} was unusable (${reason}) and was synthesized again`,
      ),
    );
    if (!take) {
      if (!providerLoaded) {
        onPhase?.("tts-model");
        await provider.preload();
        providerLoaded = true;
        // The load reports its own sub-phases; put this dialog's progress back.
        onPhase?.(`synthesize ${i + 1}/${dialogs.length}`);
      }
      take = await synthesizeTake(provider, speechText, label);
      // A frame-capped take is cached too: Pocket is seeded and deterministic,
      // so synthesizing the same request again reproduces the same audio and
      // would only cost time. The flag travels with the entry, so the warning
      // repeats on every render until the dialog's text changes.
      await putCachedDialogWav(requestHash, take);
      synthesizedCount += 1;
    }
    if (take.hitFrameCap) {
      synthesisWarnings.push(
        `${capitalize(label)} ran to the speech engine's length limit without the model ending the sentence — listen for run-on or cut-off audio, and reword or split that sentence if it sounds wrong`,
      );
    }
    takes.push(take.wav);
    durationsMs.push(take.durationMs);
  }

  // ---- One loudness for every dialog --------------------------------------
  // The cache keeps each raw take; leveling happens on every build, so a
  // change to the leveling never invalidates paid or slow synthesis. The gain
  // is per dialog and static, so durations (and the schedule) do not change.
  const leveled = levelNarrationDialogs(
    takes.map((wav) => decodeWavPcm16(wav).pcm),
    provider.sampleRate,
  );
  const levelingWarnings = leveled.dialogs.flatMap(({ leveledLufs }, index) => {
    const offLu = leveledLufs === null ? 0 : leveledLufs - leveled.levelLufs;
    if (Math.abs(offLu) <= MAX_LEVEL_DEVIATION_LU) {
      return [];
    }
    const direction = offLu < 0 ? "quieter" : "louder";
    return [
      `${capitalize(labels[index])} stays ${Math.abs(offLu).toFixed(1)} dB ${direction} than the rest of the narration after leveling — listen to it, and reword that dialog if it stands out`,
    ];
  });

  // ---- Joint scheduling + stitch ------------------------------------------
  onPhase?.("schedule");
  const schedule = scheduleDialogs({
    script,
    extracted,
    dialogs,
    durationsMs,
    lexicon,
  });

  // The leveled samples go straight onto the canvas: every take was validated
  // at the provider's rate, so there is nothing to re-encode or re-check.
  const stitched = stitchPcmSegments(
    schedule.timeline.map((entry, index) => ({
      pcm: leveled.dialogs[index].pcm,
      startMs: entry.startMs,
    })),
    schedule.totalDurationMs,
    provider.sampleRate,
  );
  const audioSha256 = await sha256Hex(stitched);
  // The leveling settings are part of the key: changing them changes the
  // stitched audio, so the plan hash changes with it and a stored
  // repeatability baseline resets instead of reporting different audio.
  const narrationKey = await sha256HexOfJson({
    dialogHashes,
    totalDurationMs: schedule.totalDurationMs,
    leveling: NARRATION_LEVELING,
  });

  // ---- Resolve published-deck slides into pinned google-svg content ------
  onPhase?.("slides");
  const resolvedSlides = await slidesResolution;

  // ---- Compile (same gates as any plan; fails closed before recording) ----
  onPhase?.("compile");
  const { plan, warnings } = compileLessonScript({
    script,
    extracted,
    alignment: schedule.alignment,
    narration: {
      audioPath: `studio-tts://${narrationKey.slice(0, 16)}`,
      mimeType: provider.mimeType,
      durationMs: schedule.totalDurationMs,
    },
    resolvedSlides,
  });

  return {
    plan,
    narration: {
      blob: new Blob([stitched], { type: provider.mimeType }),
      bytes: stitched,
      durationMs: schedule.totalDurationMs,
      audioSha256,
    },
    dialogCount: dialogs.length,
    synthesizedCount,
    warnings: [...synthesisWarnings, ...levelingWarnings, ...schedule.warnings, ...warnings],
  };
}
