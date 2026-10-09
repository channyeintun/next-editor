import type { z } from "zod";
import {
  isTimelineIssue,
  parseStudioPlan,
  StudioPlanError,
  type StudioPlan,
  type StudioSlide,
  type studioPlanActionSchema,
} from "../plan";
import {
  markerTimeMs,
  sceneStartMs,
  type NarrationAlignment,
  buildCaptionTrack,
} from "./alignment";
import {
  actionBusyMsById,
  pointDurationOf,
  selectDurationOf,
  typingChunksOf,
  typingSeedsOf,
} from "./actionTiming";
import { CompileError } from "./errors";
import type { ExtractedNarration } from "./markers";
import { requireMarker } from "./markers";
import { planPointerChoreography } from "./pointerChoreography";
import type { LessonScript, ScriptAction } from "./schema";

export { CompileError };

/**
 * The Director's compile step (docs/agent-lesson-production.md §4/§5): resolve
 * narration-relative anchors against the alignment, materialize seeded typing
 * cadence, derive the pointer clicks (§7 — each released just before the
 * action it performs), and emit an absolute-time
 * `StudioPlan`. The result re-enters `parseStudioPlan`, so every compiled plan
 * passes the same gates a hand-written one does; impossible overlaps fail here,
 * before any render.
 */

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

/**
 * A plan action as `parseStudioPlan` takes it, before its defaults apply. Typing
 * the assembled list with it makes a misspelt or missing field a type error
 * instead of a silent plan default.
 */
type StudioPlanActionInput = z.input<typeof studioPlanActionSchema>;

interface TimedAction {
  action: ScriptAction;
  at: number;
  /**
   * Position in scene/action authoring order. Two actions can resolve to the same
   * absolute time — most often a group anchored `afterAction` to one predecessor,
   * since runtime/preview/expect actions have zero modelled busy time — and the
   * Performer executes plan order strictly sequentially. This is the tiebreak that
   * makes "same instant" fall back to the order the author wrote.
   */
  authoredIndex: number;
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
  let pending: TimedAction[] = [];
  const resolvedEndAt = new Map<string, number>();
  const typingSeed = typingSeedsOf(script);
  const busyById = actionBusyMsById(script);
  // dependent id → predecessor id, for every `afterAction`-anchored action. Emitted
  // into the plan so the timing gate measures a dependent's drift relative to its
  // predecessor's acknowledgement rather than a placeholder planned time (STUDIO-03).
  const dependencies = new Map<string, string>();

