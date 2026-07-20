import { describe, expect, it } from "vite-plus/test";
import { parseStudioPlan, type StudioPlan } from "./plan";
import { createM0GoHelloPlan } from "./plans/m0GoHello";

function clonePlan(plan: StudioPlan): StudioPlan {
  return structuredClone(plan);
}

describe("studio plan schema", () => {
  it("accepts the checked-in M0 plan", () => {
    const plan = createM0GoHelloPlan();
    expect(plan.lesson.slug).toBe("m0-go-hello");
    expect(plan.actions.length).toBeGreaterThan(5);
  });

  it("rejects duplicate action ids", () => {
    const plan = clonePlan(createM0GoHelloPlan());
    plan.actions[1].id = plan.actions[0].id;
    expect(() => parseStudioPlan(plan)).toThrow(/Duplicate action id/);
  });

  it("rejects actions scheduled out of order", () => {
    const plan = clonePlan(createM0GoHelloPlan());
    plan.actions[1].at = plan.actions[0].at - 100;
    expect(() => parseStudioPlan(plan)).toThrow(/before its predecessor/);
  });

  it("rejects typing that overlaps the next action", () => {
    const plan = clonePlan(createM0GoHelloPlan());
    const typing = plan.actions.find((action) => action.type === "editor.type");
    if (typing?.type !== "editor.type") throw new Error("fixture has no typing action");
    typing.chunks[0] = { ...typing.chunks[0], delayMs: 60_000 };
    expect(() => parseStudioPlan(plan)).toThrow(/overlaps/);
  });

  it("rejects references to files outside the pinned workspace", () => {
    const plan = clonePlan(createM0GoHelloPlan());
    const open = plan.actions.find((action) => action.type === "workspace.openFile");
    if (open?.type !== "workspace.openFile") throw new Error("fixture has no openFile action");
    open.path = "missing.go";
    expect(() => parseStudioPlan(plan)).toThrow(/not in the pinned workspace/);
  });

  it("rejects actions scheduled after the narration ends", () => {
    const plan = clonePlan(createM0GoHelloPlan());
    const last = plan.actions.at(-1)!;
    last.at = plan.narration.expectedDurationMs + 1;
    expect(() => parseStudioPlan(plan)).toThrow(/after the narration ends/);
  });

  it("rejects overlapping caption cues", () => {
    const plan = clonePlan(createM0GoHelloPlan());
    plan.narration.captions.cues[1].start = plan.narration.captions.cues[0].end - 50;
    // Word timings inside the shifted cue no longer matter for this test; the
    // cue-overlap issue alone must reject the plan.
    expect(() => parseStudioPlan(plan)).toThrow(/overlaps cue/);
  });
});
