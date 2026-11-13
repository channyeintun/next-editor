import { fetchPublishedDeck } from "../googleSlides/fetchPublishedDeck";
import { sha256Hex, sha256HexOfJson } from "./hash";
import type { StudioPlan } from "./plan";
import { compileLessonScript } from "./script/compile";
import { resolveScriptSlides } from "./script/googleSlides";
import { splitIntoDialogs, type NarrationDialog } from "./script/dialogs";
import {
  LEXICON_V1,
  narrationLexiconFor,
  speechTextOf,
  type PronunciationLexicon,
} from "./script/lexicon";
import { extractScriptNarration, type ExtractedNarration } from "./script/markers";
import { scheduleDialogs } from "./script/schedule";
import type { LessonScript } from "./script/schema";
import {
  deleteCachedDialogWav,
  getCachedDialogWav,
  hasCachedDialogWav,
  isDialogCacheAvailable,
  putCachedDialogWav,
  type CachedDialogWav,
  type OnDialogCacheUnavailable,
} from "./tts/dialogCache";
import { pocketSynthProvider } from "./tts/pocketSynth";
import { requireVoiceProfile, ttsRequestHash, type VoiceProfile } from "./tts/profiles";
import { levelNarrationDialogs, NARRATION_LEVELING } from "./tts/loudness";
import { voxCpm2SynthProvider } from "./tts/modalVoxCpm2Synth";
import { athanLabSynthProvider } from "./tts/athanlabSynth";
import type { DialogSynthProvider } from "./tts/synthProvider";
import { stitchPcmSegments, validateDialogWav } from "./tts/wav";

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
 *
 * The synthesis half also runs on its own (synthesizeNarrationAhead): it fills
 * the dialog cache for a script without building its plan, so a studio
 * workflow can narrate all of its lessons in one run before the first render.
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

/** The selected voice's provider; each adapter owns its seed and preload policy. */
function providerFor(
  profile: VoiceProfile,
  buildSeed: number,
  onPhase?: (phase: string) => void,
): DialogSynthProvider {
  switch (profile.providerId) {
    case "pocket-tts-web":
      return pocketSynthProvider(profile, buildSeed, onPhase);
    case "voxcpm2-modal":
      return voxCpm2SynthProvider(profile, buildSeed);
    case "athanlab":
      return athanLabSynthProvider(profile);
  }
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
  /** The prepared take's samples, decoded once by its validation. */
  pcm: Int16Array;
}

/**
 * The take the Director schedules from one the cache keeps (as synthesized):
 * prepared by its provider, then validated. Throws with the reason a take is
 * unusable.
 */
function preparedTakeOf(provider: DialogSynthProvider, raw: CachedDialogWav): DialogTake {
  const wav = provider.prepareTake(raw.wav);
  return { ...raw, wav, ...validateDialogWav(wav, provider.sampleRate) };
}

/**
 * A cached take, re-validated on the way out: an entry written before takes
 * were validated (or damaged in storage) is evicted and reported, and the
 * caller synthesizes it again instead of every later render failing on it
 * until site data is cleared.
 */
async function readCachedTake(
  requestHash: string,
  provider: DialogSynthProvider,
  onInvalid: (reason: string) => void,
  onCacheUnavailable: OnDialogCacheUnavailable,
): Promise<DialogTake | null> {
  const cached = await getCachedDialogWav(requestHash, onCacheUnavailable);
  if (!cached) {
    return null;
  }
  try {
    return preparedTakeOf(provider, cached);
  } catch (error) {
    await deleteCachedDialogWav(requestHash, onCacheUnavailable);
    onInvalid(errorMessageOf(error));
    return null;
  }
}

/**
 * Synthesize, prepare, and validate one dialog. Validation happens before the
 * caller caches the raw take, so a truncated, wrong-rate, empty, or silent
 * response fails this render only rather than being replayed by every later
 * one.
 */
async function synthesizeTake(
  provider: DialogSynthProvider,
  speechText: string,
  label: string,
): Promise<{ raw: CachedDialogWav; take: DialogTake }> {
  let raw: CachedDialogWav;
  try {
    raw = await provider.synthesize(speechText);
  } catch (error) {
    throw new Error(`Narration ${label}: ${errorMessageOf(error)}`, { cause: error });
  }
  try {
    return { raw, take: preparedTakeOf(provider, raw) };
  } catch (error) {
    const reason = errorMessageOf(error);
    throw new Error(`Narration ${label}: synthesized audio is unusable — ${reason}`, {
      cause: error,
    });
  }
}

