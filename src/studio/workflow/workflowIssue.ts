import type { StudioRenderReport } from "../report";
import type { WorkflowStep } from "./workflowQueue";

/**
 * The issue report a stopped studio workflow hands Chan to paste into Claude:
 * which lesson, which step, the error, and the render's own evidence (failed
 * gates, failed actions, page errors, Director warnings), in Markdown, with
 * where the lesson's source lives so the fix can start there.
 */

export interface WorkflowIssueInput {
  step: WorkflowStep;
  slug: string;
  title: string;
  /** Whether the lesson came from an imported YAML instead of src/studio/scripts. */
  imported: boolean;
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
    : `\`src/studio/scripts/${input.slug}.yaml\``;
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
    const failedChecks = report.checks
      .filter((check) => !check.ok)
      .map((check) => `${inlineCode(check.id)}: ${check.detail}`);
    if (failedChecks.length > 0) {
      lines.push("", "### Failed checks", "", bulletList(failedChecks));
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
