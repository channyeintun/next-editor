import { expect } from "vitest";

import { resolveAnchorOffset } from "./async";
import type { LessonScript } from "./script/schema";

/**
 * Shared checks for the per-lesson crash-course tests.
 *
 * Each crash course (kite, zig, haskell, asm) guards its own script, but the
 * mechanical parts of that guard are the same lesson to lesson: reconstruct the
 * program the typing really produces, and hold the whiteboard to a legibility
 * standard. They lived as verbatim copies in four files, which meant a fix to
 * the replay semantics or the layout heuristics had to be made four times or
 * the lessons were held to different rules.
 */

/**
 * Apply a lesson's `editor.type` insertions in order, as the player does, and
 * return the program a viewer ends up with.
 *
 * Anchors go through the driver's own `resolveAnchorOffset` rather than a copy
 * of it, so what this reconstructs is the program a render really produces:
 * `after: ""` anchors the file start and `occurrence` picks among repeats, both
 * of which the schema allows and a hand-rolled unique-match rule would reject.
 *
 * Insert-only, and every anchor has to resolve at the moment it is applied —
 * that is the failure that aborts a render mid-performance. `editor.select`
 * targets are resolved too, for the same reason, but change nothing.
 */
export function replayTypedFile(script: LessonScript, path: string): string {
  let file = script.lesson.workspace.files[path] ?? "";
  for (const scene of script.scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type === "editor.type") {
        const at = resolveAnchorOffset(file, action.target);
        expect(at, `anchor for ${action.id}`).not.toBeNull();
        if (at === null) continue;
        file = file.slice(0, at) + action.text + file.slice(at);
      } else if (action.type === "editor.select") {
        const at = resolveAnchorOffset(file, {
          after: action.target.text,
          occurrence: action.target.occurrence,
        });
        expect(at, `selection ${action.id}`).not.toBeNull();
      }
    }
  }
  return file;
}

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
 * Whiteboard labels are readable and inside the visible canvas.
 *
 * This is the standard the newest lessons are authored to, not a repo-wide
 * invariant: most of the older scripts predate `fontSize` being set at all and
 * would fail the 28px floor, so this is called from the lessons that hold to it
 * rather than from the registry test that iterates every script.
 *
 * The visuals carry those lessons, and neither the compile step nor the render
 * gates check legibility or overflow. Collected rather than asserted per asset
 * so a layout regression reports every offender at once.
 */
export function whiteboardLabelProblems(script: LessonScript): {
  tooSmall: string[];
  overflowing: string[];
  offCanvas: string[];
} {
  const tooSmall = (script.lesson.whiteboardAssets ?? [])
    .filter((asset) => asset.kind === "text" && asset.fontSize < 28)
    .map((asset) => `${asset.id} @ ${asset.fontSize}px`);
  const offCanvas = (script.lesson.whiteboardAssets ?? [])
    .filter(
      (asset) =>
        asset.x < 250 ||
        asset.y < 150 ||
        asset.x + asset.width > 1100 ||
        asset.y + asset.height > 650,
    )
    .map((asset) => asset.id);

  // Excalidraw's hand-drawn font runs about 0.55em per character, and no
  // gate anywhere catches a label running out of its box.
  const overflowing = (script.lesson.whiteboardAssets ?? [])
    .filter(
      (asset) =>
        asset.kind === "text" &&
        asset.text !== undefined &&
        asset.text.length * asset.fontSize * 0.55 > asset.width,
    )
    .map((asset) => `${asset.id}: "${asset.text}"`);

  return { tooSmall, overflowing, offCanvas };
}