  let authoredIndex = 0;
  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      const anchor = action.at;
      const entry = { action, at: Number.NaN, authoredIndex };
      authoredIndex += 1;
      if ("mark" in anchor) {
        const marker = requireMarker(extracted, anchor.mark);
        entry.at = Math.max(0, markerTimeMs(alignment, marker) + anchor.offsetMs);
        authored.push(entry);
        resolvedEndAt.set(action.id, entry.at + busyById.get(action.id)!);
      } else if ("scene" in anchor) {
        entry.at = Math.max(0, sceneStartMs(alignment, extracted, scene.id) + anchor.offsetMs);
        authored.push(entry);
        resolvedEndAt.set(action.id, entry.at + busyById.get(action.id)!);
      } else {
        pending.push(entry);
      }
    }
  }

  // afterAction chains: iterate until fixpoint; anything left is a cycle. The pass
  // runs forward through `pending` so a chain resolves in one sweep and a group
  // sharing one predecessor is appended in authored order rather than reversed.
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    const stillPending: TimedAction[] = [];
    for (const entry of pending) {
      const anchor = entry.action.at;
      if (!("afterAction" in anchor)) {
        stillPending.push(entry);
        continue;
      }
      const referencedEnd = resolvedEndAt.get(anchor.afterAction);
      if (referencedEnd === undefined) {
        stillPending.push(entry);
        continue;
      }
      // A modeled edit (typing/select) has a deterministic busy duration, so a
      // dependent can carry its real planned start after that duration. Runtime
      // and preview waits remain zero-modelled and therefore keep the predecessor
      // start as a placeholder; their timing is measured from the actual ack.
      entry.at = referencedEnd;
      resolvedEndAt.set(entry.action.id, referencedEnd + busyById.get(entry.action.id)!);
      dependencies.set(entry.action.id, anchor.afterAction);
      authored.push(entry);
      progressed = true;
    }
    pending = stillPending;
  }
  if (pending.length > 0) {
    throw new CompileError(
      `Unresolvable afterAction chain (cycle?): ${pending.map((entry) => entry.action.id).join(", ")}`,
    );
  }

  // Ties fall back to authoring order: zero-busy dependents of one predecessor all
  // land on the same instant, and the Performer runs plan order sequentially, so
  // without this the author's sequence would silently invert.
  authored.sort((left, right) => left.at - right.at || left.authoredIndex - right.authoredIndex);

  // ---- Pointer choreography (§7) -------------------------------------------
  const {
    cursorMoves,
    dockOpenings,
    warnings: pointerWarnings,
  } = planPointerChoreography({ script, authored, busyMs: busyById });
  warnings.push(...pointerWarnings);

  // ---- Assemble the plan ---------------------------------------------------
  const planActions: StudioPlanActionInput[] = [
    ...dockOpenings.map((opening) => ({
      id: opening.id,
      type: "runtime.expandDock" as const,
      at: opening.at,
      timeoutMs: 2_000,
    })),
    ...cursorMoves.map((move) => ({
      id: move.id,
      type: "cursor.moveTo" as const,
      at: move.at,
      timeoutMs: 5_000,
      target: move.target,
      durationMs: move.durationMs,
      press: true,
    })),
    ...authored.map(({ action, at }): StudioPlanActionInput => {
      switch (action.type) {
        case "editor.type":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            path: action.target.file,
            anchor: { after: action.target.after, occurrence: action.target.occurrence },
            chunks: typingChunksOf(action, typingSeed.get(action.id)!),
          };
        case "editor.select":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            path: action.target.file,
            selection: { text: action.target.text, occurrence: action.target.occurrence },
            durationMs: selectDurationOf(action, typingSeed.get(action.id)!),
          };
        case "console.point":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            target: action.target,
            durationMs: pointDurationOf(action),
          };
        default: {
          // Every other action carries its authored fields into the plan as
          // they are; only the narration anchor becomes an absolute time.
          const { at: _anchor, ...fields } = action;
          return { ...fields, at };
        }
      }
    }),
  ].sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    // Tie-break so a real action runs before a pointer move scheduled at the
    // same instant. A move is always planned strictly before the action it
    // performs (`at − lead − duration`), so any tie is with a *later* action's
    // move; letting that ~1s move go first would block the tied real action,
    // since the Performer executes strictly sequentially.
    const leftCursor = left.type === "cursor.moveTo" ? 1 : 0;
    const rightCursor = right.type === "cursor.moveTo" ? 1 : 0;
    return leftCursor - rightCursor;
  });

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
    chapters: script.scenes.flatMap((scene, index) =>
      scene.chapter
        ? [
            {
              // The opening scene's chapter covers the quiet lead-in before its
              // first word too; starting it at that word left the player with no
              // current chapter for the recording's first seconds.
              time: index === 0 ? 0 : sceneStartMs(alignment, extracted, scene.id),
              title: scene.chapter,
            },
          ]
        : [],
    ),
    runtime: script.runtime,
    gates: timingCheck ? { timingP95MaxMs: timingCheck.max } : undefined,
    dependencies: dependencies.size > 0 ? Object.fromEntries(dependencies) : undefined,
    actions: planActions,
  };

  let plan: StudioPlan;
  try {
    plan = parseStudioPlan(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Marks and offsets only fix a timeline that does not fit. Any other
    // failure is a rule the script schema let through, and moving marks
    // would not help.
    const timeline = error instanceof StudioPlanError && error.issues.some(isTimelineIssue);
    throw new CompileError(
      timeline
        ? `Compiled plan failed validation — adjust the script's marks/offsets: ${message}`
        : `Compiled plan failed validation: ${message}`,
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
