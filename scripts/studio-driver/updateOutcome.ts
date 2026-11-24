/**
 * What `update <slug> --replace` says about the studio's answer to a replace:
 * which of the three things happened, in words a person can act on.
 */

import type { StudioAutomationReplacement } from "../../src/studio/studioWindowHandle.ts";

export interface ReplacementOutcome {
  /** Whether the command succeeded: the lesson plays this render, or already did. */
  ok: boolean;
  lines: string[];
}

export function replacementOutcome(
  answer: Exclude<StudioAutomationReplacement, { compared: unknown }>,
): ReplacementOutcome {
  if ("refused" in answer) {
    return { ok: false, lines: [`refused, nothing replaced: ${answer.refused}`] };
  }
  if ("unchanged" in answer) {
    return {
      ok: true,
      lines: [
        `unchanged: /learn/${answer.unchanged.urlSlug} already plays exactly this render; nothing was written`,
      ],
    };
  }
  const { urlSlug, audioFile, previousAudioFile } = answer.replaced;
  return {
    ok: true,
    lines: [
      `replaced: /learn/${urlSlug} now plays this render`,
      previousAudioFile
        ? `narration: ${audioFile}; the earlier ${previousAudioFile} is kept for viewers who opened the lesson before the change`
        : `narration: ${audioFile} (the lesson named no other narration file before)`,
    ],
  };
}
