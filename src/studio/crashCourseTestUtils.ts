import { expect } from "vite-plus/test";

import { resolveAnchorOffset } from "./async";
import type { LessonScript } from "./script/schema";

/**
 * Shared checks for the per-lesson crash-course tests.
 *
 * Each crash course (kite, zig, haskell, asm) guards its own script, but the
 * mechanical parts of that guard are the same lesson to lesson: reconstruct the
 * program the typing really produces, and hold the whiteboard to a legibility
 * standard (whiteboardLegibility.ts, which the offline compile check shares).
 * They lived as verbatim copies in four files, which meant a fix to the replay
 * semantics or the layout heuristics had to be made four times or the lessons
 * were held to different rules.
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
