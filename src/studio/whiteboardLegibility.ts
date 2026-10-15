import type { LessonScript } from "./script/schema";

/**
 * Whether a lesson's whiteboard reads on the recorded dark board — the
 * authoring rules in docs/lesson-script-authoring.md "Whiteboard assets".
 * Neither the compile step nor the render gates check any of this: the
 * schema accepts any colour, size and position, and the board renders it.
 *
 * The rules are the standard the newest lessons are authored to, not a
 * repo-wide invariant — older scripts predate the 28px floor — so callers
 * opt in.
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
