import {
  BLOCK_CADENCE,
  FAST_EXPLAINER_CADENCE,
  LINE_BY_LINE_CADENCE,
  NATURAL_CADENCE,
  compileTypingChunks,
  createSeededRandom,
} from "../cadence";
import { parseStudioPlan, type StudioPlan, type StudioSlide, type StudioTargetRef } from "../plan";
import { dockTargetIdForRuntime } from "../targets";
import {
  markerTimeMs,
  sceneStartMs,
  type NarrationAlignment,
  buildCaptionTrack,
} from "./alignment";
import type { ExtractedNarration } from "./markers";
import { requireMarker } from "./markers";
import type { LessonScript, ScriptAction } from "./schema";

/**
 * The Director's compile step (docs/agent-lesson-production.md §4/§5): resolve
 * narration-relative anchors against the alignment, materialize seeded typing
 * cadence, derive the attention-cursor choreography (§7 — the cursor arrives
 * shortly before the action it announces), and emit an absolute-time
 * `StudioPlan`. The result re-enters `parseStudioPlan`, so every compiled plan
 * passes the same gates a hand-written one does; impossible overlaps fail here,
 * before any render.
 */

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

export interface CompileNarrationInput {
  audioPath: string;
  mimeType: string;
  durationMs: number;
}

export interface CompileInput {
  script: LessonScript;
  extracted: ExtractedNarration;
  alignment: NarrationAlignment;
  narration: CompileNarrationInput;
  /**
   * Script slides with every google deck ref already resolved to pinned
   * google-svg content (see script/googleSlides.ts). Required when the
   * script references a published deck; scripts with only inline slides
   * may omit it.
   */
  resolvedSlides?: StudioSlide[];
}

export interface CompileOutput {
  plan: StudioPlan;
  warnings: string[];
}

interface TimedAction {
  action: ScriptAction;
  sceneId: string;
  at: number;
}

const CADENCES = {
  natural: NATURAL_CADENCE,
  "fast-explainer": FAST_EXPLAINER_CADENCE,
  "line-by-line": LINE_BY_LINE_CADENCE,
  block: BLOCK_CADENCE,
} as const;

/** How long before an action its announcing cursor move should arrive. */
const CURSOR_ARRIVE_LEAD_MS = 200;
const CURSOR_TWEEN_BASE_MS = 500;
const CURSOR_TWEEN_JITTER_MS = 200;
const CURSOR_TWEEN_MIN_MS = 250;
/** Consecutive moves to the same target within this window are deduped. */
const CURSOR_DEDUPE_WINDOW_MS = 5_000;

function cursorTargetForAction(action: ScriptAction, script: LessonScript): StudioTargetRef | null {
  switch (action.type) {
    case "workspace.openFile":
      return { kind: "file", path: action.path };
    case "editor.type":
      return { kind: "editor" };
    case "runtime.run":
      // Schema validation guarantees run actions only exist for playground kinds.
      return script.runtime.kind === "none"
        ? null
        : { kind: "target-id", id: dockTargetIdForRuntime(script.runtime.kind) };
    default:
      return null;
  }
}

function targetsEqual(left: StudioTargetRef, right: StudioTargetRef): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Typing seeds are `build.seed + authored index` in scene order. Exported so
 * the dialog scheduler derives byte-identical chunk schedules to the ones this
 * compiler materializes — the two must never disagree about typing durations.
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

export function typingDurationOf(action: ScriptAction, seed: number): number {
  if (action.type !== "editor.type") {
    return 0;
  }
  return compileTypingChunks(action.text, CADENCES[action.cadence], seed).reduce(
    (total, chunk) => total + chunk.delayMs,
    0,
  );
}

