import type { WhiteboardElementJSON } from "../core/src/whiteboard";

/**
 * Excalidraw draws each text element into its own canvas sized from the
 * element's stored width (plus fontSize/2 device px of padding), so glyphs past
 * that width are cut off. It measures text only when someone types it on this
 * machine; a width that arrives from elsewhere (a studio-authored asset, a
 * recording, another person's board) is drawn as stored. Burmese made the gap
 * visible: no Excalidraw font has Myanmar glyphs, so the browser draws them in
 * its system fallback (Noto Sans Myanmar on macOS), much wider than the
 * authored widths, and board titles lost their last syllables.
 *
 * So the board widens free-standing text to what it measures here with the
 * font string Excalidraw draws with. A box only ever grows, and the glyphs stay
 * where they were: Excalidraw anchors left, centred and right-aligned text at
 * x, x + width/2 and x + width, so x moves left by none, half or all of the
 * growth. A stored size that already fits is kept. Text bound inside a shape
 * is laid out by its container and is left as it is.
 *
 * The fit is display-only. The scene, the recording and a collaboration room
 * keep the stored size: before a canvas change is recorded or shared,
 * {@link withoutTextFit} puts back each text element that differs only by its
 * fit. Otherwise every untouched label would go out with the next real edit,
 * at a version a room already holds, and the room would refuse the whole edit.
 */

// Excalidraw 0.18's FONT_FAMILY ids and their fallbacks (getFontFamilyString).
// Copied rather than imported so tests that mock @excalidraw/excalidraw keep working.
const FONT_FAMILY_NAMES: Readonly<Record<number, string>> = {
  1: "Virgil",
  2: "Helvetica",
  3: "Cascadia",
  5: "Excalifont",
  6: "Nunito",
  7: "Lilita One",
  8: "Comic Shanns",
  9: "Liberation Sans",
};
const EXCALIFONT = 5;
const DEFAULT_LINE_HEIGHT = 1.25;

/** The CSS font Excalidraw draws a text element with (its getFontString). */
export function excalidrawFontString(fontSize: number, fontFamily: number): string {
  const name = FONT_FAMILY_NAMES[fontFamily];
  if (!name) return `${fontSize}px Segoe UI Emoji`;
  const fallbacks = fontFamily === EXCALIFONT ? ", Xiaolai, Segoe UI Emoji" : ", Segoe UI Emoji";
  return `${fontSize}px ${name}${fallbacks}`;
}

/** Advance width of one line in `font`, or null when nothing can measure it. */
export type MeasureTextLine = (font: string, line: string) => number | null;

// undefined: not created yet; null: this environment has no 2D canvas (jsdom).
let measureContext: CanvasRenderingContext2D | null | undefined;
const lineWidths = new Map<string, number>();

const measureLineWithCanvas: MeasureTextLine = (font, line) => {
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement("canvas").getContext("2d");
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) return null;
  const key = `${font}\u0000${line}`;
  const cached = lineWidths.get(key);
  if (cached !== undefined) return cached;
  measureContext.font = font;
  const width = measureContext.measureText(line).width;
  lineWidths.set(key, width);
  return width;
};

/**
 * Forget measured widths (and the measuring canvas, made again on next use).
 * Call it when fonts finish loading: a line measured before Excalidraw's font
 * arrived was measured in a fallback font.
 */
export function clearTextMeasurements(): void {
  lineWidths.clear();
  measureContext = undefined;
}

