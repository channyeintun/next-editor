import { describe, expect, it } from "vite-plus/test";
import {
  createWorkflow,
  isStudioWorkflow,
  nextStepOf,
  restoreWorkflow,
  updateLesson,
  withWorkflowState,
} from "./workflowQueue";

function workflow(
  settings = { createDraft: true, publish: true, defaultThumbnailWhenMissing: false },
) {
  return createWorkflow({
    id: "w",
    createdAtIso: "2026-10-24T00:00:00.000Z",
    settings,
    lessons: [
      { slug: "a", title: "A", thumbnail: null },
      { slug: "b", title: "B", thumbnail: null },
    ],
  });
}

describe("workflow queue", () => {
  it("drafts every lesson it publishes", () => {
    expect(
      workflow({ createDraft: false, publish: true, defaultThumbnailWhenMissing: false }).settings
        .createDraft,
    ).toBe(true);
  });

  it("queues again what a reload interrupted, keeping a draft it already had", () => {
    let interrupted = withWorkflowState(workflow(), "running");
    interrupted = updateLesson(interrupted, "a", {
      status: "publishing",
      draft: { lessonId: "l1", urlSlug: "a" },
    });
    interrupted = updateLesson(interrupted, "b", { status: "rendering" });

    const restored = restoreWorkflow(interrupted);

    expect(restored.state).toBe("stopped");
    expect(restored.lessons.map((lesson) => lesson.status)).toEqual(["queued", "queued"]);
    expect(restored.lessons[0].draft).toEqual({ lessonId: "l1", urlSlug: "a" });
    expect(nextStepOf(restored.lessons[0], restored.settings)).toBe("publish");
    expect(nextStepOf(restored.lessons[1], restored.settings)).toBe("render");
  });

  it("leaves a finished or failed workflow as it was", () => {
    const failed = withWorkflowState(updateLesson(workflow(), "a", { status: "failed" }), "failed");
    expect(restoreWorkflow(failed)).toEqual(failed);
  });

  it("accepts only the stored workflow's shape", () => {
    expect(isStudioWorkflow(JSON.parse(JSON.stringify(workflow())))).toBe(true);
    expect(isStudioWorkflow({ version: 2, lessons: [] })).toBe(false);
    expect(isStudioWorkflow(null)).toBe(false);
  });
});
