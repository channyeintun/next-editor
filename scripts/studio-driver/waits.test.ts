// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lessonScriptPath } from "../lessonScriptsDir.ts";
import { studioRenderWaitMs } from "../../src/studio/renderLaunch.ts";
import {
  estimatedNarrationMs,
  renderWaitMsFor,
  WORKFLOW_UPLOAD_ALLOWANCE_MS,
  workflowStallMs,
} from "./waits.ts";

describe("render waits", () => {
  it("falls back to the fixed wait with no local script, or one that does not parse", () => {
    expect(estimatedNarrationMs(null)).toBe(0);
    expect(estimatedNarrationMs("lesson: [")).toBe(0);
    expect(estimatedNarrationMs("lesson:\n  slug: x\n")).toBe(0);
    expect(renderWaitMsFor(null)).toBe(studioRenderWaitMs(0));
  });

  it("adds twice the narration of a real script to the fixed wait", () => {
    const text = readFileSync(lessonScriptPath("rust-borrow"), "utf8");
    const narration = estimatedNarrationMs(text);
    expect(narration).toBeGreaterThan(0);
    expect(renderWaitMsFor(text)).toBe(studioRenderWaitMs(narration));
  });

  it("gives a workflow the longest lesson's render plus an upload before it is stuck", () => {
    expect(workflowStallMs([])).toBe(studioRenderWaitMs(0) + WORKFLOW_UPLOAD_ALLOWANCE_MS);
    expect(workflowStallMs([1_000_000, 2_000_000])).toBe(2_000_000 + WORKFLOW_UPLOAD_ALLOWANCE_MS);
  });
});
