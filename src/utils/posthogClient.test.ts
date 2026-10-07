import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { initPostHog } from "./posthogClient";
import { POSTHOG_REPLAY_PRIVACY_OPTIONS } from "./posthogExceptionFilter";

const mocks = vi.hoisted(() => ({
  init: vi.fn<(token: string, config: Record<string, unknown>) => void>(),
  landingDemoFrame: false,
}));

vi.mock("posthog-js", () => ({ default: { init: mocks.init } }));
vi.mock("./demoEmbedControls", () => ({ isLandingDemoFrame: () => mocks.landingDemoFrame }));

function initConfig(): Record<string, unknown> {
  initPostHog();
  return mocks.init.mock.calls[0][1];
}

beforeEach(() => {
  mocks.init.mockClear();
  mocks.landingDemoFrame = false;
});

describe("initPostHog", () => {
  it("captures pageviews, replay and exceptions through the sanitizer", () => {
    const config = initConfig();

    expect(config).toMatchObject({
      defaults: "2026-01-30",
      capture_exceptions: true,
      ...POSTHOG_REPLAY_PRIVACY_OPTIONS,
    });
    expect(config).not.toHaveProperty("capture_pageview");
    expect(config).not.toHaveProperty("disable_session_recording");
    const beforeSend = config.before_send as (event: unknown) => unknown;
    expect(
      beforeSend({
        event: "$exception",
        properties: { $exception_list: [{ type: "Error", value: "secret" }] },
      }),
    ).toEqual({
      event: "$exception",
      properties: { $exception_list: [{ type: "Error", value: "[redacted]" }] },
    });
  });

  it("drops pageviews and replay inside the landing page's demo frame", () => {
    mocks.landingDemoFrame = true;

    expect(initConfig()).toMatchObject({
      capture_exceptions: true,
      capture_pageview: false,
      disable_session_recording: true,
    });
  });
});
