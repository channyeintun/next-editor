import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CURSOR_STEP_MS,
  RENDER_CANCELLED_MESSAGE,
  StudioActionError,
  abortableSleep,
  cancelledError,
  resolveAnchorOffset,
  throwIfAborted,
  tween,
  waitUntil,
} from "./async";

describe("resolveAnchorOffset", () => {
  const content = "aaa bbb aaa bbb aaa";

  it("anchors the start of the file for an empty `after`", () => {
    expect(resolveAnchorOffset(content, { after: "", occurrence: 1 })).toBe(0);
  });

  it("resolves the requested occurrence's end", () => {
    expect(resolveAnchorOffset(content, { after: "aaa", occurrence: 1 })).toBe(3);
    expect(resolveAnchorOffset(content, { after: "aaa", occurrence: 2 })).toBe(11);
    expect(resolveAnchorOffset(content, { after: "aaa", occurrence: 3 })).toBe(19);
  });

  it("returns null for a missing occurrence instead of guessing", () => {
    expect(resolveAnchorOffset(content, { after: "aaa", occurrence: 4 })).toBeNull();
    expect(resolveAnchorOffset(content, { after: "zzz", occurrence: 1 })).toBeNull();
  });

  it("handles overlapping candidates by scanning forward", () => {
    expect(resolveAnchorOffset("aaaa", { after: "aa", occurrence: 2 })).toBe(3);
  });
});

describe("waitUntil", () => {
  it("resolves once the predicate flips", async () => {
    let flag = false;
    setTimeout(() => {
      flag = true;
    }, 30);
    await waitUntil(() => flag, {
      timeoutMs: 2_000,
      signal: new AbortController().signal,
      description: "the flag",
      intervalMs: 5,
    });
    expect(flag).toBe(true);
  });

  it("rejects with the description after the timeout", async () => {
    await expect(
      waitUntil(() => false, {
        timeoutMs: 40,
        signal: new AbortController().signal,
        description: "something that never happens",
        intervalMs: 5,
      }),
    ).rejects.toThrow(/something that never happens/);
  });

  it("rejects when the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      waitUntil(() => false, {
        timeoutMs: 5_000,
        signal: controller.signal,
        description: "an aborted wait",
        intervalMs: 5,
      }),
    ).rejects.toThrow(StudioActionError);
  });

  it("propagates predicate throws as failures", async () => {
    await expect(
      waitUntil(
        () => {
          throw new StudioActionError("hard failure");
        },
        {
          timeoutMs: 1_000,
          signal: new AbortController().signal,
          description: "a throwing predicate",
        },
      ),
    ).rejects.toThrow(/hard failure/);
  });
});

describe("abortableSleep", () => {
  it("sleeps approximately the requested time", async () => {
    const start = performance.now();
    await abortableSleep(25, new AbortController().signal);
    expect(performance.now() - start).toBeGreaterThanOrEqual(20);
  });

  it("rejects immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(1_000, controller.signal)).rejects.toThrow(StudioActionError);
  });
});

describe("cancellation", () => {
  it("throws the render's cancellation error only once the signal aborts", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(cancelledError());
    expect(cancelledError()).toBeInstanceOf(StudioActionError);
    expect(cancelledError().message).toBe(RENDER_CANCELLED_MESSAGE);
    expect(RENDER_CANCELLED_MESSAGE).toBe("The render was cancelled");
  });
});

describe("tween", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const square = (progress: number) => progress * progress;

  it("steps once, straight to the end, when the duration is zero", async () => {
    const steps: [number, number][] = [];
    await tween(0, square, new AbortController().signal, (eased, progress) => {
      steps.push([eased, progress]);
    });
    expect(steps).toEqual([[1, 1]]);
  });

  it("steps every CURSOR_STEP_MS with eased, rising progress and ends at 1", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const started = performance.now();
    const steps: { atMs: number; eased: number; progress: number }[] = [];
    const done = tween(
      4 * CURSOR_STEP_MS,
      square,
      new AbortController().signal,
      (eased, progress) => {
        steps.push({ atMs: performance.now() - started, eased, progress });
      },
    );
    await vi.runAllTimersAsync();
    await done;

    expect(CURSOR_STEP_MS).toBe(16);
    expect(steps).toEqual([
      { atMs: 0, eased: 0, progress: 0 },
      { atMs: 16, eased: 0.0625, progress: 0.25 },
      { atMs: 32, eased: 0.25, progress: 0.5 },
      { atMs: 48, eased: 0.5625, progress: 0.75 },
      { atMs: 64, eased: 1, progress: 1 },
    ]);
  });

  it("fails with the cancellation error when the signal aborts mid-way", async () => {
    const controller = new AbortController();
    let stepCount = 0;
    const run = tween(10_000, square, controller.signal, () => {
      stepCount += 1;
      if (stepCount === 2) controller.abort();
    });
    await expect(run).rejects.toThrow(StudioActionError);
    await expect(run).rejects.toThrow(RENDER_CANCELLED_MESSAGE);
    expect(stepCount).toBe(2);
  });
});
