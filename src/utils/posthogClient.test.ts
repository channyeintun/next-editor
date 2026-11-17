import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { initPostHog, parentDomainCookieRemovals } from "./posthogClient";
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
      disable_surveys: true,
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

  it("keeps its cookies on the editor's own host, out of reach of the runtime's subdomains", () => {
    expect(initConfig()).toMatchObject({ cross_subdomain_cookie: false });
  });

  it("has exception autocapture in place before init, so PostHog never fetches it", () => {
    const extensions = () =>
      (window as { __PosthogExtensions__?: { errorWrappingFunctions?: Record<string, unknown> } })
        .__PosthogExtensions__;
    let wrappersAtInit: Record<string, unknown> | undefined;
    mocks.init.mockImplementationOnce(() => {
      wrappersAtInit = extensions()?.errorWrappingFunctions;
    });

    initPostHog();

    expect(wrappersAtInit).toMatchObject({
      wrapOnError: expect.any(Function),
      wrapUnhandledRejection: expect.any(Function),
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

describe("parentDomainCookieRemovals", () => {
  it("expires PostHog's identity cookie on every parent domain of the editor's host", () => {
    expect(
      parentDomainCookieRemovals("a=1; ph_phc_x_posthog=%7B%7D; other=2", "nexteditor.dev", true),
    ).toEqual([
      "ph_phc_x_posthog=; Domain=nexteditor.dev; Path=/; Max-Age=0; SameSite=Lax; Secure",
    ]);
    expect(parentDomainCookieRemovals("ph_t_posthog=1", "app.nexteditor.dev", false)).toEqual([
      "ph_t_posthog=; Domain=app.nexteditor.dev; Path=/; Max-Age=0; SameSite=Lax",
      "ph_t_posthog=; Domain=nexteditor.dev; Path=/; Max-Age=0; SameSite=Lax",
    ]);
  });

  it("touches nothing on a host without a parent domain, or without such a cookie", () => {
    expect(parentDomainCookieRemovals("ph_t_posthog=1", "localhost", false)).toEqual([]);
    expect(parentDomainCookieRemovals("a=1", "nexteditor.dev", true)).toEqual([]);
  });
});
