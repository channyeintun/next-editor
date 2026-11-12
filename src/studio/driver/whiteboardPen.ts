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
  /**
   * Put the pen where `progress` of `asset` ends. The first call for an asset
   * lands the pen where its stroke begins and presses; `ends` lifts it.
   */
  draw(asset: StudioWhiteboardAsset, progress: number, stroke: { ends: boolean }): void;
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

  // The asset the pen has begun: its stroke's first point is on the record.
  // Not simply "the first step": a board that is just opening is not on
  // screen for that step, and the stroke must still begin where it begins.
  let begun: string | null = null;

  return {
    leadSteps() {
      return !pointer.isHidden() && pointer.restedMs() < STILL_MOVING_MS
        ? WHITEBOARD_PEN_LEAD_STEPS
        : 0;
    },

    draw(asset, progress, { ends }) {
      // The board's panel renders a moment after it opens; until it is on
      // screen there is nothing to draw over, and the pen joins on a later step.
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
      if (begun !== asset.id || pointer.isHidden()) {
        // Where the stroke begins. Text has no press to land, so the pen goes
        // straight to where its first character ends.
        const start =
          begun !== asset.id && held
            ? roundPoint(
                toScreen(surface, whiteboardPenStart(asset, deps.planSeed, measureLineWithCanvas)),
              )
            : tip;
        // A hidden pointer appears there; a visible one has just arrived.
        // Either way the press lands before the pen moves.
        pointer.revealAt(start);
        pointer.dispatchOn(start.x, start.y, surface, 0);
        if (held) pointer.dispatchOn(start.x, start.y, surface, held);
        begun = asset.id;
      }
      pointer.dispatchOn(tip.x, tip.y, surface, held);
      if (ends) {
        // The pen lifts and rests where the stroke ended.
        if (held) pointer.dispatchOn(tip.x, tip.y, surface, 0);
        begun = null;
      }
    },

    pointAim(surface, asset) {
      return toScreen(surface, whiteboardPointAim(asset, measureLineWithCanvas));
    },
  };
}
