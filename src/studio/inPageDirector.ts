import { sha256Hex, sha256HexOfJson } from "./hash";
import type { StudioPlan } from "./plan";
import { compileLessonScript } from "./script/compile";
import { splitIntoDialogs } from "./script/dialogs";
import { LEXICON_V1, speechTextOf } from "./script/lexicon";
import { extractNarration } from "./script/markers";
import { scheduleDialogs } from "./script/schedule";
import type { LessonScript } from "./script/schema";
import { getCachedDialogWav, putCachedDialogWav } from "./tts/dialogCache";
import {
  defaultKokoroDevice,
  preloadKokoro,
  synthesizeKokoroWav,
  type KokoroDevice,
} from "./tts/kokoroSynth";
import { requireVoiceProfile } from "./tts/profiles";
import { ttsRequestHash } from "./tts/profiles";
import { stitchWavSegments, wavDurationMs } from "./tts/wav";

/**
 * The in-page Director stage (narration + compile at render time): split the
 * script's narration at its markers into dialogs, synthesize each with
 * Kokoro over onnxruntime-web (per-dialog content-addressed cache), schedule
 * dialogs jointly with the actions, stitch one narration WAV, and compile the
 * absolute-time plan. Everything is deterministic given the cached audio;
 * dialog edits only re-synthesize the changed spans.
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
  device?: KokoroDevice;
  onPhase?: (phase: string) => void;
}

export async function buildPlanFromScript(
  script: LessonScript,
  { device = defaultKokoroDevice(), onPhase }: InPageDirectorOptions = {},
): Promise<InPageDirectorResult> {
  const profile = requireVoiceProfile(script.build.voiceProfile);
  if (profile.providerId !== "kokoro-js") {
    throw new Error(
      `Voice profile "${profile.id}" (${profile.providerId}) cannot synthesize in the page — use a kokoro-js profile`,
    );
  }

  const extracted = extractNarration(
    script.scenes.map((scene) => ({ sceneId: scene.id, narration: scene.narration })),
  );
  const dialogs = splitIntoDialogs(extracted);

  onPhase?.("tts-model");
  await preloadKokoro(profile, device);

  // ---- Per-dialog synthesis through the content-addressed cache -----------
  const segments: Uint8Array[] = [];
  const durationsMs: number[] = [];
  const dialogHashes: string[] = [];
  let synthesizedCount = 0;
  for (let i = 0; i < dialogs.length; i++) {
    onPhase?.(`synthesize ${i + 1}/${dialogs.length}`);
    const speechText = speechTextOf(dialogs[i].tokens, LEXICON_V1);
    const requestHash = await ttsRequestHash({
      profile,
      speechText,
      lexiconVersion: LEXICON_V1.version,
    });
    dialogHashes.push(requestHash);

    let wav = await getCachedDialogWav(requestHash);
    if (!wav) {
      wav = await synthesizeKokoroWav(profile, speechText, device);
      await putCachedDialogWav(requestHash, wav);
      synthesizedCount += 1;
    }
    segments.push(wav);
    durationsMs.push(wavDurationMs(wav));
  }

  // ---- Joint scheduling + stitch ------------------------------------------
  onPhase?.("schedule");
  const schedule = scheduleDialogs({
    script,
    extracted,
    dialogs,
    durationsMs,
    lexicon: LEXICON_V1,
  });

  const stitched = stitchWavSegments(
    schedule.timeline.map((entry, index) => ({
      bytes: segments[index],
      startMs: entry.startMs,
    })),
    schedule.totalDurationMs,
    profile.sampleRate,
  );
  const audioSha256 = await sha256Hex(stitched);
  const narrationKey = await sha256HexOfJson({
    dialogHashes,
    totalDurationMs: schedule.totalDurationMs,
  });

  // ---- Compile (same gates as any plan; fails closed before recording) ----
  onPhase?.("compile");
  const { plan, warnings } = compileLessonScript({
    script,
    extracted,
    alignment: schedule.alignment,
    narration: {
      audioPath: `studio-tts://${narrationKey.slice(0, 16)}`,
      mimeType: profile.mimeType,
      durationMs: schedule.totalDurationMs,
    },
  });

  return {
    plan,
    narration: {
      blob: new Blob([stitched.slice() as BlobPart], { type: profile.mimeType }),
      bytes: stitched,
      durationMs: schedule.totalDurationMs,
      audioSha256,
    },
    dialogCount: dialogs.length,
    synthesizedCount,
    warnings: [...schedule.warnings, ...warnings],
  };
}
