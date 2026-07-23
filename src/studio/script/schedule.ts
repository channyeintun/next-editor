import type { PronunciationLexicon } from "./lexicon";
import { estimateAlignment, type NarrationAlignment, AlignmentError } from "./alignment";
import type { NarrationDialog } from "./dialogs";
import type { ExtractedNarration } from "./markers";
import type { LessonScript } from "./schema";
import { selectDurationOf, typingDurationOf, typingSeedsOf } from "./compile";

/**
 * Joint dialog/action scheduling: instead of squeezing actions into one fixed
 * narration waveform, each per-dialog audio segment is placed on the timeline
 * so narration waits for the work it describes — a dialog never starts while
 * an earlier edit is still typing. Marker times become exact by construction
 * (markers are dialog starts), which removes both word-level alignment from
 * the timing path and most hand-tuned `offsetMs` authoring friction.
 *
 * The output combined alignment feeds `compileLessonScript` unchanged: marker
 * resolution there reads token starts, and this scheduler wrote those token
 * starts. Typing durations are derived through the same exported helpers the
 * compiler uses, so both stages see identical numbers.
 */

/** Silence before the first dialog (recording lead-in). */
const START_SILENCE_MS = 500;
/** Natural breath between consecutive dialogs. */
const MIN_GAP_MS = 350;
/** Clearance between an action finishing and narration resuming. */
const BUSY_PAD_MS = 250;
/** Silence after the last dialog before the recording auto-finalizes. */
const TAIL_SILENCE_MS = 1_500;
/** Inserted silence beyond this reads as dead air — surfaced as a warning. */
const SILENCE_WARN_MS = 2_500;
/** Estimated synthesizer padding inside each per-dialog segment. */
const DIALOG_LEAD_MS = 30;
const DIALOG_TAIL_MS = 100;

export interface ScheduledDialog {
  dialog: NarrationDialog;
  startMs: number;
  durationMs: number;
}

export interface DialogScheduleInput {
  script: LessonScript;
  extracted: ExtractedNarration;
  dialogs: NarrationDialog[];
  /** Measured audio duration of each dialog, index-aligned with `dialogs`. */
  durationsMs: number[];
  lexicon: PronunciationLexicon;
}

export interface DialogSchedule {
  timeline: ScheduledDialog[];
  /** Combined narration alignment with every token offset to its dialog's slot. */
  alignment: NarrationAlignment;
  /** Stitched narration length, including the tail silence. */
  totalDurationMs: number;
  warnings: string[];
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

export function scheduleDialogs({
  script,
  extracted,
  dialogs,
  durationsMs,
  lexicon,
}: DialogScheduleInput): DialogSchedule {
  if (dialogs.length === 0) {
    throw new ScheduleError("The narration has no dialogs to schedule");
  }
  if (durationsMs.length !== dialogs.length) {
    throw new ScheduleError(`Got ${durationsMs.length} durations for ${dialogs.length} dialogs`);
  }

  const warnings: string[] = [];
  const typingSeeds = typingSeedsOf(script);

  // Marker name → the dialog whose start it anchors ("end" markers → null).
  const dialogStartByToken = new Map<number, number>();
  dialogs.forEach((dialog, index) => dialogStartByToken.set(dialog.firstTokenIndex, index));
  const markerDialogIndex = new Map<string, number | null>();
  for (const [name, marker] of extracted.markers) {
    markerDialogIndex.set(name, dialogStartByToken.get(marker.beforeTokenIndex) ?? null);
  }

  // Actions anchored to each dialog's opening mark (or their scene's start),
  // grouped so their busy time can push the *next* dialog.
  const actionsByDialog = new Map<
    number,
    { offsetMs: number; busyMs: number; actionId: string }[]
  >();
  const sceneFirstDialog = new Map<string, number>();
  dialogs.forEach((dialog, index) => {
    if (!sceneFirstDialog.has(dialog.sceneId)) {
      sceneFirstDialog.set(dialog.sceneId, index);
    }
  });

  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      const anchor = action.at;
      let dialogIndex: number | null | undefined;
      let offsetMs = 0;
      if ("mark" in anchor) {
        dialogIndex = markerDialogIndex.get(anchor.mark);
        offsetMs = anchor.offsetMs;
        if (dialogIndex === undefined) {
          // Unknown marker — the compiler reports this with full context.
          continue;
        }
      } else if ("scene" in anchor) {
        dialogIndex = sceneFirstDialog.get(scene.id) ?? null;
        offsetMs = anchor.offsetMs;
      } else {
        continue; // afterAction chains never push narration.
      }
      if (dialogIndex === null) {
        continue; // End-of-narration marker: nothing left to push.
      }
      const entries = actionsByDialog.get(dialogIndex) ?? [];
      const seed = typingSeeds.get(action.id) ?? script.build.seed;
      entries.push({
        offsetMs,
        busyMs: typingDurationOf(action, seed) + selectDurationOf(action, seed),
        actionId: action.id,
      });
      actionsByDialog.set(dialogIndex, entries);
    }
  }

  // ---- Place dialogs -------------------------------------------------------
  const timeline: ScheduledDialog[] = [];
  const combinedTokens: NarrationAlignment["tokens"] = [];
  let busyUntilMs = 0;
  let previousEndMs = 0;

  for (let i = 0; i < dialogs.length; i++) {
    const dialog = dialogs[i];
    const durationMs = durationsMs[i];
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new ScheduleError(`Dialog "${dialog.id}" has invalid duration ${durationMs}ms`);
    }

    const naturalStartMs = i === 0 ? START_SILENCE_MS : previousEndMs + MIN_GAP_MS;
    const startMs = Math.max(naturalStartMs, Math.ceil(busyUntilMs + BUSY_PAD_MS));
    const insertedSilenceMs = startMs - naturalStartMs;
    if (insertedSilenceMs > SILENCE_WARN_MS) {
      warnings.push(
        `${Math.round(insertedSilenceMs)}ms of silence inserted before dialog "${dialog.id}" — add narration there or shorten the preceding actions`,
      );
    }

    let inner: NarrationAlignment;
    try {
      inner = estimateAlignment(dialog.tokens, durationMs, lexicon, {
        leadMs: DIALOG_LEAD_MS,
        tailMs: DIALOG_TAIL_MS,
      });
    } catch (error) {
      throw new ScheduleError(
        `Dialog "${dialog.id}" could not be aligned: ${error instanceof AlignmentError ? error.message : String(error)}`,
      );
    }
    for (const token of inner.tokens) {
      combinedTokens.push({
        text: token.text,
        startMs: token.startMs + startMs,
        endMs: token.endMs + startMs,
      });
    }

    timeline.push({ dialog, startMs, durationMs });
    previousEndMs = startMs + durationMs;

    // This dialog's anchored actions may outlast it; the next dialog waits.
    const markerTimeMs = combinedTokens[dialog.firstTokenIndex].startMs;
    for (const entry of actionsByDialog.get(i) ?? []) {
      const actionAt = Math.max(0, markerTimeMs + entry.offsetMs);
      busyUntilMs = Math.max(busyUntilMs, actionAt + entry.busyMs);
    }
    busyUntilMs = Math.max(busyUntilMs, 0);
  }

  const totalDurationMs = Math.ceil(Math.max(previousEndMs, busyUntilMs) + TAIL_SILENCE_MS);
  const alignment: NarrationAlignment = { tokens: combinedTokens, durationMs: totalDurationMs };

  return { timeline, alignment, totalDurationMs, warnings };
}
