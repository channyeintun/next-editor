import type { LessonScript } from "./script/schema";

/**
 * Whether a lesson's whiteboard reads on the recorded dark board — the
 * authoring rules in docs/lesson-script-authoring.md "Whiteboard assets".
 * Neither the compile step nor the render gates check any of this: the
 * schema accepts any colour, size and position, and the board renders it.
 *
 * The rules are the standard the newest lessons are authored to, not a
 * repo-wide invariant — older scripts predate the 28px floor — so callers
 * opt in: the crash-course tests and scripts/studio-compile-check.ts.
 */

/** The smallest label that stays readable in the recorded lesson (titles want ≥ 36). */
export const WHITEBOARD_MIN_LABEL_PX = 28;

/** Canvas box that is on screen unzoomed. */
export const WHITEBOARD_VISIBLE_AREA = { left: 250, top: 150, right: 1100, bottom: 650 } as const;

/**
 * Every declared whiteboard asset is drawn, and every drawn id is declared.
 *
 * An undeclared id is a `whiteboard.apply` that draws nothing; an undrawn
 * declaration is a board the narration describes and the viewer never sees.
 */
export function whiteboardAssetProblems(script: LessonScript): {
  undeclared: string[];
  neverDrawn: string[];
} {
  const declared = new Set(script.lesson.whiteboardAssets?.map((asset) => asset.id) ?? []);
  const used = new Set<string>();
  const undeclared: string[] = [];
  for (const scene of script.scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type !== "whiteboard.apply") continue;
      for (const id of action.upsertIds ?? []) {
        used.add(id);
        if (!declared.has(id)) undeclared.push(`${action.id} -> ${id}`);
      }
    }
  }

  return { undeclared, neverDrawn: [...declared].filter((id) => !used.has(id)) };
}

/**
 * Whiteboard labels are readable and inside the visible canvas. Collected
 * rather than asserted per asset so a layout regression reports every
 * offender at once.
 */
export function whiteboardLabelProblems(script: LessonScript): {
  tooSmall: string[];
  overflowing: string[];
  offCanvas: string[];
} {
  const assets = script.lesson.whiteboardAssets ?? [];
  const tooSmall = assets
    .filter((asset) => asset.kind === "text" && asset.fontSize < WHITEBOARD_MIN_LABEL_PX)
    .map((asset) => `${asset.id} @ ${asset.fontSize}px`);
  const { left, top, right, bottom } = WHITEBOARD_VISIBLE_AREA;
  const offCanvas = assets
    .filter(
      (asset) =>
        asset.x < left ||
        asset.y < top ||
        asset.x + asset.width > right ||
        asset.y + asset.height > bottom,
    )
    .map((asset) => asset.id);

  // Excalidraw's hand-drawn font runs about 0.55em per character, and no
  // gate anywhere catches a label running out of its box.
  const overflowing = assets
    .filter(
      (asset) =>
        asset.kind === "text" &&
        asset.text !== undefined &&
        asset.text.length * asset.fontSize * 0.55 > asset.width,
    )
    .map((asset) => `${asset.id}: "${asset.text}"`);

  return { tooSmall, overflowing, offCanvas };
}

/**
 * Excalidraw's dark theme inverts the canvas, so colours are authored in
 * light-mode terms: `#1e1e1e` ink paints white and the mid-tone palette
 * (`#1971c2 #f08c00 #2f9e44 #e03131 #6741d9`) paints legible pastels, while a
 * pale colour paints near-black and all but vanishes. Pale here is a
 * gamma-encoded luminance above 0.6: the palette's brightest, `#f08c00`, is
 * 0.59, while `#7dd3fc` is 0.77 and `#e2e8f0` 0.91.
 */
export function isPaleInk(color: string): boolean {
  const match = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(color.trim());
  if (!match) return false;
  const hex =
    match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  const [red, green, blue] = [0, 2, 4].map(
    (at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.6;
}

/**
 * Ink that vanishes on the dark board, and whether the shapes use one colour
 * only — an all-white board reads flat, so colour should have a job (blue for
 * the thing named, green for done, orange for the caveat, …).
 */
export function whiteboardInkProblems(script: LessonScript): {
  pale: string[];
  oneShapeColour: boolean;
} {
  const assets = script.lesson.whiteboardAssets ?? [];
  const pale = assets
    .filter((asset) => isPaleInk(asset.strokeColor))
    .map((asset) => `${asset.id} (${asset.strokeColor})`);
  const shapeColours = new Set(
    assets
      .filter((asset) => asset.kind !== "text")
      .map((asset) => asset.strokeColor.trim().toLowerCase()),
  );
  return { pale, oneShapeColour: assets.length > 0 && shapeColours.size < 2 };
}
