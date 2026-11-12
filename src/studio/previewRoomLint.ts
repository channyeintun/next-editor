import type { StudioPlan } from "./plan";

/**
 * Room for the preview's first load — docs/lesson-script-authoring.md
 * "Opening the preview". `preview.open` acknowledges once the app has loaded in the
 * panel, and how long that takes is the browser's and the dev server's to
 * decide: two to five seconds, and not the same twice. The actions chained
 * after it wait for it by design; the next action the narration times does
 * not, so when it is planned sooner than the load can finish it starts late
 * and the words run ahead of the screen — in one render and not the next.
 * Advisory: an author who knows the app is already warm keeps the plan.
 */

/** The room a first load needs before the next narrated action. */
export const PREVIEW_FIRST_LOAD_ROOM_MS = 5_000;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * One warning when the first action the narration times after the plan's first
 * `preview.open` is planned less than {@link PREVIEW_FIRST_LOAD_ROOM_MS} after
 * it. Actions chained after the open (`afterAction`) and expectations are
 * passed over: they start when the load ends, whenever that is. `plan` is a
 * compiled plan, so the times are the narration's.
 */
export function previewLoadRoom(plan: Pick<StudioPlan, "actions" | "dependencies">): string[] {
  const dependencies = plan.dependencies ?? {};
  const openIndex = plan.actions.findIndex((action) => action.type === "preview.open");
  if (openIndex === -1) return [];
  const open = plan.actions[openIndex];
  const next = plan.actions
    .slice(openIndex + 1)
    .find((action) => !(action.id in dependencies) && !action.type.startsWith("expect."));
  if (!next) return [];
  const roomMs = next.at - open.at;
  if (roomMs >= PREVIEW_FIRST_LOAD_ROOM_MS) return [];
  return [
    `preview.open "${open.id}" is followed ${seconds(roomMs)} later by ${next.type} "${next.id}" — the preview's first load takes 2–5s and that action waits for it, so it can start late; open the preview earlier (${seconds(PREVIEW_FIRST_LOAD_ROOM_MS)} or more before it)`,
  ];
}