export function compileLessonScript({
  script,
  extracted,
  alignment,
  narration,
  resolvedSlides,
}: CompileInput): CompileOutput {
  const warnings: string[] = [];

  // ---- Resolve anchors to absolute times ----------------------------------
  const authored: TimedAction[] = [];
  const pending: TimedAction[] = [];
  const resolvedAt = new Map<string, number>();

  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      const anchor = action.at;
      if ("mark" in anchor) {
        const marker = requireMarker(extracted, anchor.mark);
        const at = Math.max(0, markerTimeMs(alignment, marker) + anchor.offsetMs);
        authored.push({ action, sceneId: scene.id, at });
        resolvedAt.set(action.id, at);
      } else if ("scene" in anchor) {
        const at = Math.max(0, sceneStartMs(alignment, extracted, scene.id) + anchor.offsetMs);
        authored.push({ action, sceneId: scene.id, at });
        resolvedAt.set(action.id, at);
      } else {
        pending.push({ action, sceneId: scene.id, at: Number.NaN });
      }
    }
  }

  // afterAction chains: iterate until fixpoint; anything left is a cycle.
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i];
      const anchor = entry.action.at;
      if (!("afterAction" in anchor)) continue;
      const referenced = resolvedAt.get(anchor.afterAction);
      if (referenced === undefined) continue;
      entry.at = referenced;
      resolvedAt.set(entry.action.id, referenced);
      authored.push(entry);
      pending.splice(i, 1);
      progressed = true;
    }
  }
  if (pending.length > 0) {
    throw new CompileError(
      `Unresolvable afterAction chain (cycle?): ${pending.map((entry) => entry.action.id).join(", ")}`,
    );
  }

  authored.sort((left, right) => left.at - right.at);

  // ---- Typing seeds (stable per authored order) + typing end times ---------
  const typingSeed = typingSeedsOf(script);

  // ---- Attention cursor choreography (§7) ----------------------------------
  const random = createSeededRandom(script.build.seed ^ 0x5f3759df);
  const cursorMoves: { id: string; at: number; target: StudioTargetRef; durationMs: number }[] = [];
  let lastCursor: { target: StudioTargetRef; arriveMs: number } | null = null;
  let lastBusyUntilMs = 0;
  let prevAuthoredAtMs = 0;

  for (const entry of authored) {
    const target = cursorTargetForAction(entry.action, script);
    const typingMs = typingDurationOf(entry.action, typingSeed.get(entry.action.id)!);

    if (target) {
      const alreadyThere =
        lastCursor &&
        targetsEqual(lastCursor.target, target) &&
        entry.at - lastCursor.arriveMs < CURSOR_DEDUPE_WINDOW_MS;
      // A tween may not start while an earlier edit is still typing, and — the
      // Performer being strictly sequential — not before the preceding action's
      // planned start either, or it would push that action late.
      const floorMs = Math.max(lastBusyUntilMs, prevAuthoredAtMs);
      const windowMs = entry.at - CURSOR_ARRIVE_LEAD_MS - floorMs;
      if (!alreadyThere && windowMs >= CURSOR_TWEEN_MIN_MS) {
        let tweenMs = Math.round(CURSOR_TWEEN_BASE_MS + random() * CURSOR_TWEEN_JITTER_MS);
        let startMs = entry.at - CURSOR_ARRIVE_LEAD_MS - tweenMs;
        if (startMs < floorMs) {
          startMs = floorMs;
          tweenMs = Math.max(CURSOR_TWEEN_MIN_MS, entry.at - CURSOR_ARRIVE_LEAD_MS - startMs);
        }
        startMs = Math.max(0, startMs);
        cursorMoves.push({
          id: `cursor-${entry.action.id}`,
          at: startMs,
          target,
          durationMs: tweenMs,
        });
        lastCursor = { target, arriveMs: startMs + tweenMs };
      } else if (!alreadyThere) {
        warnings.push(
          `Skipped the cursor move announcing "${entry.action.id}" — only ${Math.max(0, Math.round(windowMs))}ms of clear timeline before it`,
        );
      }
    }

    prevAuthoredAtMs = entry.at;
    lastBusyUntilMs = Math.max(lastBusyUntilMs, entry.at + typingMs);
  }

  // ---- Assemble the plan ---------------------------------------------------
  const planActions = [
    ...cursorMoves.map((move) => ({
      id: move.id,
      type: "cursor.moveTo" as const,
      at: move.at,
      timeoutMs: 5_000,
      target: move.target,
      durationMs: move.durationMs,
    })),
    ...authored.map((entry) => {
      const { action, at } = entry;
      switch (action.type) {
        case "workspace.openFile":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            path: action.path,
          };
        case "editor.type":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            path: action.target.file,
            anchor: { after: action.target.after, occurrence: action.target.occurrence },
            chunks: compileTypingChunks(
              action.text,
              CADENCES[action.cadence],
              typingSeed.get(action.id)!,
            ),
          };
        case "runtime.run":
          return { id: action.id, type: action.type, at, timeoutMs: action.timeoutMs };
        case "slide.show":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            slideId: action.slideId,
            maximized: action.maximized,
          };
        case "slide.close":
          return { id: action.id, type: action.type, at, timeoutMs: action.timeoutMs };
        case "whiteboard.apply":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            open: action.open,
            maximized: action.maximized,
            upsertIds: action.upsertIds,
          };
        case "expect.output":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            contains: action.contains,
          };
        case "expect.file":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            path: action.path,
            contains: action.contains,
          };
      }
    }),
  ].sort((left, right) => left.at - right.at);

  const timingCheck = script.checks.find((check) => check.type === "timing.p95Ms");

  const candidate = {
    schemaVersion: 1,
    lesson: {
      slug: script.lesson.slug,
      title: script.lesson.title,
      locale: script.lesson.locale,
    },
    seed: script.build.seed,
    workspace: script.lesson.workspace,
    slides:
      resolvedSlides ??
      script.lesson.slides.map((slide) => {
        if (slide.contentType === "google") {
          throw new CompileError(
            `Slide "${slide.id}" references a published Google deck — resolve script slides ` +
              `before compiling (script/googleSlides.ts resolveScriptSlides)`,
          );
        }
        return slide;
      }),
    whiteboardAssets: script.lesson.whiteboardAssets,
    narration: {
      audioPath: narration.audioPath,
      mimeType: narration.mimeType,
      expectedDurationMs: narration.durationMs,
      captions: buildCaptionTrack(alignment, extracted, {
        id: "studio-narration",
        language: script.lesson.locale.split("-")[0] || "en",
        label: script.lesson.locale,
      }),
    },
    runtime: script.runtime,
    gates: timingCheck ? { timingP95MaxMs: timingCheck.max } : undefined,
    actions: planActions,
  };

  let plan: StudioPlan;
  try {
    plan = parseStudioPlan(candidate);
  } catch (error) {
    throw new CompileError(
      `Compiled plan failed validation — adjust the script's marks/offsets: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const lastAction = plan.actions[plan.actions.length - 1];
  const tailRoomMs = narration.durationMs - lastAction.at;
  if (tailRoomMs < 1_000) {
    warnings.push(
      `Only ${Math.round(tailRoomMs)}ms of narration remain after the last action — the recording ends with the audio`,
    );
  }

  return { plan, warnings };
}
