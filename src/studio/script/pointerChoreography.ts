import {
  POINTER_AIM_MAX_MS,
  POINTER_PRESS_MS,
  POINTER_SETTLE_MS,
} from "../../core/src/utils/pointerMotion";
import { isPlaygroundRuntimeKind, runtimeDockStartsCollapsed, type StudioTargetRef } from "../plan";
import { STUDIO_DOCK_TOGGLE_TARGET_ID } from "../targets";
import { CompileError } from "./errors";
import type { LessonScript, ScriptAction } from "./schema";

/**
 * Pointer choreography (docs/agent-lesson-production.md §7): each pointer move
 * ends in a click on the real control an action belongs to — a file row, the
 * Run button, the dock's chevron, a preview element — released just before the
 * action fires, the way a hand operates the UI. The compiler hands over the
 * authored actions at their resolved times and turns the moves and dock
 * openings returned here into plan actions.
 */

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

/** An authored action at its resolved absolute time. */
export interface PlacedAction {
  action: ScriptAction;
  at: number;
}

export interface CursorMove {
  id: string;
  at: number;
  target: StudioTargetRef;
  durationMs: number;
}

/** A dock opening between a chevron click and the Run press after it. */
export interface DockOpening {
  id: string;
  at: number;
}

export interface PointerChoreographyInput {
  script: LessonScript;
  /** Every authored action in plan order (sorted by time, ties in authored order). */
  authored: readonly PlacedAction[];
  /** Busy time by action id (actionTiming.ts's actionBusyMsById). */
  busyMs: ReadonlyMap<string, number>;
}

export interface PointerChoreography {
  cursorMoves: CursorMove[];
  dockOpenings: DockOpening[];
  warnings: string[];
}

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

/**
 * Derive the click before every action that has a control on screen, and the
 * dock opening before a run whose dock is shut. A click that has no room is
 * skipped with a warning; a `console.point` with no output to land on, or with
 * the dock shut, is a CompileError.
 */
export function planPointerChoreography({
  script,
  authored,
  busyMs,
}: PointerChoreographyInput): PointerChoreography {
  const cursorMoves: CursorMove[] = [];
  const dockOpenings: DockOpening[] = [];
  const warnings: string[] = [];
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
    const entryBusyMs = busyMs.get(entry.action.id) ?? 0;

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
    lastBusyUntilMs = Math.max(lastBusyUntilMs, entry.at + entryBusyMs);
  }

  return { cursorMoves, dockOpenings, warnings };
}
