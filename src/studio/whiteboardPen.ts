import { easePointerDrag } from "../core/src/utils/pointerMotion";
import { excalidrawFontString, type MeasureTextLine } from "../utils/whiteboardTextFit";
import type { StudioWhiteboardAsset } from "./plan";
import {
  WHITEBOARD_TEXT_FONT_FAMILY,
  WHITEBOARD_TEXT_LINE_HEIGHT,
  whiteboardStrokeTip,
  whiteboardTextAt,
} from "./whiteboardAssets";

/**
 * The pen: where the studio pointer is while the whiteboard is drawn on, and
 * where it rests when the narration points back at something on the board.
 *
 * On the board the pointer is the hand that draws. A shape is dragged out from
 * its corner, a stroke is traced, and text is written along its line, so the
 * learner's eye is on the thing that is appearing; when the hand stops, the
 * pointer rests where the pen lifted. Everything here is in scene coordinates
 * — the driver turns them into screen points through the board's own anchor.
 */

export interface ScenePoint {
  x: number;
  y: number;
}

/**
 * The fewest recorded steps an asset needs for the pen to draw it. Below this
 * (under 300 ms an asset) a board is being filled in, not drawn, and a pointer
 * darting between the pieces would be noise: the pointer stays out of it.
 */
export const WHITEBOARD_PEN_MIN_STEPS = 6;

/**
 * Steps the pen spends reaching an asset when it comes straight from the one
 * before it in the same apply. Playback glides a parked pointer to its next
 * sample only across a gap wider than its sparse-sample threshold (100 ms), so
 * three 50 ms steps is the shortest lead that replays as one eased stroke
 * rather than a jump. The asset is drawn in the steps that remain.
 */
export const WHITEBOARD_PEN_LEAD_STEPS = 3;

/** Whether an apply's assets get enough steps each for the pen to draw them. */
export function penDrawsApply(stepsPerAsset: number): boolean {
  return stepsPerAsset >= WHITEBOARD_PEN_MIN_STEPS;
}

/** Whether the button is held while this asset is drawn: a drag, not handwriting. */
export function penHoldsButton(asset: StudioWhiteboardAsset): boolean {
  return asset.kind !== "text";
}

const smoothStep = (t: number): number => t * t * (3 - 2 * t);

/**
 * How much of an asset is on the board after `step` of its `stepsPerAsset`
 * steps, `leadSteps` of which the pen spent getting there: null while it is
 * still on its way, else a fraction in (0, 1].
 *
 * A hand does not draw at constant speed. A shape is a drag that lands on its
 * far corner, so it follows the measured drag curve (pointerMotion.ts); a pen
 * stroke speeds up and slows down evenly; text is typed at a steady rate.
 */
export function penDrawProgress(
  asset: StudioWhiteboardAsset,
  step: number,
  stepsPerAsset: number,
  leadSteps: number,
): number | null {
  if (step <= leadSteps) return null;
  const linear = Math.min(1, (step - leadSteps) / Math.max(1, stepsPerAsset - leadSteps));
  if (linear >= 1) return 1;
  // Never 0: every drawn step puts something on the board.
  const eased =
    asset.kind === "text"
      ? linear
      : asset.kind === "freedraw"
        ? smoothStep(linear)
        : easePointerDrag(linear);
  return Math.max(eased, 0.02);
}

interface TextLayout {
  /** Width of each line as drawn, or null where nothing can measure it. */
  measure: (line: string) => number | null;
  lineHeight: number;
}

function textLayout(asset: StudioWhiteboardAsset, measureLine?: MeasureTextLine): TextLayout {
  const font = excalidrawFontString(asset.fontSize, WHITEBOARD_TEXT_FONT_FAMILY);
  return {
    measure: (line) => (measureLine ? measureLine(font, line) : null),
    lineHeight: asset.fontSize * WHITEBOARD_TEXT_LINE_HEIGHT,
  };
}

/** Left and right edges of a line of `lineWidth` inside a text asset's box. */
function lineSpan(asset: StudioWhiteboardAsset, lineWidth: number): [number, number] {
  if (asset.align === "center") {
    const middle = asset.x + asset.width / 2;
    return [middle - lineWidth / 2, middle + lineWidth / 2];
  }
  if (asset.align === "right") {
    return [asset.x + asset.width - lineWidth, asset.x + asset.width];
  }
  return [asset.x, asset.x + lineWidth];
}

/**
 * Where the pen tip is once `progress` of `asset` is drawn.
 *
 * - A shape: the corner being dragged out, opposite the anchor corner.
 * - A stroke: the last point traced.
 * - Text: just past the last character written, low on its line — the arrow's
 *   tip is its top-left, so its body covers the space the next word will take,
 *   never the words already there.
 *
 * `measureLine` sizes text the way the canvas draws it; without one (no 2D
 * canvas) a line's width is its share of the authored box.
 */
export function whiteboardPenPoint(
  asset: StudioWhiteboardAsset,
  planSeed: number,
  progress: number,
  measureLine?: MeasureTextLine,
): ScenePoint {
  const drawn = Math.min(1, Math.max(0, progress));
  if (asset.kind === "freedraw") {
    return whiteboardStrokeTip(asset, planSeed, drawn);
  }
  if (asset.kind === "text") {
    const { measure, lineHeight } = textLayout(asset, measureLine);
    const fullLines = (asset.text ?? "").split("\n");
    const longest = Math.max(1, ...fullLines.map((line) => line.length));
    const lines = whiteboardTextAt(asset, drawn).split("\n");
    const line = lines[lines.length - 1];
    const width = measure(line) ?? (line.length / longest) * asset.width;
    return {
      x: lineSpan(asset, width)[1] + 3,
      y: asset.y + (lines.length - 1) * lineHeight + asset.fontSize * 0.8,
    };
  }
  return {
    x: asset.x + Math.max(1, asset.width * drawn),
    y: asset.y + Math.max(1, asset.height * drawn),
  };
}

/**
 * Where the pen first touches the board to draw `asset`: a shape's anchor
 * corner, a stroke's first point. Text has no press to land — the pen is
 * simply where the first character ends, so centred text, which grows out
 * from the middle of its box, does not start with a jump from its left end.
 */
export function whiteboardPenStart(
  asset: StudioWhiteboardAsset,
  planSeed: number,
  measureLine?: MeasureTextLine,
): ScenePoint {
  if (asset.kind === "freedraw") {
    return whiteboardStrokeTip(asset, planSeed, 0);
  }
  if (asset.kind === "text") {
    return whiteboardPenPoint(asset, planSeed, 0, measureLine);
  }
  return { x: asset.x, y: asset.y };
}

/**
 * Where the pointer rests to point at `asset` (`whiteboard.point`): its tip
 * touches the middle of the asset's bottom edge, so the arrow hangs below and
 * nothing of the asset is covered — the label inside a box stays readable, and
 * a word is pointed at from underneath.
 */
export function whiteboardPointAim(
  asset: StudioWhiteboardAsset,
  measureLine?: MeasureTextLine,
): ScenePoint {
  if (asset.kind !== "text") {
    return { x: asset.x + asset.width / 2, y: asset.y + asset.height };
  }
  const { measure, lineHeight } = textLayout(asset, measureLine);
  const lines = (asset.text ?? "").split("\n");
  const lastLine = lines[lines.length - 1];
  const [left, right] = lineSpan(asset, measure(lastLine) ?? asset.width);
  return { x: (left + right) / 2, y: asset.y + lines.length * lineHeight + 3 };
}
