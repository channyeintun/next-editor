import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { RENDER_CANCELLED_MESSAGE, StudioActionError, abortableSleep } from "./async";
import { REAL_RENDER_CLOCK, createVirtualRenderClock } from "./renderClock";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("REAL_RENDER_CLOCK", () => {
  it("is the page's own clock: its timers, its time, and no frame of its own", async () => {
    expect(REAL_RENDER_CLOCK.kind).toBe("real");
    expect(REAL_RENDER_CLOCK.sleep).toBe(abortableSleep);
    const before = performance.now();
    expect(REAL_RENDER_CLOCK.perfNow()).toBeGreaterThanOrEqual(before);
    expect(Math.abs(REAL_RENDER_CLOCK.wallNow() - Date.now())).toBeLessThan(50);
    const frameSpy = vi.spyOn(window, "requestAnimationFrame");
    await REAL_RENDER_CLOCK.frame(new AbortController().signal);
    expect(frameSpy).not.toHaveBeenCalled();
  });
});

describe("createVirtualRenderClock", () => {
  it("starts at the page's own time and moves both readings together", async () => {
    const perfBefore = performance.now();
    const wallBefore = Date.now();
    const clock = createVirtualRenderClock();
    expect(clock.kind).toBe("virtual");
    // To the whole millisecond, so readings against it come out exact.
    expect(Number.isInteger(clock.perfNow())).toBe(true);
    expect(clock.perfNow()).toBeGreaterThanOrEqual(Math.floor(perfBefore));
    expect(clock.perfNow()).toBeLessThanOrEqual(performance.now());
    expect(clock.wallNow()).toBeGreaterThanOrEqual(wallBefore);

    const perf = clock.perfNow();
    const wall = clock.wallNow();
    await clock.sleep(250, new AbortController().signal);
    expect(clock.perfNow()).toBe(perf + 250);
    expect(clock.wallNow()).toBe(wall + 250);
  });

  it("stands still while the page settles, and moves only once it has", async () => {
    const clock = createVirtualRenderClock();
    const start = clock.perfNow();
    const seen: number[] = [];
    // Work the last step queued (a chain of promise hops, as a commit's
    // effects are) runs during the settle, and reads the step's own time.
    let chain = Promise.resolve();
    for (let hop = 0; hop < 20; hop++) chain = chain.then(() => undefined);
    void chain.then(() => seen.push(clock.perfNow() - start));

    const sleeping = clock.sleep(100, new AbortController().signal);
    expect(clock.perfNow() - start).toBe(0);
    await sleeping;

    expect(seen).toEqual([0]);
    expect(clock.perfNow() - start).toBe(100);
  });

  it("settles without moving for a zero, negative or non-finite wait", async () => {
    const clock = createVirtualRenderClock();
    const start = clock.perfNow();
    const signal = new AbortController().signal;
    await clock.sleep(0, signal);
    await clock.sleep(-40, signal);
    await clock.sleep(Number.NaN, signal);
    expect(clock.perfNow()).toBe(start);
  });

  it("performs a long wait in far less real time", async () => {
    const clock = createVirtualRenderClock();
    const start = clock.perfNow();
    const signal = new AbortController().signal;
    for (let step = 0; step < 100; step++) await clock.sleep(60_000, signal);
    // A hundred minutes of lesson, within the test's own few-second budget.
    expect(clock.perfNow() - start).toBe(6_000_000);
  });

  it("gives one real frame without moving time", async () => {
    const clock = createVirtualRenderClock();
    const start = clock.perfNow();
    const frameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        setTimeout(() => callback(0), 0);
        return 1;
      });
    await clock.frame(new AbortController().signal);
    expect(frameSpy).toHaveBeenCalledTimes(1);
    expect(clock.perfNow()).toBe(start);
  });

  it("falls back to a short timer when the page runs no frames", async () => {
    const clock = createVirtualRenderClock();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const started = performance.now();
    await clock.frame(new AbortController().signal);
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  });

  it("rejects with the render's cancellation, and keeps its time, once the signal aborts", async () => {
    const clock = createVirtualRenderClock();
    const start = clock.perfNow();

    const aborted = new AbortController();
    aborted.abort();
    await expect(clock.sleep(1_000, aborted.signal)).rejects.toThrow(RENDER_CANCELLED_MESSAGE);
    await expect(clock.frame(aborted.signal)).rejects.toThrow(StudioActionError);

    // Aborted while the page settles: the wait never happens.
    const midway = new AbortController();
    const sleeping = clock.sleep(1_000, midway.signal);
    midway.abort();
    await expect(sleeping).rejects.toThrow(RENDER_CANCELLED_MESSAGE);

    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const framing = new AbortController();
    const frame = clock.frame(framing.signal);
    framing.abort();
    await expect(frame).rejects.toThrow(RENDER_CANCELLED_MESSAGE);

    expect(clock.perfNow()).toBe(start);
  });
});
