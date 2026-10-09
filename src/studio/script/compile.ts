import {
  POINTER_AIM_MAX_MS,
  POINTER_PRESS_MS,
  POINTER_SETTLE_MS,
} from "../../core/src/utils/pointerMotion";
import {
  isPlaygroundRuntimeKind,
  parseStudioPlan,
  runtimeDockStartsCollapsed,
  type StudioPlan,
  type StudioSlide,
  type StudioTargetRef,
} from "../plan";
import { STUDIO_DOCK_TOGGLE_TARGET_ID } from "../targets";
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
import type { ExtractedNarration } from "./markers";
import { requireMarker } from "./markers";
import type { LessonScript, ScriptAction } from "./schema";

/**
 * The Director's compile step (docs/agent-lesson-production.md §4/§5): resolve
 * narration-relative anchors against the alignment, materialize seeded typing
 * cadence, derive the pointer clicks (§7 — each released just before the
 * action it performs), and emit an absolute-time
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
  /**
   * Position in scene/action authoring order. Two actions can resolve to the same
   * absolute time — most often a group anchored `afterAction` to one predecessor,
   * since runtime/preview/expect actions have zero modelled busy time — and the
   * Performer executes plan order strictly sequentially. This is the tiebreak that
   * makes "same instant" fall back to the order the author wrote.
   */
  authoredIndex: number;
}

/** How long before an action the click that performs it releases. */
const CURSOR_CLICK_LEAD_MS = 80;
// A click move's budget: the travel plus the rest on the control and the
// press. The travel budget is the longest human approach — the driver times
// the real move from its distance and starts later when it needs less, so the
// click still lands when planned — and shrinks to fit a tight timeline down to
// one quick stroke (a single recorded hand movement took ~150ms at any range).
const CURSOR_CLICK_MS = POINTER_SETTLE_MS + POINTER_PRESS_MS;
const CURSOR_TRAVEL_MAX_MS = POINTER_AIM_MAX_MS;
const CURSOR_TRAVEL_MIN_MS = 150;
/** Clear time an action needs before it for its click: lead, shortest travel, rest, press. */
const CURSOR_CLICK_NEEDS_MS = CURSOR_CLICK_LEAD_MS + CURSOR_TRAVEL_MIN_MS + CURSOR_CLICK_MS;
/** Window (before the run's click lead) for chevron click → dock opens → Run press. */
const CURSOR_OPEN_AND_RUN_NEEDS_MS =
  2 * (CURSOR_CLICK_MS + CURSOR_TRAVEL_MIN_MS) + CURSOR_CLICK_LEAD_MS;
/**
 * The plan schema's timeline failures: a busy action running into the next
 * one, or the last action starting after the narration ends. It mirrors the
 * wording of the two timeline issues in plan.ts's superRefine (the overlap
 * and "starts after the narration ends" messages); reword those and this must
 * follow, or the marks/offsets advice silently disappears.
 */
const PLAN_TIMING_ERROR =
  /(?:Typing|Selection|Pointing|Whiteboard drawing) action "[^"]*" \([\d.]+ms\) overlaps|starts after the narration ends/;

/** What is on screen for the pointer to click, as the lesson's actions change it. */
interface PointerUiState {
  activeFile: string;
  dockOpen: boolean;
}

/**
 * The control a hand clicks to perform an action, if it has one on screen.
 * Editing gets no pointer move: a select performs its own drag across the
 * range, and typing is a keyboard action (the pointer hides while it runs) —
 * a glide to the editor before either read as random mouse movement.
 */
function clickTargetForAction(
  action: ScriptAction,
  script: LessonScript,
  ui: PointerUiState,
): StudioTargetRef | null {
  switch (action.type) {
    case "workspace.openFile":
      // Nothing to click when the lesson opens with the file explorer shut —
      // the row is not rendered, and the render fails closed on a target it
      // cannot find — or when the file is already the one showing: a trip to
      // its row would click nothing. The action itself is unaffected either
      // way; it switches files through the workspace store, not the tree.
      return script.lesson.workspace.sidebarStartsCollapsed || action.path === ui.activeFile
        ? null
        : { kind: "file", path: action.path };
    case "runtime.run":
      // Schema validation guarantees run actions only exist for playground
      // kinds. The Run button is only rendered while the dock is open; a shut
      // dock is opened by its chevron, and the run opens it anyway.
      if (!isPlaygroundRuntimeKind(script.runtime.kind)) return null;
      return ui.dockOpen
        ? { kind: "run-button" }
        : { kind: "target-id", id: STUDIO_DOCK_TOGGLE_TARGET_ID };
    case "runtime.collapseDock":
      return isPlaygroundRuntimeKind(script.runtime.kind) && ui.dockOpen
        ? { kind: "target-id", id: STUDIO_DOCK_TOGGLE_TARGET_ID }
        : null;
    case "preview.click":
    case "preview.input":
      return { kind: "preview", testId: action.target.value };
    default:
      return null;
  }
}

