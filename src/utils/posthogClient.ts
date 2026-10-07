import posthog, { type PostHog } from "posthog-js";
import { isLandingDemoFrame } from "./demoEmbedControls";
import { POSTHOG_REPLAY_PRIVACY_OPTIONS, sanitizePostHogEvent } from "./posthogExceptionFilter";

/** Imported on demand by analytics.ts, which explains why; nothing else imports posthog-js. */
export function initPostHog(): PostHog {
  posthog.init(import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN, {
    api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
    defaults: "2026-01-30",
    __add_tracing_headers: [window.location.host, "localhost"],
    // Uncaught errors/rejections anywhere in the app — the route error boundary
    // only sees render-path failures.
    capture_exceptions: true,
    before_send: (event) => sanitizePostHogEvent(event),
    // Replay blocking and console capture; see docs/observability-privacy.md.
    ...POSTHOG_REPLAY_PRIVACY_OPTIONS,
    // The landing page's hero demo is a second copy of the app in a frame. Its
    // pageviews and replay would double every landing visit; its exceptions
    // and events still report.
    ...(isLandingDemoFrame() ? { capture_pageview: false, disable_session_recording: true } : {}),
  });
  return posthog;
}
