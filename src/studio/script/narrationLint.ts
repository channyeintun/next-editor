import { isBurmeseLocale } from "../narrationLanguage";
import { VOXCPM2_MAX_TEXT_CHARS } from "../tts/voxcpm2Protocol";
import type { ScriptNarration } from "./estimatedCompile";

/**
 * Offline narration checks (scripts/studio-compile-check.ts): what a dialog's
 * text gets wrong that otherwise shows only once it is sent for synthesis, or
 * once a listener hears it. An error fails a render; a warning is advisory —
 * fix it, or keep it on purpose.
 */

export interface NarrationIssue {
  dialogId: string;
  severity: "error" | "warning";
  message: string;
}

/** About 30 s of speech at ~14 characters a second (VoxCPM2 Burmese, measured). */
export const LONG_DIALOG_CHARS = 450;

/**
 * Symbols a narrator would have to pronounce. The editor shows the code; the
 * narration names it in words and never reads it out.
 */
const CODE_IN_NARRATION = /[{}<>=;()[\]`]|\w+\.\w+\(|\bdata-testid\b|\bclassName=/g;

/** Burmese ends a sentence at ။ (or ! ? .) and pauses at ၊; any other end cuts a clause in two. */
const BURMESE_DIALOG_END = /[။!?.၊]$/u;

export function narrationIssues(
  locale: string,
  { dialogs, speechTexts }: Pick<ScriptNarration, "dialogs" | "speechTexts">,
): NarrationIssue[] {
  const burmese = isBurmeseLocale(locale);
  const issues: NarrationIssue[] = [];
  dialogs.forEach((dialog, index) => {
    // Trimmed, as the Worker counts it before it refuses a request.
    const text = speechTexts[index].trim();
    const issue = (severity: NarrationIssue["severity"], message: string) =>
      issues.push({ dialogId: dialog.id, severity, message });

    // VoxCPM2 narrates only Burmese, and AthanLab's per-request limit is higher.
    if (burmese && text.length > VOXCPM2_MAX_TEXT_CHARS) {
      issue(
        "error",
        `is ${text.length} characters, and VoxCPM2 speaks at most ${VOXCPM2_MAX_TEXT_CHARS} per request — split it with a [[mark:…]]`,
      );
    } else if (text.length > LONG_DIALOG_CHARS) {
      issue(
        "warning",
        `is ${text.length} characters (about ${Math.round(text.length / 14)} s) — consider splitting it at a sentence end`,
      );
    }
    if (burmese && !BURMESE_DIALOG_END.test(text)) {
      issue("warning", `does not end at a sentence end or a ၊ pause: …${text.slice(-30)}`);
    }
    const code = text.match(CODE_IN_NARRATION);
    if (code) {
      issue(
        "warning",
        `contains code-like characters ${JSON.stringify([...new Set(code)])} — narration names code, it never reads it`,
      );
    }
  });
  return issues;
}