/** A script's narration as the synthesis stage sees it: what to say, and with which voice. */
interface ScriptNarration {
  profile: VoiceProfile;
  provider: DialogSynthProvider;
  extracted: ExtractedNarration;
  dialogs: NarrationDialog[];
  lexicon: PronunciationLexicon;
}

function scriptNarrationOf(
  script: LessonScript,
  { onPhase, voiceProfile }: InPageDirectorOptions,
): ScriptNarration {
  const profile = voiceProfile ?? requireVoiceProfile(script.build.voiceProfile);
  const extracted = extractScriptNarration(script);
  return {
    profile,
    provider: providerFor(profile, script.build.seed, onPhase),
    extracted,
    dialogs: splitIntoDialogs(extracted),
    lexicon: narrationLexiconFor(script.lesson.locale),
  };
}

interface DialogRequest {
  speechText: string;
  /** The content address of this dialog's take in the dialog cache. */
  requestHash: string;
  /** Names the dialog in errors and warnings. */
  label: string;
}

async function dialogRequestOf(
  { profile, provider, dialogs, lexicon }: ScriptNarration,
  index: number,
): Promise<DialogRequest> {
  const speechText = speechTextOf(dialogs[index].tokens, lexicon);
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
  return { speechText, requestHash, label: dialogLabelOf(dialogs[index], index, dialogs.length) };
}

function synthesisPhaseOf(index: number, count: number): string {
  return `synthesize ${index + 1}/${count}`;
}

/**
 * Synthesizes the dialogs the cache misses. The request hashes never need the
 * engine, so it loads on the first miss: Pocket builds four ONNX sessions from
 * a ~125 MB bundle on the main thread, which a fully cached render (the usual
 * edit-and-rerender loop) would otherwise pay on every page load for nothing.
 */
function missSynthesizerOf(provider: DialogSynthProvider, onPhase?: (phase: string) => void) {
  let providerLoaded = false;
  return async (request: DialogRequest, dialogPhase: string) => {
    if (!providerLoaded) {
      onPhase?.("tts-model");
      await provider.preload();
      providerLoaded = true;
      // The load reports its own sub-phases; put this dialog's progress back.
      onPhase?.(dialogPhase);
    }
    return synthesizeTake(provider, request.speechText, request.label);
  };
}

export interface NarrationAheadOptions extends InPageDirectorOptions {
  /** Asked before each dialog; true stops the pass there. */
  isCancelled?: () => boolean;
}

export type NarrationAheadResult =
  | { outcome: "ready"; dialogCount: number; synthesizedCount: number }
  | { outcome: "cancelled" }
  /**
   * The dialog cache cannot keep takes, so the build would synthesize every
   * one again: narrating ahead would only pay for the narration twice.
   */
  | { outcome: "cache-unavailable"; reason: string };

/**
 * Synthesize a script's narration into the dialog cache without building its
 * plan, so that a later buildPlanFromScript of the same script and voice finds
 * every dialog cached and calls no speech service. A studio workflow runs this
 * over all of its lessons before the first render: the narration is then one
 * unbroken run, and a hosted GPU voice starts once instead of once per lesson.
 *
 * A dialog that is already cached is only looked up, not read: the build
 * validates each take when it reads it, and synthesizes an unusable one again.
 * A fresh take is validated before it is cached, as in the build. Throws what
 * the build would for a dialog that cannot be synthesized, naming the dialog.
 */
export async function synthesizeNarrationAhead(
  script: LessonScript,
  { isCancelled, ...options }: NarrationAheadOptions = {},
): Promise<NarrationAheadResult> {
  if (!isDialogCacheAvailable()) {
    return { outcome: "cache-unavailable", reason: "Cache storage is not available in this page" };
  }
  const { onPhase } = options;
  const narration = scriptNarrationOf(script, options);
  const { provider, dialogs } = narration;

  // The first storage failure ends the pass: from there nothing it synthesizes
  // is kept for the build.
  let cacheFailure: string | null = null;
  const onCacheUnavailable: OnDialogCacheUnavailable = (reason) => {
    cacheFailure ??= reason;
  };
  const cacheUnavailable = (): NarrationAheadResult | null =>
    cacheFailure === null ? null : { outcome: "cache-unavailable", reason: cacheFailure };

  const synthesizeMiss = missSynthesizerOf(provider, onPhase);
  let synthesizedCount = 0;
  for (let i = 0; i < dialogs.length; i++) {
    if (isCancelled?.()) {
      return { outcome: "cancelled" };
    }
    const phase = synthesisPhaseOf(i, dialogs.length);
    onPhase?.(phase);
    const request = await dialogRequestOf(narration, i);
    const cached = await hasCachedDialogWav(request.requestHash, onCacheUnavailable);
    // A failed lookup is not a miss to pay for: the take could not be kept either.
    if (!cached && !cacheUnavailable()) {
      const synthesized = await synthesizeMiss(request, phase);
      await putCachedDialogWav(request.requestHash, synthesized.raw, onCacheUnavailable);
      synthesizedCount += 1;
    }
    const unavailable = cacheUnavailable();
    if (unavailable) {
      return unavailable;
    }
  }
  return { outcome: "ready", dialogCount: dialogs.length, synthesizedCount };
}

