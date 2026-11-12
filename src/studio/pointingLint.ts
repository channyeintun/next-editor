import type { StudioPlan } from "./plan";

/**
 * Stretches of a lesson where the narration explains something on screen and
 * the pointer never shows which thing — docs/lesson-script-authoring.md "The
 * pointer". Advisory: nothing here can tell what the words are about, only
 * that a surface stayed up, talked over, with nothing on it pointed at. An
 * author keeps a slide that is one sentence, or a preview that is only
 * operated, on purpose.
 *
 * The editor and the whiteboard are not checked. Code is pointed at by
 * `editor.select`, which authors already lean on, and the board has the pen.
 */

/**
 * How long a slide may stay up before a learner needs to be shown where the
 * narration is on it: about two sentences. A shorter slide is a title or a
 * single statement, read at a glance.
 */
export const SLIDE_UNPOINTED_MAX_MS = 8_000;

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

/**
 * One warning per slide that stays up longer than {@link SLIDE_UNPOINTED_MAX_MS}
 * with no `slide.point` on it, and one when the preview is open and the
 * pointer never points into it. `plan` is a compiled plan, so the times are
 * the narration's.
 */
export function pointingGaps(plan: Pick<StudioPlan, "actions" | "narration">): string[] {
  const warnings: string[] = [];
  const endMs = plan.narration.expectedDurationMs;

  let showing: { slideId: string; at: number; pointed: boolean } | null = null;
  const closeSlide = (at: number) => {
    if (showing && !showing.pointed && at - showing.at > SLIDE_UNPOINTED_MAX_MS) {
      warnings.push(
        `slide "${showing.slideId}" stays up ${seconds(at - showing.at)} and the pointer never points at it — add a slide.point where the narration reaches each part of it`,
      );
    }
    showing = null;
  };

  let previewOpenedAt: number | null = null;
  let previewPointed = false;
  let previewTargetsChecked = 0;

  for (const action of plan.actions) {
    switch (action.type) {
      case "slide.show":
        closeSlide(action.at);
        showing = { slideId: action.slideId, at: action.at, pointed: false };
        break;
      case "slide.close":
        closeSlide(action.at);
        break;
      case "slide.point":
        if (showing) showing.pointed = true;
        break;
      case "preview.open":
        previewOpenedAt ??= action.at;
        break;
      case "preview.point":
        previewPointed = true;
        break;
      case "expect.preview":
        if (action.target) previewTargetsChecked += 1;
        break;
      default:
        break;
    }
  }
  closeSlide(endMs);

  // A lesson that checks elements of its app is a lesson that talks about
  // them; one that only opens the preview may just be showing that it runs.
  if (previewOpenedAt !== null && !previewPointed && previewTargetsChecked > 0) {
    warnings.push(
      `the preview is open for ${seconds(endMs - previewOpenedAt)} and the pointer never points into it — add a preview.point where the narration names an element (the lesson checks ${previewTargetsChecked} with expect.preview)`,
    );
  }

  return warnings;
}
