// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { StudioWorkflow, WorkflowLesson } from "../../src/studio/workflow/workflowQueue.ts";
import type { WorkflowNarration } from "../../src/studio/workflow/workflowRunner.ts";
import {
  isWorkflowSettled,
  slugsStillToRender,
  workflowChanges,
  workflowIssueReports,
  workflowProgressKey,
  workflowSummary,
} from "./workflowReport.ts";

const NO_WORKFLOW_NARRATION: WorkflowNarration = { active: null, ready: [], stopped: null };

function lesson(slug: string, patch: Partial<WorkflowLesson> = {}): WorkflowLesson {
  return {
    slug,
    title: slug.toUpperCase(),
    thumbnail: null,
    status: "queued",
    uploadId: null,
    draft: null,
    published: false,
    inPlaylist: false,
    issue: null,
    ...patch,
  };
}

function workflow(patch: Partial<StudioWorkflow> = {}): StudioWorkflow {
  return {
    version: 1,
    id: "w1",
    createdAtIso: "2026-11-24T00:00:00.000Z",
    settings: { createDraft: true, publish: true, defaultThumbnailWhenMissing: true },
    state: "running",
    lessons: [lesson("a"), lesson("b")],
    ...patch,
  };
}

const issue = {
  step: "render" as const,
  message: "checks failed",
  phase: "qa",
  atIso: "2026-11-24T01:00:00.000Z",
  report: "# Issue\n",
};

describe("workflowReport", () => {
  it("settles on finished, failed and stopped only", () => {
    expect(isWorkflowSettled(workflow({ state: "running" }))).toBe(false);
    expect(isWorkflowSettled(workflow({ state: "stopping" }))).toBe(false);
    for (const state of ["finished", "failed", "stopped"] as const) {
      expect(isWorkflowSettled(workflow({ state }))).toBe(true);
    }
  });

  it("prints a new run whole, then only what moved", () => {
    const none = { workflow: null, narration: null };
    const first = { workflow: workflow(), narration: NO_WORKFLOW_NARRATION };
    expect(workflowChanges(none, first)).toEqual([
      "workflow: running",
      "  a: queued",
      "  b: queued",
    ]);
    expect(workflowChanges(first, first)).toEqual([]);
    const next = {
      workflow: workflow({
        lessons: [
          lesson("a", {
            status: "done",
            draft: { lessonId: "L1", urlSlug: "a-intro" },
            published: true,
          }),
          lesson("b", { status: "failed", issue }),
        ],
        state: "failed",
      }),
      narration: { active: { slug: "b", phase: "synthesize 2/9" }, ready: ["a"], stopped: null },
    };
    expect(workflowChanges(first, next)).toEqual([
      "workflow: failed",
      "  a: done (/learn/a-intro, published)",
      "  b: failed (render: checks failed)",
      "  narrating b: synthesize 2/9",
    ]);
  });

  it("counts a narration phase as progress", () => {
    const base = workflow();
    expect(workflowProgressKey(base, NO_WORKFLOW_NARRATION)).not.toBe(
      workflowProgressKey(base, {
        active: { slug: "a", phase: "synthesize 1/3" },
        ready: [],
        stopped: null,
      }),
    );
    expect(workflowProgressKey(base, NO_WORKFLOW_NARRATION)).toBe(
      workflowProgressKey(workflow(), NO_WORKFLOW_NARRATION),
    );
  });

  it("summarizes each lesson's status, draft id, published slug and rendered script", () => {
    const done = workflow({
      state: "failed",
      lessons: [
        lesson("a", {
          status: "done",
          draft: { lessonId: "L1", urlSlug: "a-intro" },
          published: true,
        }),
        lesson("b", { status: "failed", draft: { lessonId: "L2", urlSlug: "b-x" }, issue }),
      ],
    });
    const summary = workflowSummary("https://nexteditor.dev", done, [
      { slug: "a", id: "a".repeat(64), source: "abc", localId: null },
    ]);
    expect(summary.lessons).toEqual([
      {
        slug: "a",
        title: "A",
        status: "done",
        draftId: "L1",
        publishedSlug: "a-intro",
        scriptId: "a".repeat(64),
        issue: null,
      },
      {
        slug: "b",
        title: "B",
        status: "failed",
        draftId: "L2",
        publishedSlug: null,
        scriptId: null,
        issue: { step: "render", message: "checks failed", phase: "qa", atIso: issue.atIso },
      },
    ]);
    expect(summary).toMatchObject({
      site: "https://nexteditor.dev",
      workflowId: "w1",
      state: "failed",
    });
    expect(workflowIssueReports(done)).toEqual([{ slug: "b", report: "# Issue\n" }]);
  });

  it("names the lessons a resume still renders: not done and with no draft", () => {
    const stored = workflow({
      state: "stopped",
      lessons: [
        lesson("a", { status: "done", draft: { lessonId: "L1", urlSlug: "a" } }),
        lesson("b", { status: "queued", draft: { lessonId: "L2", urlSlug: "b" } }),
        lesson("c", { status: "failed" }),
        lesson("d"),
      ],
    });
    expect(slugsStillToRender(stored)).toEqual(["c", "d"]);
  });
});
