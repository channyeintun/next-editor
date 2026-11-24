/**
 * The studio workflow's queue as the driver reports it: when it has settled,
 * what changed since the last look, and the workflow.json it leaves behind.
 */

import type { StudioWorkflow, WorkflowState } from "../../src/studio/workflow/workflowQueue.ts";
import type { WorkflowNarration } from "../../src/studio/workflow/workflowRunner.ts";
import type { RenderedScript } from "./scriptIds.ts";

/** One look at the studio's workflow: its queue and its narration pass. */
export interface WorkflowLook {
  workflow: StudioWorkflow | null;
  narration: WorkflowNarration | null;
}

const SETTLED_STATES: ReadonlySet<WorkflowState> = new Set(["finished", "failed", "stopped"]);

export function isWorkflowSettled(workflow: StudioWorkflow): boolean {
  return SETTLED_STATES.has(workflow.state);
}

/**
 * Lines for whatever moved between two looks at the queue and the narration
 * pass: a lesson's status, the workflow's state, the lesson being narrated.
 * Empty when nothing did.
 */
export function workflowChanges(before: WorkflowLook, after: WorkflowLook): string[] {
  const lines: string[] = [];
  const next = after.workflow;
  if (next) {
    const sameRun = before.workflow?.id === next.id;
    if (!sameRun || before.workflow?.state !== next.state) {
      lines.push(`workflow: ${next.state}`);
    }
    for (const lesson of next.lessons) {
      const previous = sameRun
        ? before.workflow?.lessons.find((each) => each.slug === lesson.slug)
        : undefined;
      if (previous?.status === lesson.status) continue;
      const detail =
        lesson.status === "failed" && lesson.issue
          ? ` (${lesson.issue.step}: ${lesson.issue.message})`
          : lesson.status === "done" && lesson.draft
            ? ` (/learn/${lesson.draft.urlSlug}${lesson.published ? ", published" : ", draft"})`
            : "";
      lines.push(`  ${lesson.slug}: ${lesson.status}${detail}`);
    }
  }
  const active = after.narration?.active ?? null;
  const wasActive = before.narration?.active ?? null;
  if (active && (active.slug !== wasActive?.slug || active.phase !== wasActive?.phase)) {
    lines.push(`  narrating ${active.slug}: ${active.phase}`);
  }
  const stopped = after.narration?.stopped ?? null;
  if (stopped && stopped.slug !== before.narration?.stopped?.slug) {
    lines.push(
      `  narration pass stopped at ${stopped.slug} (${stopped.reason}): ${stopped.message}`,
    );
  }
  return lines;
}

/** A fingerprint of everything that counts as progress, so the driver can tell a long step from a hang. */
export function workflowProgressKey(
  workflow: StudioWorkflow | null,
  narration: WorkflowNarration | null,
): string {
  return JSON.stringify([
    workflow?.id ?? null,
    workflow?.state ?? null,
    workflow?.lessons.map((lesson) => lesson.status) ?? [],
    narration?.active ?? null,
    narration?.ready.length ?? 0,
  ]);
}

export interface WorkflowSummaryLesson {
  slug: string;
  title: string;
  status: string;
  /** The draft lesson's server id; null when no draft was made. */
  draftId: string | null;
  /** The lesson's URL slug once published; publishing keeps the draft's slug. */
  publishedSlug: string | null;
  /** The published script that was rendered; null when the driver could not tell. */
  scriptId: string | null;
  issue: { step: string; message: string; phase: string | null; atIso: string } | null;
}

export interface WorkflowSummary {
  site: string;
  workflowId: string;
  state: WorkflowState;
  settings: StudioWorkflow["settings"];
  lessons: WorkflowSummaryLesson[];
}

/** What workflow.json holds: per lesson its status, draft id and published slug. */
export function workflowSummary(
  site: string,
  workflow: StudioWorkflow,
  scripts: readonly RenderedScript[],
): WorkflowSummary {
  const scriptIds = new Map(scripts.map((script) => [script.slug, script.id]));
  return {
    site,
    workflowId: workflow.id,
    state: workflow.state,
    settings: workflow.settings,
    lessons: workflow.lessons.map((lesson) => ({
      slug: lesson.slug,
      title: lesson.title,
      status: lesson.status,
      draftId: lesson.draft?.lessonId ?? null,
      publishedSlug: lesson.published && lesson.draft ? lesson.draft.urlSlug : null,
      scriptId: scriptIds.get(lesson.slug) ?? null,
      issue: lesson.issue
        ? {
            step: lesson.issue.step,
            message: lesson.issue.message,
            phase: lesson.issue.phase,
            atIso: lesson.issue.atIso,
          }
        : null,
    })),
  };
}

/** Each failed lesson's issue report, to save as `<slug>.issue.md`. */
export function workflowIssueReports(workflow: StudioWorkflow): { slug: string; report: string }[] {
  return workflow.lessons.flatMap((lesson) =>
    lesson.status === "failed" && lesson.issue
      ? [{ slug: lesson.slug, report: lesson.issue.report }]
      : [],
  );
}

/**
 * The lessons a resumed workflow will still render: not done, and with no
 * draft yet (a lesson that has one goes on from its upload).
 */
export function slugsStillToRender(workflow: StudioWorkflow): string[] {
  return workflow.lessons
    .filter((lesson) => lesson.status !== "done" && lesson.draft === null)
    .map((lesson) => lesson.slug);
}
