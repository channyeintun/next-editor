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

/**
 * Quiet handles around the authored performance. The opening gives the
 * recorder/screen capture time to settle before the voice starts; the closing
 * keeps the final word or action from running into auto-finalize.
 */
export const RECORDING_BUFFER_MS = 2_000;
/** Natural breath between consecutive dialogs. */
const MIN_GAP_MS = 350;
/** Clearance between an action finishing and narration resuming. */
const BUSY_PAD_MS = 250;
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

  // Resolve every action's anchoring dialog, following `afterAction` to its
  // predecessor's root anchor — the same dependency chain the compiler resolves.
  // Modeled busy time is accumulated later, once the root marker's absolute time
  // is known, so two chained edits reserve the sum of their durations instead of
  // both pretending to begin at the root mark (STUDIO-03).
  const resolvedDialog = new Map<string, number | null | undefined>();
  const directOffset = new Map<string, number>();
  const busyById = new Map<string, number>();
  const predecessorById = new Map<string, string>();
  const afterActionOf = new Map<string, string>();
  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      const seed = typingSeeds.get(action.id) ?? script.build.seed;
      busyById.set(action.id, typingDurationOf(action, seed) + selectDurationOf(action, seed));
      const anchor = action.at;
      if ("mark" in anchor) {
        resolvedDialog.set(action.id, markerDialogIndex.get(anchor.mark));
        directOffset.set(action.id, anchor.offsetMs);
      } else if ("scene" in anchor) {
        resolvedDialog.set(action.id, sceneFirstDialog.get(scene.id) ?? null);
        directOffset.set(action.id, anchor.offsetMs);
      } else {
        predecessorById.set(action.id, anchor.afterAction);
        afterActionOf.set(action.id, anchor.afterAction);
      }
    }
  }
  // Fixpoint: an afterAction action inherits its predecessor's resolved anchor.
  // Leftovers are cycles/unknown references, which the compiler reports with full
  // context; here they simply contribute no narration push.
  let anchorProgressed = true;
  while (afterActionOf.size > 0 && anchorProgressed) {
    anchorProgressed = false;
    // Deleting the just-resolved (current) entry mid-iteration is safe for a Map.
    for (const [id, predecessorId] of afterActionOf) {
      if (!resolvedDialog.has(predecessorId)) continue;
      resolvedDialog.set(id, resolvedDialog.get(predecessorId));
      afterActionOf.delete(id);
      anchorProgressed = true;
    }
  }

  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      const dialogIndex = resolvedDialog.get(action.id);
      // Unknown marker or unresolved afterAction — the compiler reports it.
      if (dialogIndex === undefined || dialogIndex === null) {
        continue;
      }
      const entries = actionsByDialog.get(dialogIndex) ?? [];
      entries.push({
        offsetMs: directOffset.get(action.id) ?? 0,
        busyMs: busyById.get(action.id) ?? 0,
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

    const naturalStartMs = i === 0 ? RECORDING_BUFFER_MS : previousEndMs + MIN_GAP_MS;
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
    const pendingActionIds = new Set((actionsByDialog.get(i) ?? []).map((entry) => entry.actionId));
    const entriesById = new Map(
      (actionsByDialog.get(i) ?? []).map((entry) => [entry.actionId, entry]),
    );
    const modeledEndById = new Map<string, number>();
    let actionProgressed = true;
    while (pendingActionIds.size > 0 && actionProgressed) {
      actionProgressed = false;
      for (const actionId of pendingActionIds) {
        const entry = entriesById.get(actionId)!;
        let actionAt: number | undefined;
        if (directOffset.has(actionId)) {
          actionAt = Math.max(0, markerTimeMs + entry.offsetMs);
        } else {
          const predecessorId = predecessorById.get(actionId);
          if (predecessorId !== undefined) {
            actionAt = modeledEndById.get(predecessorId);
          }
        }
        if (actionAt === undefined) continue;
        const actionEnd = actionAt + entry.busyMs;
        modeledEndById.set(actionId, actionEnd);
        busyUntilMs = Math.max(busyUntilMs, actionEnd);
        pendingActionIds.delete(actionId);
        actionProgressed = true;
      }
    }
    busyUntilMs = Math.max(busyUntilMs, 0);
  }

  const totalDurationMs = Math.ceil(Math.max(previousEndMs, busyUntilMs) + RECORDING_BUFFER_MS);
  const alignment: NarrationAlignment = { tokens: combinedTokens, durationMs: totalDurationMs };

  return { timeline, alignment, totalDurationMs, warnings };
}
