import type { StudioPlan, StudioSlide } from "../plan";
import { compileLessonScript } from "./compile";
import { splitIntoDialogs, type NarrationDialog } from "./dialogs";
import { narrationLexiconFor, speechTextOf, type PronunciationLexicon } from "./lexicon";
import { extractScriptNarration, type ExtractedNarration } from "./markers";
import { scheduleDialogs, type DialogSchedule } from "./schedule";
import type { LessonScript } from "./schema";

/**
 * Compiling a LessonScript without synthesizing its narration — what the
 * registry test and the offline lesson checks (scripts/studio-compile-check.ts,
 * scripts/studio-verify-lesson.ts) do. Each dialog gets an estimated length in
 * place of its measured take, and published-deck slides compile against an
 * empty SVG in place of the fetched page. Everything else — dialog split,
 * lexicon, scheduling, marker resolution, seeded typing chunks and the plan's
 * own validation — is the in-page Director's code, so the plan has the action
 * order and gates a render would have, timed by the estimate.
 */

/** The narration as the Director splits and speaks it. */
export interface ScriptNarration {
  extracted: ExtractedNarration;
  dialogs: NarrationDialog[];
  lexicon: PronunciationLexicon;
  /** What the TTS provider is sent for each dialog, index-aligned with `dialogs`. */
  speechTexts: string[];
}

export function narrationOf(script: LessonScript): ScriptNarration {
  const extracted = extractScriptNarration(script);
  const dialogs = splitIntoDialogs(extracted);
  const lexicon = narrationLexiconFor(script.lesson.locale);
  const speechTexts = dialogs.map((dialog) => speechTextOf(dialog.tokens, lexicon));
  return { extracted, dialogs, lexicon, speechTexts };
}

/** Estimated spoken length of one dialog, in milliseconds. */
export type DialogLengthEstimate = (dialog: NarrationDialog, speechText: string) => number;

/**
 * 400 ms plus 320 ms per whitespace-separated token. Close enough for English;
 * far too short for Burmese, which puts few spaces between words — estimate
 * that with {@link estimateByCharacters}.
 */
export const estimateByTokens: DialogLengthEstimate = (dialog) => 400 + dialog.tokens.length * 320;

/** 400 ms plus `msPerChar` for every character of the speech text. */
export function estimateByCharacters(msPerChar: number): DialogLengthEstimate {
  return (_dialog, speechText) => Math.round(400 + speechText.length * msPerChar);
}

export interface EstimatedCompile {
  narration: ScriptNarration;
  schedule: DialogSchedule;
  plan: StudioPlan;
  /** The scheduler's warnings, then the compiler's. */
  warnings: string[];
}

/** Throws whatever scheduling or compiling throws, exactly as a render would. */
export function compileWithEstimatedNarration(
  script: LessonScript,
  estimate: DialogLengthEstimate,
  narration: ScriptNarration = narrationOf(script),
): EstimatedCompile {
  const { extracted, dialogs, lexicon, speechTexts } = narration;
  const schedule = scheduleDialogs({
    script,
    extracted,
    dialogs,
    durationsMs: dialogs.map((dialog, index) => estimate(dialog, speechTexts[index])),
    lexicon,
  });
  const resolvedSlides: StudioSlide[] = script.lesson.slides.map((slide) =>
    slide.contentType === "google"
      ? {
          id: slide.id,
          contentType: "google-svg",
          content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
          name: slide.name,
          sourceUrl: slide.deckUrl,
        }
      : slide,
  );
  const { plan, warnings } = compileLessonScript({
    script,
    extracted,
    alignment: schedule.alignment,
    narration: {
      audioPath: "studio-tts://estimated",
      mimeType: "audio/wav",
      durationMs: schedule.totalDurationMs,
    },
    resolvedSlides,
  });
  return { narration, schedule, plan, warnings: [...schedule.warnings, ...warnings] };
}
