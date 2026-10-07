import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Recorded = (...args: unknown[]) => void;

const posthog = vi.hoisted(() => {
  const calls: string[] = [];
  const record =
    (name: string): Recorded =>
    (...args) => {
      calls.push(`${name} ${JSON.stringify(args)}`);
    };
  return {
    calls,
    client: {
      capture: vi.fn<Recorded>(record("capture")),
      captureException: vi.fn<(error: unknown) => void>(),
      identify: vi.fn<Recorded>(record("identify")),
      reset: vi.fn<Recorded>(record("reset")),
      startSessionRecording: vi.fn<Recorded>(record("startSessionRecording")),
      stopSessionRecording: vi.fn<Recorded>(record("stopSessionRecording")),
    },
    initPostHog: vi.fn<() => unknown>(),
  };
});

vi.mock("./posthogClient", () => ({ initPostHog: posthog.initPostHog }));
// Idle comes at once; the import of the client stays asynchronous.
vi.mock("./idle", () => ({
  runWhenIdle: (callback: () => void) => {
    callback();
    return () => {};
  },
}));

async function freshAnalytics() {
  vi.resetModules();
  return import("./analytics");
}

function dispatchRejection(reason: unknown): Event {
  const event = Object.assign(new Event("unhandledrejection"), { reason });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  posthog.calls.length = 0;
  vi.clearAllMocks();
  posthog.initPostHog.mockReturnValue(posthog.client);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analytics", () => {
  it("queues calls until PostHog has loaded, then replays them in order", async () => {
    const { analytics, loadAnalyticsWhenIdle } = await freshAnalytics();

    analytics.stopSessionRecording();
    analytics.identify("user-1", { username: "chan" });
    analytics.capture("signed_out");
    analytics.reset();
    analytics.startSessionRecording();
    expect(posthog.calls).toEqual([]);

    loadAnalyticsWhenIdle();
    await vi.waitFor(() => expect(posthog.initPostHog).toHaveBeenCalledTimes(1));
    expect(posthog.calls).toEqual([
      "stopSessionRecording []",
      'identify ["user-1",{"username":"chan"}]',
      'capture ["signed_out",null]',
      "reset []",
      "startSessionRecording []",
    ]);

    analytics.capture("lesson_published", { lesson_id: "l1" });
    expect(posthog.calls.at(-1)).toBe('capture ["lesson_published",{"lesson_id":"l1"}]');
  });

  it("reports uncaught errors from before the load, then leaves them to PostHog", async () => {
    const { analytics, bufferEarlyErrors, loadAnalyticsWhenIdle } = await freshAnalytics();
    bufferEarlyErrors();

    const errorEvent = new ErrorEvent("error", { error: new Error("boom") });
    window.dispatchEvent(errorEvent);
    const rejection = dispatchRejection(new Error("nope"));
    analytics.captureException("from the route boundary");

    loadAnalyticsWhenIdle();
    await vi.waitFor(() => expect(posthog.initPostHog).toHaveBeenCalledTimes(1));
    expect(posthog.client.captureException.mock.calls).toEqual([
      [errorEvent],
      [rejection],
      ["from the route boundary"],
    ]);

    // PostHog's own autocapture owns window errors from here on. (The stand-in
    // listener keeps Vitest from reporting the event as an uncaught error.)
    const standIn = () => {};
    window.addEventListener("error", standIn);
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("later") }));
    window.removeEventListener("error", standIn);
    expect(posthog.client.captureException).toHaveBeenCalledTimes(3);
  });

  it("keeps only the first errors while PostHog is away", async () => {
    const { bufferEarlyErrors, loadAnalyticsWhenIdle } = await freshAnalytics();
    bufferEarlyErrors();

    for (let index = 0; index < 50; index++) dispatchRejection(index);

    loadAnalyticsWhenIdle();
    await vi.waitFor(() => expect(posthog.initPostHog).toHaveBeenCalledTimes(1));
    expect(posthog.client.captureException).toHaveBeenCalledTimes(20);
  });

  it("drops everything when the client chunk fails to load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    posthog.initPostHog.mockImplementation(() => {
      throw new Error("chunk failed");
    });
    const { analytics, bufferEarlyErrors, loadAnalyticsWhenIdle } = await freshAnalytics();
    bufferEarlyErrors();
    analytics.capture("before");

    loadAnalyticsWhenIdle();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    analytics.capture("after");
    expect(posthog.calls).toEqual([]);
  });
});
