import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { runWhenIdle, runWhenIdleAfterLoad } from "./idle";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runWhenIdle", () => {
  it("asks requestIdleCallback, with the timeout, where the browser has it", () => {
    const requestIdleCallback = vi.fn<typeof window.requestIdleCallback>(() => 7);
    const cancelIdleCallback = vi.fn<typeof window.cancelIdleCallback>();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    const callback = vi.fn<() => void>();

    const cancel = runWhenIdle(callback, 2500);
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 2500 });

    requestIdleCallback.mock.calls[0][0]({ didTimeout: false, timeRemaining: () => 10 });
    expect(callback).toHaveBeenCalledTimes(1);
    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });

  it("falls back to a timer where it doesn't (Safari)", () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const callback = vi.fn<() => void>();

    runWhenIdle(callback, 2500);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn<() => void>();
    runWhenIdle(cancelled, 2500)();
    vi.runAllTimers();
    expect(cancelled).not.toHaveBeenCalled();
  });
});

describe("runWhenIdleAfterLoad", () => {
  beforeEach(() => {
    vi.stubGlobal("requestIdleCallback", undefined);
  });

  it("waits for the load event while the page is still loading", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
    const callback = vi.fn<() => void>();

    runWhenIdleAfterLoad(callback, 2500);
    vi.runAllTimers();
    expect(callback).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("load"));
    vi.runAllTimers();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("goes straight to idle once the page has loaded", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
    const callback = vi.fn<() => void>();

    runWhenIdleAfterLoad(callback, 2500);
    vi.runAllTimers();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("never runs once cancelled, before or after the load event", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const beforeLoad = vi.fn<() => void>();
    const afterLoad = vi.fn<() => void>();

    runWhenIdleAfterLoad(beforeLoad, 2500)();
    const cancelAfterLoad = runWhenIdleAfterLoad(afterLoad, 2500);
    window.dispatchEvent(new Event("load"));
    cancelAfterLoad();
    vi.runAllTimers();

    expect(beforeLoad).not.toHaveBeenCalled();
    expect(afterLoad).not.toHaveBeenCalled();
  });
});
