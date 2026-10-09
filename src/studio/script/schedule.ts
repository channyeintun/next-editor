import type { PronunciationLexicon } from "./lexicon";
import { estimateAlignment, type NarrationAlignment, AlignmentError } from "./alignment";
import type { NarrationDialog } from "./dialogs";
import type { ExtractedNarration } from "./markers";
import type { LessonScript } from "./schema";
import { actionBusyMsById } from "./actionTiming";

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
 * starts. Busy time comes from actionTiming.ts, the helpers the compiler
 * uses, so both stages see identical numbers.
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

  // Marker name → the dialog whose start it anchors. Every marker starts a
  // dialog except one after the narration's last word — a scene-final marker
  // elsewhere starts the next scene's first dialog. That one anchors the last
  // dialog's end instead, where the compiler resolves it too (the last token's
  // end), so its actions still reserve narration time.
  const dialogStartByToken = new Map<number, number>();
  dialogs.forEach((dialog, index) => dialogStartByToken.set(dialog.firstTokenIndex, index));
  const markerDialogIndex = new Map<string, number | null>();
  const endMarkers = new Set<string>();
  for (const [name, marker] of extracted.markers) {
    if (marker.beforeTokenIndex >= extracted.tokens.length) {
      markerDialogIndex.set(name, dialogs.length - 1);
      endMarkers.add(name);
    } else {
      markerDialogIndex.set(name, dialogStartByToken.get(marker.beforeTokenIndex) ?? null);
    }
  }

  // Actions anchored to each dialog's opening mark (or their scene's start, or
  // the narration's end), grouped so their busy time can push the *next*
  // dialog and the recording's tail.
  const actionsByDialog = new Map<
    number,
    { offsetMs: number; busyMs: number; actionId: string; atEnd: boolean }[]
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
  const endAnchoredIds = new Set<string>();
  const busyById = actionBusyMsById(script);
  const predecessorById = new Map<string, string>();
  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      const anchor = action.at;
      if ("mark" in anchor) {
        resolvedDialog.set(action.id, markerDialogIndex.get(anchor.mark));
        directOffset.set(action.id, anchor.offsetMs);
        if (endMarkers.has(anchor.mark)) endAnchoredIds.add(action.id);
      } else if ("scene" in anchor) {
        resolvedDialog.set(action.id, sceneFirstDialog.get(scene.id) ?? null);
        directOffset.set(action.id, anchor.offsetMs);
      } else {
        predecessorById.set(action.id, anchor.afterAction);
      }
    }
  }
  // Fixpoint: an afterAction action inherits its predecessor's resolved anchor.
  // Leftovers are cycles/unknown references, which the script schema rejects
  // when the script parses; here they simply contribute no narration push.
  const unresolved = new Map(predecessorById);
  let anchorProgressed = true;
  while (unresolved.size > 0 && anchorProgressed) {
    anchorProgressed = false;
    // Deleting the just-resolved (current) entry mid-iteration is safe for a Map.
    for (const [id, predecessorId] of unresolved) {
      if (!resolvedDialog.has(predecessorId)) continue;
      resolvedDialog.set(id, resolvedDialog.get(predecessorId));
      unresolved.delete(id);
      anchorProgressed = true;
    }
  }

  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      const dialogIndex = resolvedDialog.get(action.id);
      // Unknown marker or unresolved afterAction — the script schema rejects both.
      if (dialogIndex === undefined || dialogIndex === null) {
        continue;
      }
      const entries = actionsByDialog.get(dialogIndex) ?? [];
      entries.push({
        offsetMs: directOffset.get(action.id) ?? 0,
        busyMs: busyById.get(action.id) ?? 0,
        actionId: action.id,
        atEnd: endAnchoredIds.has(action.id),
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

    // An action anchored to this dialog with a negative offset starts *before* its
    // mark, and its mark sits only DIALOG_LEAD_MS into the dialog. Clearing just
    // BUSY_PAD_MS therefore lets such an action begin while the previous edit is
    // still typing — an overlap the plan gate rejects, after the whole narration
    // has been synthesized. Reserve whatever the pull-back needs beyond the lead.
    // An action anchored at the narration's end pulls back from the dialog's last
    // word, not its first, so it does not move the dialog's start.
    const pullBackMs = -Math.min(
      0,
      ...(actionsByDialog.get(i) ?? [])
        .filter((entry) => !entry.atEnd)
        .map((entry) => entry.offsetMs),
    );
    const naturalStartMs = i === 0 ? RECORDING_BUFFER_MS : previousEndMs + MIN_GAP_MS;
    const startMs = Math.max(
      naturalStartMs,
      Math.ceil(busyUntilMs + BUSY_PAD_MS + Math.max(0, pullBackMs - DIALOG_LEAD_MS)),
    );
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
    // Only the last dialog holds end-anchored actions, and by then this is the
    // narration's last word.
    const endMarkerTimeMs = combinedTokens[combinedTokens.length - 1].endMs;
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
          actionAt = Math.max(0, (entry.atEnd ? endMarkerTimeMs : markerTimeMs) + entry.offsetMs);
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
  }

  const totalDurationMs = Math.ceil(Math.max(previousEndMs, busyUntilMs) + RECORDING_BUFFER_MS);
  const alignment: NarrationAlignment = { tokens: combinedTokens, durationMs: totalDurationMs };

  return { timeline, alignment, totalDurationMs, warnings };
}
