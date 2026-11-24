// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BEFORE_TAKE_STALL_MS,
  observeRender,
  type RenderObservation,
  type RenderWatchLimits,
  startRenderWatch,
  VANISHED_GRACE_MS,
} from "./renderWatch.ts";

const MIN = 60_000;
// A one-minute lesson: the take gets the fixed 7 min plus twice its length.
const limits: RenderWatchLimits = {
  takeMs: 9 * MIN,
  beforeTakeMs: 34 * MIN,
  stallMs: BEFORE_TAKE_STALL_MS,
  vanishedGraceMs: VANISHED_GRACE_MS,
};

const running = (now: number, phase: string | null | undefined): RenderObservation => ({
  now,
  runs: 0,
  running: true,
  phase,
});

describe("render watch", () => {
  it("passes a first render whose model download takes 8 minutes before a 9-minute take", () => {
    const watch = startRenderWatch(limits, 0, 0);
    expect(observeRender(watch, running(1_000, "tts-model"))).toEqual({
      kind: "waiting",
      phaseChanged: "tts-model",
    });
    expect(observeRender(watch, running(2_000, "tts-bundle")).kind).toBe("waiting");
    // The download: one phase for 8 minutes.
    expect(observeRender(watch, running(8 * MIN, "tts-bundle")).kind).toBe("waiting");
    expect(observeRender(watch, running(8 * MIN + 1_000, "synthesize 1/12")).kind).toBe("waiting");
    expect(observeRender(watch, running(10 * MIN, "compile")).kind).toBe("waiting");
    expect(observeRender(watch, running(10 * MIN + 1_000, "prepare-workspace")).kind).toBe(
      "waiting",
    );
    expect(observeRender(watch, running(11 * MIN, "perform")).kind).toBe("waiting");
    // 18 minutes after the start, but under 9 into the take.
    expect(observeRender(watch, running(18 * MIN, "qa")).kind).toBe("waiting");
    expect(
      observeRender(watch, { now: 18 * MIN + 1_000, runs: 1, running: false, phase: null }),
    ).toEqual({ kind: "finished" });
  });

  it("fails a take that outlasts its allowance, naming the phase", () => {
    const watch = startRenderWatch(limits, 0, 0);
    observeRender(watch, running(1_000, "compile"));
    observeRender(watch, running(2 * MIN, "perform"));
    expect(observeRender(watch, running(2 * MIN + limits.takeMs - 1, "perform")).kind).toBe(
      "waiting",
    );
    const verdict = observeRender(watch, running(2 * MIN + limits.takeMs + 1, "perform"));
    expect(verdict).toEqual({
      kind: "failed",
      reason: 'the render did not finish in 9 min of the take (in phase "perform")',
    });
  });

  it("keeps the take's clock when a phase before it shows again", () => {
    const watch = startRenderWatch(limits, 0, 0);
    observeRender(watch, running(1_000, "compile"));
    observeRender(watch, running(2_000, "prepare-workspace"));
    observeRender(watch, running(3_000, "waiting-for-visible-tab"));
    expect(observeRender(watch, running(2_000 + limits.takeMs + 1, "start-recording")).kind).toBe(
      "failed",
    );
  });

  it("fails a stretch before the take whose phase stops changing, naming the phase", () => {
    const watch = startRenderWatch(limits, 0, 0);
    observeRender(watch, running(1_000, "synthesize 3/12"));
    expect(
      observeRender(watch, running(1_000 + BEFORE_TAKE_STALL_MS, "synthesize 3/12")).kind,
    ).toBe("waiting");
    expect(observeRender(watch, running(2_000 + BEFORE_TAKE_STALL_MS, "synthesize 3/12"))).toEqual({
      kind: "failed",
      reason: 'the render stalled: no change of phase for 20 min, stopped in "synthesize 3/12"',
    });
  });

  it("bounds the whole stretch before the take even while it moves", () => {
    const watch = startRenderWatch(limits, 0, 0);
    let now = 0;
    let dialog = 0;
    let verdict = observeRender(watch, running(now, "tts-model"));
    while (verdict.kind === "waiting") {
      now += MIN;
      dialog += 1;
      verdict = observeRender(watch, running(now, `synthesize ${dialog}/999`));
    }
    expect(now).toBe(35 * MIN);
    expect(verdict).toEqual({
      kind: "failed",
      reason: 'the render did not reach the take in 34 min (in phase "synthesize 35/999")',
    });
  });

  it("gives a studio that publishes no phase the take's allowance from the start", () => {
    const watch = startRenderWatch(limits, 0, 0);
    expect(observeRender(watch, running(limits.takeMs, undefined)).kind).toBe("waiting");
    expect(observeRender(watch, running(limits.takeMs + 1, undefined))).toEqual({
      kind: "failed",
      reason: "the render did not finish in 9 min",
    });
  });

  it("fails at once when the page shows fewer runs than before the start", () => {
    const watch = startRenderWatch(limits, 1, 0);
    observeRender(watch, { now: 1_000, runs: 1, running: true, phase: "perform" });
    expect(observeRender(watch, { now: 2_000, runs: 0, running: false, phase: undefined })).toEqual(
      {
        kind: "failed",
        reason:
          "the render is gone: the page shows 0 runs where it had 1, so it was reloaded or replaced",
      },
    );
  });

  it("fails a short while after nothing runs and nothing finished", () => {
    const watch = startRenderWatch(limits, 0, 0);
    observeRender(watch, running(5 * MIN, "perform"));
    // A reload: the new page has an empty handle.
    const idle = (now: number): RenderObservation => ({
      now,
      runs: 0,
      running: false,
      phase: null,
    });
    expect(observeRender(watch, idle(5 * MIN + 1_000)).kind).toBe("waiting");
    expect(observeRender(watch, idle(5 * MIN + VANISHED_GRACE_MS)).kind).toBe("waiting");
    expect(observeRender(watch, idle(5 * MIN + VANISHED_GRACE_MS + 1_000))).toEqual({
      kind: "failed",
      reason:
        'the render is gone: no render has run for 11 s and none finished (last phase "perform"); the page was reloaded or the render stopped without saying why',
    });
  });

  it("fails a start that never shows a render running", () => {
    const watch = startRenderWatch(limits, 2, 0);
    const idle = { runs: 2, running: false, phase: null };
    expect(observeRender(watch, { now: VANISHED_GRACE_MS, ...idle }).kind).toBe("waiting");
    expect(observeRender(watch, { now: VANISHED_GRACE_MS + 1, ...idle }).kind).toBe("failed");
  });
});
