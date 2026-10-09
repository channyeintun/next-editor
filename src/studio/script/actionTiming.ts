import {
  BLOCK_CADENCE,
  FAST_EXPLAINER_CADENCE,
  LINE_BY_LINE_CADENCE,
  NATURAL_CADENCE,
  compileTypingChunks,
  createSeededRandom,
} from "../cadence";
import { POINTER_AIM_MAX_MS } from "../../core/src/utils/pointerMotion";
import { planActionBusyMs, type StudioActionTiming, type TypingChunk } from "../plan";
import type { LessonScript, ScriptAction } from "./schema";

/**
 * How long each script action keeps the sequential Performer busy, before
 * the plan exists. The compiler (compile.ts) places actions and materializes
 * their chunks/durations with these helpers, and the dialog scheduler
 * (schedule.ts) reserves narration time with the same numbers, so the two
 * stages can never disagree about an action's busy window. The busy rule
 * itself is plan.ts's planActionBusyMs, read over those materialized fields —
 * the same rule the plan's overlap gate and the Performer's deadline apply.
 */

const CADENCES = {
  natural: NATURAL_CADENCE,
  "fast-explainer": FAST_EXPLAINER_CADENCE,
  "line-by-line": LINE_BY_LINE_CADENCE,
  block: BLOCK_CADENCE,
} as const;

// Drag-select timing: a base grab plus per-character travel, seed-jittered. The
// driver spends this whole budget sweeping a button-held pointer across the
// span, so it is tuned to the reference human recording (human-interactions.ne),
// whose drag-selects ran ~333–1116ms (median ~750ms).
const SELECT_DRAG_BASE_MS = 460;
const SELECT_DRAG_PER_CHAR_MS = 11;
/** Only the first ~80 chars of the span add travel time — long blocks don't crawl. */
const SELECT_DRAG_CHAR_CAP = 80;
const SELECT_DRAG_JITTER_MS = 200;
const SELECT_DRAG_MAX_MS = 1_200;

/**
 * Seeds are `build.seed + authored index` in scene order, so the scheduler and
 * the compiler derive byte-identical chunk schedules and select jitter.
 */
export function typingSeedsOf(script: LessonScript): Map<string, number> {
  const seeds = new Map<string, number>();
  let actionIndex = 0;
  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      seeds.set(action.id, script.build.seed + actionIndex);
      actionIndex += 1;
    }
  }
  return seeds;
}

/** The seeded typing chunks an `editor.type` performs. */
export function typingChunksOf(
  action: Extract<ScriptAction, { type: "editor.type" }>,
  seed: number,
): TypingChunk[] {
  return compileTypingChunks(action.text, CADENCES[action.cadence], seed);
}

/**
 * Materialized drag-glide duration for an `editor.select` (0 for any other
 * action). Longer spans travel a little longer, capped so a whole-block
 * selection never crawls; the seed adds reproducible jitter so plans stay
 * byte-identical between the scheduler and the compiler.
 */
export function selectDurationOf(action: ScriptAction, seed: number): number {
  if (action.type !== "editor.select") {
    return 0;
  }
  const chars = Math.min(action.target.text.length, SELECT_DRAG_CHAR_CAP);
  const base = SELECT_DRAG_BASE_MS + chars * SELECT_DRAG_PER_CHAR_MS;
  const jitter = Math.round(createSeededRandom(seed)() * SELECT_DRAG_JITTER_MS);
  return Math.min(SELECT_DRAG_MAX_MS, Math.round(base + jitter));
}

/**
 * Travel budget for a `console.point` (0 for any other action): the longest
 * human approach, so the move from wherever the pointer rests — the Run button,
 * the line above — never has to rush. A hop to the next line takes far less.
 */
export function pointDurationOf(action: ScriptAction): number {
  return action.type === "console.point" ? POINTER_AIM_MAX_MS : 0;
}

/**
 * A script action's timing fields as its compiled plan action carries them: the
 * seeded typing chunks, select drag and point travel the compiler materializes.
 * A whiteboard apply's asset count and drawMs pass through as authored.
 */
function actionTimingOf(action: ScriptAction, seed: number): StudioActionTiming {
  switch (action.type) {
    case "editor.type":
      return { type: action.type, chunks: typingChunksOf(action, seed) };
    case "editor.select":
      return { type: action.type, durationMs: selectDurationOf(action, seed) };
    case "console.point":
      return { type: action.type, durationMs: pointDurationOf(action) };
    default:
      return action;
  }
}

/**
 * Time a timed action keeps the Performer busy: typing chunks, a select drag,
 * point travel, or the frames of a drawn whiteboard apply. The Performer runs
 * plan order sequentially, so anything not modeled here pushes every later
 * action late.
 */
export function actionBusyMs(action: ScriptAction, seed: number): number {
  return planActionBusyMs(actionTimingOf(action, seed));
}

/** {@link actionBusyMs} for every action of the script, by action id. */
export function actionBusyMsById(script: LessonScript): Map<string, number> {
  const busyById = new Map<string, number>();
  const seeds = typingSeedsOf(script);
  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      busyById.set(action.id, actionBusyMs(action, seeds.get(action.id)!));
    }
  }
  return busyById;
}
