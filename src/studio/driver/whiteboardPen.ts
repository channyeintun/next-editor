import {
  WHITEBOARD_CANVAS_TARGET_ID,
  whiteboardSceneCell,
} from "../../components/whiteboardSceneAnchor";
import { getCursorCellAnchor } from "../../core/src/utils/cursorCellAnchors";
import { measureLineWithCanvas } from "../../utils/whiteboardTextFit";
import type { StudioWhiteboardAsset } from "../plan";
import {
  WHITEBOARD_PEN_LEAD_STEPS,
  penHoldsButton,
  whiteboardPenPoint,
  whiteboardPenStart,
  whiteboardPointAim,
  type ScenePoint,
} from "../whiteboardPen";
import type { StudioDriverDeps } from "./index";
import { roundPoint, type PointerPoint, type StudioPointer } from "./pointer";

/**
 * The pen on screen: turns the pen's scene points (../whiteboardPen.ts) into
 * pointer samples over the live whiteboard. Samples go to the board's own
 * surface, never to Excalidraw's canvas under the point — a button-held move
 * reaching the canvas would be a gesture of its own.
 */

// A pointer that moved more recently than this is still mid-gesture: its next
// sample would replay as part of the same movement, so the pen takes a lead to
// get there. Past it, the pointer was resting, and playback carries a resting
// pointer to its next gesture by itself. Just over playback's own threshold
// between the two (cursorReplay.ts SPARSE_GAP_MS).
const STILL_MOVING_MS = 120;

/** The whiteboard's drawing surface, or null while the board is not mounted. */
export function resolveBoardSurface(): Element | null {
  return document.querySelector(`[data-cursor-replay-target="${WHITEBOARD_CANVAS_TARGET_ID}"]`);
}

export interface WhiteboardPen {
  /** Steps the pen needs to reach the next asset before drawing it (0 when it can start at once). */
  leadSteps(): number;
  /** Put the pen where `progress` of `asset` ends, pressing as it `starts` and lifting as it `ends`. */
  draw(
    asset: StudioWhiteboardAsset,
    progress: number,
    stroke: { starts: boolean; ends: boolean },
  ): void;
  /** Where on screen the pointer rests to point at `asset`. */
  pointAim(surface: Element, asset: StudioWhiteboardAsset): PointerPoint;
}

export function createWhiteboardPen(
  deps: Pick<StudioDriverDeps, "whiteboardStore" | "planSeed">,
  pointer: StudioPointer,
): WhiteboardPen {
  // Through the board's own anchor, which knows the canvas's live scroll and
  // zoom — the same one playback resolves the recorded samples with. Until the
  // canvas has mounted there is none, and the scene's stored view stands in.
  const toScreen = (surface: Element, point: ScenePoint): PointerPoint => {
    const anchored = getCursorCellAnchor(surface)?.toClient(whiteboardSceneCell(point));
    if (anchored) return anchored;
    const { view } = deps.whiteboardStore.getSnapshot().context.scene;
    const rect = surface.getBoundingClientRect();
    return {
      x: rect.left + (point.x + view.scrollX) * view.zoom,
      y: rect.top + (point.y + view.scrollY) * view.zoom,
    };
  };

  return {
    leadSteps() {
      return !pointer.isHidden() && pointer.restedMs() < STILL_MOVING_MS
        ? WHITEBOARD_PEN_LEAD_STEPS
        : 0;
    },

    draw(asset, progress, { starts, ends }) {
      // The board's panel loads on its first open; until it is on screen there
      // is nothing to draw over, and the pen joins in on a later step.
      const surface = resolveBoardSurface();
      const rect = surface?.getBoundingClientRect();
      if (!surface || !rect || rect.width <= 0 || rect.height <= 0) return;

      const held = penHoldsButton(asset) ? 1 : 0;
      const tip = roundPoint(
        toScreen(
          surface,
          whiteboardPenPoint(asset, deps.planSeed, progress, measureLineWithCanvas),
        ),
      );
      if (starts || pointer.isHidden()) {
        const start = starts
          ? roundPoint(
              toScreen(surface, whiteboardPenStart(asset, deps.planSeed, measureLineWithCanvas)),
            )
          : tip;
        // A hidden pointer appears where the stroke begins; a visible one has
        // just arrived there. Either way the press lands before the pen moves.
        pointer.revealAt(start);
        pointer.dispatchOn(start.x, start.y, surface, 0);
        if (held) pointer.dispatchOn(start.x, start.y, surface, held);
      }
      pointer.dispatchOn(tip.x, tip.y, surface, held);
      if (ends && held) {
        // The pen lifts and rests where the stroke ended.
        pointer.dispatchOn(tip.x, tip.y, surface, 0);
      }
    },

    pointAim(surface, asset) {
      return toScreen(surface, whiteboardPointAim(asset, measureLineWithCanvas));
    },
  };
}