// A fitted copy needs a new versionNonce: Excalidraw takes its undo snapshot
// only of elements whose nonce changed, so an unchanged nonce would leave the
// clipped size in history and an undo would bring it back. Derived, not random,
// so every scene push produces the same copy.
function fitVersionNonce(versionNonce: unknown, width: number, height: number): number {
  let hash = 0x811c9dc5;
  for (const char of `${String(versionNonce)}|${width}|${height}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  }
  return hash >>> 1;
}

// How far x moves left when a box of this alignment grows by `growth`, so the
// glyphs Excalidraw anchors at x, x + width/2 or x + width stay put.
function anchorShift(textAlign: unknown, growth: number): number | null {
  if (textAlign === undefined || textAlign === "left") return 0;
  if (textAlign === "center") return growth / 2;
  if (textAlign === "right") return growth;
  return null;
}

/**
 * The element itself when it already fits (or is not free-standing, upright
 * text), otherwise a copy widened and/or heightened to its measured size.
 */
export function fitTextElement(
  element: WhiteboardElementJSON,
  measureLine: MeasureTextLine = measureLineWithCanvas,
): WhiteboardElementJSON {
  if (element.type !== "text" || element.isDeleted) return element;
  // Bound text is laid out by its container and fixed-width text wraps inside
  // its box. Excalidraw rotates an element about its centre, so growing rotated
  // text would move its glyphs.
  if (element.containerId) return element;
  if (anchorShift(element.textAlign, 0) === null) return element;
  if (element.autoResize === false) return element;
  if (typeof element.angle === "number" && element.angle !== 0) return element;

  const { text, fontSize, fontFamily, width, height, x } = element;
  if (
    typeof x !== "number" ||
    typeof text !== "string" ||
    typeof fontSize !== "number" ||
    typeof fontFamily !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return element;
  }

  const font = excalidrawFontString(fontSize, fontFamily);
  const lines = text.split("\n");
  let measuredWidth = 0;
  for (const line of lines) {
    const lineWidth = measureLine(font, line);
    if (lineWidth === null) return element;
    measuredWidth = Math.max(measuredWidth, lineWidth);
  }
  const lineHeight =
    typeof element.lineHeight === "number" ? element.lineHeight : DEFAULT_LINE_HEIGHT;
  const measuredHeight = fontSize * lineHeight * lines.length;

  if (measuredWidth <= width && measuredHeight <= height) return element;
  const fittedWidth = Math.max(width, measuredWidth);
  const fittedHeight = Math.max(height, measuredHeight);
  return {
    ...element,
    x: x - (anchorShift(element.textAlign, fittedWidth - width) ?? 0),
    width: fittedWidth,
    height: fittedHeight,
    versionNonce: fitVersionNonce(element.versionNonce, fittedWidth, fittedHeight),
  };
}

// The fields fitTextElement changes.
const FIT_FIELDS: ReadonlySet<string> = new Set(["x", "width", "height", "versionNonce"]);

// Whether `fitted` is `original` changed only by a fit: same version, a box at
// least as large, x moved by exactly its alignment's share of the growth, and
// no other field different.
function isTextFitOf(original: WhiteboardElementJSON, fitted: WhiteboardElementJSON): boolean {
  if (fitted.type !== "text" || original.version !== fitted.version) return false;
  const { width: ow, height: oh, x: ox } = original;
  const { width: fw, height: fh, x: fx } = fitted;
  if (
    typeof ox !== "number" ||
    typeof fx !== "number" ||
    typeof ow !== "number" ||
    typeof oh !== "number" ||
    typeof fw !== "number" ||
    typeof fh !== "number" ||
    fw < ow ||
    fh < oh ||
    (fw === ow && fh === oh) ||
    fx !== ox - (anchorShift(original.textAlign, fw - ow) ?? Number.NaN)
  ) {
    return false;
  }
  const keys = new Set([...Object.keys(original), ...Object.keys(fitted)]);
  for (const key of keys) {
    if (FIT_FIELDS.has(key)) continue;
    if (JSON.stringify(original[key]) !== JSON.stringify(fitted[key])) return false;
  }
  return true;
}

/**
 * `elements` (what the canvas holds) with each text element that differs from
 * its counterpart in `baseElements` only by a fit replaced by that counterpart,
 * so a diff against `baseElements` sees no change there. Returns `elements`
 * itself when nothing was put back.
 */
export function withoutTextFit(
  baseElements: readonly WhiteboardElementJSON[],
  elements: readonly WhiteboardElementJSON[],
): readonly WhiteboardElementJSON[] {
  const baseById = new Map(baseElements.map((element) => [element.id, element] as const));
  let restored = false;
  const result = elements.map((element) => {
    const original = baseById.get(element.id);
    if (!original || original === element || !isTextFitOf(original, element)) return element;
    restored = true;
    return original;
  });
  return restored ? result : elements;
}
