import { LESSON_SCRIPTS_FOLDER } from "../plans/publishedScripts";
import { advisoryWarningsOf, checkFailsRender, type StudioRenderReport } from "../report";
import type { WorkflowStep } from "./workflowQueue";

/**
 * The issue report a stopped studio workflow hands Chan to paste into Claude:
 * which lesson, which step, the error, and the render's own evidence (failed
 * gates, advisory warnings, failed actions, page errors, Director warnings), in
 * Markdown, with
 * where the lesson's source lives so the fix can start there.
 */

export interface WorkflowIssueInput {
  step: WorkflowStep;
  slug: string;
  title: string;
  /** Whether the lesson came from an imported YAML instead of the published lessons. */
  imported: boolean;
  /**
   * The id of the published script the studio renders for this lesson, so
   * whoever fixes it can tell whether the file in the folder has moved on
   * since. Null or absent when it is not known.
   */
  publishedId?: string | null;
  message: string;
  /** The render phase the failure happened in; null outside the render step. */
  phase: string | null;
  position: { index: number; total: number; done: number };
  narration: { provider: string; voice: string | null; runtimeMode: string | null };
  /** The finished render's report, when the render got that far. */
  report: StudioRenderReport | null;
  buildWarnings: readonly string[];
  atIso: string;
  origin: string;
  userAgent: string;
}

const STEP_LABELS: Record<WorkflowStep, string> = {
  render: "render",
  draft: "draft upload",
  publish: "publish",
  playlist: "add to playlist",
};

/** At most this many entries per evidence list; the rest are counted. */
const MAX_LIST_ENTRIES = 15;

function bulletList(entries: readonly string[]): string {
  const shown = entries.slice(0, MAX_LIST_ENTRIES).map((entry) => `- ${entry}`);
  if (entries.length > MAX_LIST_ENTRIES) {
    shown.push(`- … and ${entries.length - MAX_LIST_ENTRIES} more`);
  }
  return shown.join("\n");
}

/** Text that may hold backticks or newlines, as one inline code span. */
function inlineCode(text: string): string {
  return `\`${text.replace(/`/g, "'").replace(/\s+/g, " ").trim()}\``;
}

export function buildWorkflowIssueReport(input: WorkflowIssueInput): string {
  const source = input.imported
    ? "imported in the studio (not a checked-in script)"
    : `\`${LESSON_SCRIPTS_FOLDER}/${input.slug}.yaml\`${input.publishedId ? `, published as \`${input.publishedId}\`` : ""}`;
  const voice = input.narration.voice ? `, voice "${input.narration.voice}"` : "";
  const lines = [
    `## Studio workflow stopped at ${input.slug}`,
    "",
    `- Step: ${STEP_LABELS[input.step]}${input.phase ? ` (phase ${inlineCode(input.phase)})` : ""}`,
    `- Lesson: ${input.title} — ${source}`,
    `- Narration: ${input.narration.provider}${voice}; runtime ${input.narration.runtimeMode ?? "plan default"}`,
    `- Workflow: lesson ${input.position.index + 1} of ${input.position.total}; ${input.position.done} done before it stopped`,
    `- When: ${input.atIso} on ${input.origin}`,
    `- Browser: ${input.userAgent}`,
    "",
    "### Error",
    "",
    "```text",
    input.message.replace(/```/g, "'''"),
    "```",
  ];

  const report = input.report;
  if (report) {
    const checkLine = (check: StudioRenderReport["checks"][number]) =>
      `${inlineCode(check.id)}: ${check.detail}`;
    // An advisory check that failed did not stop the render, so it is not listed as
    // one that failed; it may still point at the cause.
    const failedChecks = report.checks.filter(checkFailsRender).map(checkLine);
    if (failedChecks.length > 0) {
      lines.push("", "### Failed checks", "", bulletList(failedChecks));
    }
    const warnings = advisoryWarningsOf(report.checks).map(checkLine);
    if (warnings.length > 0) {
      lines.push("", "### Warnings", "", bulletList(warnings));
    }
    const failedActions = report.receipts
      // Not "skipped": everything after a failure is skipped, and says nothing.
      .filter((receipt) => receipt.status === "failed" || receipt.error)
      .map(
        (receipt) =>
          `${inlineCode(receipt.actionId)} (${receipt.actionType}, planned at ${Math.round(receipt.plannedAtMs)} ms, ${receipt.status})${receipt.error ? `: ${receipt.error}` : ""}`,
      );
    if (failedActions.length > 0) {
      lines.push("", "### Failed actions", "", bulletList(failedActions));
    }
    if (report.errors.length > 0) {
      lines.push("", "### Page errors", "", bulletList(report.errors));
    }
  }
  if (input.buildWarnings.length > 0) {
    lines.push("", "### Director warnings", "", bulletList(input.buildWarnings));
  }

  lines.push(
    "",
    "Fix the cause, then resume the workflow in the studio: it picks up at this lesson.",
  );
  return `${lines.join("\n")}\n`;
}
