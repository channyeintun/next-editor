// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  StudioAutomationStatus,
  StudioWindowRun,
} from "../../src/studio/studioWindowHandle.ts";
import {
  narrationCostRefusal,
  notReadyReason,
  pageEnvironmentWarning,
  renderVerdict,
  screenRecordingRefusal,
} from "./guards.ts";

function status(patch: Partial<StudioAutomationStatus> = {}): StudioAutomationStatus {
  return {
    ready: true,
    waitingFor: null,
    renderBlockedReason: null,
    workflowBlockedReason: null,
    signedIn: true,
    provider: "voxcpm2",
    providerIsPaid: true,
    voice: "Narrator",
    screenRecording: false,
    lessons: { status: "ready", source: "abc", count: 3, error: null },
    ...patch,
  };
}

const run = (outcome: StudioWindowRun["outcome"]) => ({ outcome }) as StudioWindowRun;

describe("guards", () => {
  it("refuses a profile that records the screen", () => {
    expect(screenRecordingRefusal(status())).toBeNull();
    expect(screenRecordingRefusal(status({ screenRecording: true }))).toContain("screen picker");
  });

  it("refuses a paid provider's missing dialogs unless allowed, counting them", () => {
    const coverage = {
      lessons: [
        { slug: "a", dialogs: 10, missing: 0 },
        { slug: "b", dialogs: 8, missing: 3 },
      ],
      cacheUnavailable: null,
    };
    expect(narrationCostRefusal({ status: status(), coverage, allowSynthesis: false })).toBe(
      'voxcpm2 with the voice "Narrator" would synthesize 3 dialogs this profile has not kept (b 3/8); pass --allow-synthesis to pay for them',
    );
    expect(narrationCostRefusal({ status: status(), coverage, allowSynthesis: true })).toBeNull();
    expect(
      narrationCostRefusal({
        status: status({ providerIsPaid: false }),
        coverage,
        allowSynthesis: false,
      }),
    ).toBeNull();
    expect(
      narrationCostRefusal({
        status: status(),
        coverage: { lessons: [{ slug: "a", dialogs: 10, missing: 0 }], cacheUnavailable: null },
        allowSynthesis: false,
      }),
    ).toBeNull();
  });

  it("counts every dialog when the browser cannot keep narration", () => {
    expect(
      narrationCostRefusal({
        status: status({ voice: null }),
        coverage: {
          lessons: [{ slug: "a", dialogs: 4, missing: 0 }],
          cacheUnavailable: "no Cache Storage",
        },
        allowSynthesis: false,
      }),
    ).toContain("all 4 dialogs");
  });

  it("says what the studio waits for, else why it is blocked", () => {
    expect(notReadyReason(status({ waitingFor: "sign-in" }), "busy")).toContain(
      "waiting for sign-in",
    );
    expect(notReadyReason(status(), "a render is already running")).toBe(
      "a render is already running",
    );
    expect(
      notReadyReason(
        status({ lessons: { status: "error", source: null, count: 0, error: "404" } }),
        null,
      ),
    ).toContain("could not read the lesson index: 404");
  });

  it("passes renders only when every run passed and two or more compare clean", () => {
    expect(renderVerdict([run("passed")], null, 1)).toEqual({
      passed: true,
      comparisonClean: null,
    });
    expect(renderVerdict([run("failed")], null, 1).passed).toBe(false);
    expect(renderVerdict([run("passed")], null, 2).passed).toBe(false);
    const clean = [{ ok: true }] as never;
    expect(renderVerdict([run("passed"), run("passed")], clean, 2)).toEqual({
      passed: true,
      comparisonClean: true,
    });
    expect(renderVerdict([run("passed"), run("passed")], [], 2).comparisonClean).toBe(false);
    expect(renderVerdict([run("passed"), run("passed")], [{ ok: false }] as never, 2).passed).toBe(
      false,
    );
  });

  it("warns about a hidden or starved page", () => {
    expect(pageEnvironmentWarning({ visibilityState: "visible", framesPerSecond: 60 })).toBeNull();
    expect(pageEnvironmentWarning({ visibilityState: "hidden", framesPerSecond: 0 })).toContain(
      "hidden",
    );
    expect(pageEnvironmentWarning({ visibilityState: "visible", framesPerSecond: 12 })).toContain(
      "12 animation frames",
    );
  });
});
