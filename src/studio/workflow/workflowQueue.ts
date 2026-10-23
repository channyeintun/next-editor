/**
 * The studio workflow: a queue of lessons the studio takes through render →
 * draft → publish one after another, unattended, and stops at the first
 * failure with an issue report. This module is the queue and its rules — what
 * each lesson still needs, and what a reload does to a run that was in flight —
 * kept pure so they are tested without mounting the studio. useStudioWorkflow
 * drives it; workflowStorage persists it.
 */

export type WorkflowStep = "render" | "draft" | "publish";

export type WorkflowLessonStatus =
  | "queued"
  | "rendering"
  | "uploading"
  | "publishing"
  | "done"
  | "failed";

export interface WorkflowSettings {
  /** Upload every passing render as a draft lesson. */
  createDraft: boolean;
  /** Publish every draft. Requires createDraft. */
  publish: boolean;
  /** Give a lesson no picked image matches the site's default thumbnail. */
  defaultThumbnailWhenMissing: boolean;
}

/** The draft lesson a passing render was uploaded as. */
export interface WorkflowDraft {
  /** The server's lesson id. */
  lessonId: string;
  /** The lesson's URL slug (/learn/<slug>). */
  urlSlug: string;
}

export interface WorkflowIssue {
  step: WorkflowStep;
  message: string;
  /** The render phase the failure happened in; null outside the render step. */
  phase: string | null;
  atIso: string;
  /** Everything needed to fix it, as Markdown to paste into Claude (workflowIssue.ts). */
  report: string;
}

export interface WorkflowLesson {
  slug: string;
  title: string;
  /** File name of the picked thumbnail, or null for the default (or none). */
  thumbnail: string | null;
  status: WorkflowLessonStatus;
  /**
   * The lesson id reserved for this lesson's upload, so a retried upload
   * writes over the same storage keys instead of leaving another copy behind.
   */
  uploadId: string | null;
  draft: WorkflowDraft | null;
  published: boolean;
  issue: WorkflowIssue | null;
}

export type WorkflowState =
  /** Built, never started. */
  | "ready"
  | "running"
  /** Running, and finishes the current lesson before it stops. */
  | "stopping"
  | "stopped"
  | "failed"
  | "finished";

export interface StudioWorkflow {
  version: 1;
  id: string;
  createdAtIso: string;
  settings: WorkflowSettings;
  state: WorkflowState;
  lessons: WorkflowLesson[];
}

export interface WorkflowLessonInput {
  slug: string;
  title: string;
  thumbnail: string | null;
}

export function createWorkflow(input: {
  id: string;
  createdAtIso: string;
  settings: WorkflowSettings;
  lessons: readonly WorkflowLessonInput[];
}): StudioWorkflow {
  return {
    version: 1,
    id: input.id,
    createdAtIso: input.createdAtIso,
    // Publishing needs a draft to publish.
    settings: {
      ...input.settings,
      createDraft: input.settings.createDraft || input.settings.publish,
    },
    state: "ready",
    lessons: input.lessons.map((lesson) => ({
      ...lesson,
      status: "queued",
      uploadId: null,
      draft: null,
      published: false,
      issue: null,
    })),
  };
}

/**
 * A stored workflow as a fresh page load finds it. Nothing survives a reload
 * mid-step — the render's recording lived in that page — so a lesson caught
 * rendering, uploading or publishing is queued again (keeping a draft it
 * already has), and a workflow that was running is stopped until resumed.
 */
export function restoreWorkflow(stored: StudioWorkflow): StudioWorkflow {
  const interrupted = stored.state === "running" || stored.state === "stopping";
  return {
    ...stored,
    state: interrupted ? "stopped" : stored.state,
    lessons: stored.lessons.map((lesson) =>
      lesson.status === "rendering" ||
      lesson.status === "uploading" ||
      lesson.status === "publishing"
        ? { ...lesson, status: "queued" }
        : lesson,
    ),
  };
}

/**
 * The next step a lesson needs, or null once it is complete. A lesson with a
 * draft never renders again: resuming after a failed publish only publishes.
 */
export function nextStepOf(
  lesson: WorkflowLesson,
  settings: WorkflowSettings,
): WorkflowStep | null {
  if (!lesson.draft) {
    if (lesson.status === "done") return null;
    return "render";
  }
  if (settings.publish && !lesson.published) return "publish";
  return null;
}

/** Index of the first lesson that still needs a step, or -1 when all are done. */
export function nextLessonIndex(workflow: StudioWorkflow): number {
  return workflow.lessons.findIndex((lesson) => lesson.status !== "done");
}

export function updateLesson(
  workflow: StudioWorkflow,
  slug: string,
  patch: Partial<Omit<WorkflowLesson, "slug">>,
): StudioWorkflow {
  return {
    ...workflow,
    lessons: workflow.lessons.map((lesson) =>
      lesson.slug === slug ? { ...lesson, ...patch } : lesson,
    ),
  };
}

export function withWorkflowState(workflow: StudioWorkflow, state: WorkflowState): StudioWorkflow {
  return { ...workflow, state };
}

/**
 * Stop the workflow at a lesson's failure. The lesson keeps whatever it got
 * before the failing step (a draft survives a failed publish), so resuming
 * picks up at that step.
 */
export function failLesson(
  workflow: StudioWorkflow,
  slug: string,
  issue: WorkflowIssue,
): StudioWorkflow {
  return withWorkflowState(updateLesson(workflow, slug, { status: "failed", issue }), "failed");
}

export function workflowProgressOf(workflow: StudioWorkflow): { done: number; total: number } {
  return {
    done: workflow.lessons.filter((lesson) => lesson.status === "done").length,
    total: workflow.lessons.length,
  };
}

/** Whether the workflow is taking a lesson through its steps right now. */
export function isWorkflowActive(workflow: StudioWorkflow | null): boolean {
  return workflow?.state === "running" || workflow?.state === "stopping";
}

/** The issue that stopped the workflow, if it is stopped at one. */
export function workflowIssueOf(
  workflow: StudioWorkflow | null,
): { lesson: WorkflowLesson; issue: WorkflowIssue } | null {
  if (workflow?.state !== "failed") return null;
  const lesson = workflow.lessons.find(
    (candidate) => candidate.issue && candidate.status === "failed",
  );
  return lesson?.issue ? { lesson, issue: lesson.issue } : null;
}

/** Whether a parsed value has the stored workflow's shape (workflowStorage). */
export function isStudioWorkflow(value: unknown): value is StudioWorkflow {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StudioWorkflow>;
  return (
    candidate.version === 1 &&
    typeof candidate.id === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.settings === "object" &&
    candidate.settings !== null &&
    Array.isArray(candidate.lessons) &&
    candidate.lessons.every(
      (lesson) =>
        typeof lesson === "object" &&
        lesson !== null &&
        typeof lesson.slug === "string" &&
        typeof lesson.status === "string",
    )
  );
}