function advancePointerUiState(action: ScriptAction, ui: PointerUiState): void {
  if (action.type === "workspace.openFile") {
    ui.activeFile = action.path;
  } else if (action.type === "runtime.run") {
    ui.dockOpen = true;
  } else if (action.type === "runtime.collapseDock") {
    ui.dockOpen = false;
  }
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
      const entry = { action, sceneId: scene.id, at: Number.NaN, authoredIndex };
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
  // Each pointer move ends in a click on the real control an action belongs to
  // — a file row, the Run button, the dock's chevron, a preview element —
  // released just before the action fires, the way a hand operates the UI.
  const cursorMoves: { id: string; at: number; target: StudioTargetRef; durationMs: number }[] = [];
  // Dock openings between a chevron click and the Run press after it.
  const dockOpenings: { id: string; at: number }[] = [];
  const ui: PointerUiState = {
    activeFile: script.lesson.workspace.entryFilePath,
    dockOpen: !runtimeDockStartsCollapsed(script.runtime),
  };
  let lastBusyUntilMs = 0;
  let prevAuthoredAtMs = 0;
  // Whether a run has printed to the console yet: a point needs output to land on.
  const runActionType = isPlaygroundRuntimeKind(script.runtime.kind)
    ? "runtime.run"
    : "runtime.start";
  let hasRunOutput = false;

  for (const entry of authored) {
    if (entry.action.type === "console.point") {
      if (!hasRunOutput) {
        throw new CompileError(
          `console.point "${entry.action.id}" comes before the lesson's first ${runActionType} — there is no output on the console to point at yet`,
        );
      }
      if (!ui.dockOpen) {
        throw new CompileError(
          `console.point "${entry.action.id}" points at the console while the runner dock is shut — move it before the runtime.collapseDock, or run again first`,
        );
      }
    }
    if (entry.action.type === runActionType) {
      hasRunOutput = true;
    }
    const target = clickTargetForAction(entry.action, script, ui);
    const busyMs = busyById.get(entry.action.id)!;

    if (target) {
      // A move may not start while an earlier edit is still typing, and — the
      // Performer being strictly sequential — not before the preceding action's
      // planned start either, or it would push that action late.
      const floorMs = Math.max(lastBusyUntilMs, prevAuthoredAtMs);
      const releaseMs = entry.at - CURSOR_CLICK_LEAD_MS;
      const windowMs = releaseMs - floorMs;
      // A shut dock shows no Run button. Clicking only its chevron would read as
      // the chevron running the program, so the pointer opens the dock and
      // then presses Run — the one control that runs code.
      const opensDockFirst = entry.action.type === "runtime.run" && !ui.dockOpen;
      if (opensDockFirst && windowMs >= CURSOR_OPEN_AND_RUN_NEEDS_MS) {
        const moveMs = Math.min(
          Math.floor((windowMs - CURSOR_CLICK_LEAD_MS) / 2),
          CURSOR_CLICK_MS + CURSOR_TRAVEL_MAX_MS,
        );
        const runMoveAt = releaseMs - moveMs;
        cursorMoves.push({
          id: `cursor-${entry.action.id}-dock`,
          at: runMoveAt - CURSOR_CLICK_LEAD_MS - moveMs,
          target,
          durationMs: moveMs,
        });
        dockOpenings.push({ id: `open-dock-${entry.action.id}`, at: runMoveAt });
        cursorMoves.push({
          id: `cursor-${entry.action.id}`,
          at: runMoveAt,
          target: { kind: "run-button" },
          durationMs: moveMs,
        });
      } else if (windowMs >= CURSOR_CLICK_MS + CURSOR_TRAVEL_MIN_MS) {
        const durationMs = Math.min(windowMs, CURSOR_CLICK_MS + CURSOR_TRAVEL_MAX_MS);
        cursorMoves.push({
          id: `cursor-${entry.action.id}`,
          at: releaseMs - durationMs,
          target,
          durationMs,
        });
        if (opensDockFirst) {
          warnings.push(
            `Only the dock's chevron is clicked before "${entry.action.id}" — pressing Run after opening the dock needs ${CURSOR_OPEN_AND_RUN_NEEDS_MS + CURSOR_CLICK_LEAD_MS}ms clear before it`,
          );
        }
      } else {
        warnings.push(
          `Skipped the pointer click before "${entry.action.id}" — only ${Math.max(0, Math.round(entry.at - floorMs))}ms clear before it (a click needs ${CURSOR_CLICK_NEEDS_MS}ms after the previous action starts and any typing, select drag or whiteboard drawing ends)`,
        );
      }
    }

    advancePointerUiState(entry.action, ui);
    prevAuthoredAtMs = entry.at;
    lastBusyUntilMs = Math.max(lastBusyUntilMs, entry.at + busyMs);
  }

  // ---- Assemble the plan ---------------------------------------------------
  const planActions = [
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
        case "runtime.run":
        case "runtime.collapseDock":
          return { id: action.id, type: action.type, at, timeoutMs: action.timeoutMs };
        case "runtime.start":
        case "runtime.waitForReady":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            retry: action.retry,
          };
        case "preview.open":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            mode: action.mode,
            retry: action.retry,
          };
        case "preview.click":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            target: action.target,
            retry: action.retry,
          };
        case "preview.input":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            target: action.target,
            value: action.value,
            retry: action.retry,
          };
        case "preview.scroll":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            target: action.target,
            top: action.top,
            left: action.left,
            retry: action.retry,
          };
        case "preview.route":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            route: action.route,
            retry: action.retry,
          };
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
            clear: action.clear,
            drawMs: action.drawMs,
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
        case "expect.preview":
          return {
            id: action.id,
            type: action.type,
            at,
            timeoutMs: action.timeoutMs,
            target: action.target,
            textContains: action.textContains,
            value: action.value,
            route: action.route,
            attribute: action.attribute,
            retry: action.retry,
          };
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
    throw new CompileError(
      PLAN_TIMING_ERROR.test(message)
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