export async function buildPlanFromScript(
  script: LessonScript,
  options: InPageDirectorOptions = {},
): Promise<InPageDirectorResult> {
  const { onPhase } = options;
  const narration = scriptNarrationOf(script, options);
  const { provider, extracted, dialogs, lexicon } = narration;

  // Slide resolution doesn't depend on the narration, so its deck fetch and
  // image ingest round trips start now and overlap synthesis; the "slides"
  // stage below awaits the result. The no-op catch only stops a deck failure
  // from being reported as unhandled while synthesis runs (or after it throws
  // first) — awaiting the promise still rejects with it.
  const slidesResolution = resolveScriptSlides(script.lesson.slides, fetchPublishedDeck);
  slidesResolution.catch(() => {});

  // ---- Per-dialog synthesis through the content-addressed cache -----------
  const takes: Int16Array[] = [];
  const labels: string[] = [];
  const durationsMs: number[] = [];
  const dialogHashes: string[] = [];
  const synthesisWarnings: string[] = [];
  // The cache only saves synthesis, so a storage failure is a miss: the render
  // goes on, and one warning says the takes are not kept for the next render.
  let cacheUnavailable = false;
  const onCacheUnavailable: OnDialogCacheUnavailable = (reason) => {
    if (cacheUnavailable) {
      return;
    }
    cacheUnavailable = true;
    synthesisWarnings.push(
      `Narration cache unavailable: ${reason} — takes are synthesized again next render`,
    );
  };
  let synthesizedCount = 0;
  const synthesizeMiss = missSynthesizerOf(provider, onPhase);
  for (let i = 0; i < dialogs.length; i++) {
    const phase = synthesisPhaseOf(i, dialogs.length);
    onPhase?.(phase);
    const request = await dialogRequestOf(narration, i);
    const { requestHash, label } = request;
    dialogHashes.push(requestHash);
    labels.push(label);
    let take = await readCachedTake(
      requestHash,
      provider,
      (reason) =>
        synthesisWarnings.push(
          `Cached audio for ${label} was unusable (${reason}) and was synthesized again`,
        ),
      onCacheUnavailable,
    );
    if (!take) {
      const synthesized = await synthesizeMiss(request, phase);
      // The cache keeps the take as synthesized; preparing it happens on every
      // build, like the leveling below, so a change to a provider's
      // preparation never invalidates paid or slow synthesis. A frame-capped
      // take is cached too: Pocket is seeded and deterministic, so
      // synthesizing the same request again reproduces the same audio and
      // would only cost time. The flag travels with the entry, so the warning
      // repeats on every render until the dialog's text changes.
      await putCachedDialogWav(requestHash, synthesized.raw, onCacheUnavailable);
      take = synthesized.take;
      synthesizedCount += 1;
    }
    if (take.hitFrameCap) {
      synthesisWarnings.push(
        `${capitalize(label)} ran to the speech engine's length limit without the model ending the sentence — listen for run-on or cut-off audio, and reword or split that sentence if it sounds wrong`,
      );
    }
    takes.push(take.pcm);
    durationsMs.push(take.durationMs);
  }

  // ---- One loudness for every dialog --------------------------------------
  // The cache keeps each raw take; leveling happens on every build, so a
  // change to the leveling never invalidates paid or slow synthesis. The gain
  // is per dialog and static, so durations (and the schedule) do not change.
  const leveled = levelNarrationDialogs(takes, provider.sampleRate);
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

  // The leveled samples go straight into the narration WAV: every take was
  // validated at the provider's rate, so there is nothing to re-encode or
  // re-check.
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
