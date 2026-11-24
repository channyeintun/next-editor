import { describe, expect, it, vi } from "vite-plus/test";
import type { WorkflowSettings } from "./workflowQueue";
import { acceptedThumbnails, planWorkflowStart, type WorkflowStartRequest } from "./workflowStart";

vi.mock("@next-editor/infra", () => ({ THUMBNAIL_ACCEPT: "image/png,image/jpeg,image/webp" }));

const SETTINGS: WorkflowSettings = {
  createDraft: true,
  publish: true,
  defaultThumbnailWhenMissing: false,
  playlist: null,
  narrateFirst: true,
};

const png = (name: string) => new File(["png"], name, { type: "image/png" });

function request(overrides: Partial<WorkflowStartRequest> = {}): WorkflowStartRequest {
  return {
    slugs: ["css-course-02-box-model", "css-course-01-basics"],
    settings: SETTINGS,
    thumbnails: [png("01-basics.png"), png("02-box-model.png")],
    lessonOf: (slug) => ({ title: slug.toUpperCase() }),
    blockedReason: null,
    ...overrides,
  };
}

describe("planWorkflowStart", () => {
  it("starts the lessons in course order, each with the image its name matches", () => {
    const plan = planWorkflowStart(request());

    expect(plan.queue.map((lesson) => lesson.slug)).toEqual([
      "css-course-01-basics",
      "css-course-02-box-model",
    ]);
    if (!("start" in plan.outcome)) throw new Error(plan.outcome.refused);
    expect(plan.outcome.start.lessons).toEqual([
      { slug: "css-course-01-basics", title: "CSS-COURSE-01-BASICS", thumbnail: "01-basics.png" },
      {
        slug: "css-course-02-box-model",
        title: "CSS-COURSE-02-BOX-MODEL",
        thumbnail: "02-box-model.png",
      },
    ]);
    expect(plan.outcome.start.thumbnails.get("css-course-01-basics")?.name).toBe("01-basics.png");
    expect(plan.outcome.start.settings).toBe(SETTINGS);
  });

  it("refuses with the studio's own reason first", () => {
    const plan = planWorkflowStart(request({ blockedReason: "A render is running.", slugs: [] }));
    expect(plan.outcome).toEqual({ refused: "A render is running." });
  });

  it("refuses an empty pick", () => {
    expect(planWorkflowStart(request({ slugs: [] })).outcome).toEqual({
      refused: "Pick at least one lesson.",
    });
  });

  it("refuses drafts with no thumbnail unless the default is allowed", () => {
    const missing = request({ thumbnails: [png("01-basics.png")] });

    const refused = planWorkflowStart(missing);
    expect(refused.missingThumbnails).toEqual(["css-course-02-box-model"]);
    expect("refused" in refused.outcome && refused.outcome.refused).toMatch(
      /^1 of 2 lessons have no thumbnail in the picked folder \(css-course-02-box-model\)/,
    );

    const allowed = planWorkflowStart({
      ...missing,
      settings: { ...SETTINGS, defaultThumbnailWhenMissing: true },
    });
    if (!("start" in allowed.outcome)) throw new Error(allowed.outcome.refused);
    expect(allowed.outcome.start.thumbnails.has("css-course-02-box-model")).toBe(false);

    // A render-only workflow uploads nothing, so it needs no image.
    const renderOnly = planWorkflowStart({
      ...missing,
      thumbnails: [],
      settings: { ...SETTINGS, createDraft: false, publish: false },
    });
    expect(renderOnly.missingThumbnails).toEqual([]);
    expect("start" in renderOnly.outcome).toBe(true);
  });

  it("ignores a file that is not an accepted image type", () => {
    const notAnImage = new File(["text"], "01-basics.png", { type: "text/plain" });
    expect(
      acceptedThumbnails([notAnImage, png("02-box-model.png")]).map((file) => file.name),
    ).toEqual(["02-box-model.png"]);

    const plan = planWorkflowStart(request({ thumbnails: [notAnImage, png("02-box-model.png")] }));
    expect(plan.queue[0]).toEqual({ slug: "css-course-01-basics", thumbnail: null });
    expect("refused" in plan.outcome).toBe(true);
  });

  it("refuses a lesson the workflow cannot take, naming it", () => {
    const plan = planWorkflowStart(
      request({
        lessonOf: (slug) =>
          slug === "css-course-02-box-model"
            ? { error: "needs Burmese narration" }
            : { title: slug },
      }),
    );
    expect(plan.outcome).toEqual({ refused: "css-course-02-box-model: needs Burmese narration" });
  });

  it("takes a lesson asked for twice once", () => {
    const plan = planWorkflowStart(
      request({ slugs: ["css-course-01-basics", "css-course-01-basics"] }),
    );
    expect(plan.queue).toHaveLength(1);
  });
});
