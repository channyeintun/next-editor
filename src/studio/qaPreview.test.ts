import { describe, expect, it } from "vite-plus/test";
import type { StudioPlan, StudioPlanAction } from "./plan";
import { planRunsOffWallClock, planUsesPreview } from "./qaPreview";

// Only the actions decide; the rest of a plan is never read.
const planOf = (...actions: Partial<StudioPlanAction>[]) =>
  ({
    actions: actions.map((action, index) => ({ id: `a${index}`, at: index * 100, ...action })),
  }) as unknown as StudioPlan;

const editorAndStage: Partial<StudioPlanAction>[] = [
  { type: "workspace.openFile", path: "main.go" },
  { type: "editor.type", path: "main.go" },
  { type: "editor.select", path: "main.go" },
  { type: "cursor.moveTo", target: { kind: "run-button" } } as Partial<StudioPlanAction>,
  { type: "slide.show", slideId: "s1" },
  { type: "slide.point" },
  { type: "slide.close" },
  { type: "whiteboard.apply", upsertIds: [] },
  { type: "whiteboard.point" },
  { type: "runtime.collapseDock" },
  { type: "runtime.expandDock" },
  { type: "expect.file", path: "main.go", contains: "x" },
];

describe("planRunsOffWallClock", () => {
  it("holds for a lesson of the editor, slides and whiteboard, in either mode", () => {
    const plan = planOf(...editorAndStage);
    expect(planRunsOffWallClock(plan, "fixture")).toBe(true);
    expect(planRunsOffWallClock(plan, "live")).toBe(true);
    expect(planRunsOffWallClock(planOf(), "live")).toBe(true);
  });

  it("holds for a Playground run only when its result is a fixture", () => {
    const plan = planOf(
      { type: "editor.type", path: "main.go" },
      { type: "runtime.run" },
      { type: "console.point" },
      { type: "expect.output", contains: "ok" },
    );
    expect(planRunsOffWallClock(plan, "fixture")).toBe(true);
    // A live run goes over the network.
    expect(planRunsOffWallClock(plan, "live")).toBe(false);
  });

  it("fails for a runtime that boots, even before any preview", () => {
    expect(planRunsOffWallClock(planOf({ type: "runtime.start" }), "live")).toBe(false);
    expect(planRunsOffWallClock(planOf({ type: "runtime.waitForReady" }), "live")).toBe(false);
  });

  it("fails for every preview action and a pointer aimed into the preview", () => {
    for (const type of [
      "preview.open",
      "preview.click",
      "preview.input",
      "preview.scroll",
      "preview.route",
      "preview.point",
      "expect.preview",
    ] as const) {
      const plan = planOf(...editorAndStage, { type });
      expect(planUsesPreview(plan)).toBe(true);
      expect(planRunsOffWallClock(plan, "fixture")).toBe(false);
    }
    const aimed = planOf({
      type: "cursor.moveTo",
      target: { kind: "preview", testId: "count" },
    } as Partial<StudioPlanAction>);
    expect(planRunsOffWallClock(aimed, "live")).toBe(false);
  });
});
