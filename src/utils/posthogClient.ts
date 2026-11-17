import posthog, { type PostHog } from "posthog-js";
// Exception autocapture, bundled. posthog-js otherwise fetches this extension
// from its CDN after init (median ~0.7 s desktop, ~1 s mobile), and analytics.ts
// stops buffering uncaught errors at init, so errors in that gap went nowhere.
// The IIFE registers itself on window.__PosthogExtensions__, where init finds
// it and attaches the window handlers at once. Same package, so same version.
import "posthog-js/dist/exception-autocapture";
import { isLandingDemoFrame } from "./demoEmbedControls";
import { POSTHOG_REPLAY_PRIVACY_OPTIONS, sanitizePostHogEvent } from "./posthogExceptionFilter";

/**
 * The `document.cookie` writes that expire PostHog identity cookies (`ph_<token>_posthog`)
 * an earlier version set on a parent domain of `hostname`: the runtime's hosts, its
 * subdomains, could still read them. Host-only cookies of the same name are left alone.
 */
export function parentDomainCookieRemovals(
  cookies: string,
  hostname: string,
  secure: boolean,
): string[] {
  const labels = hostname.split(".");
  const domains: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) {
    domains.push(labels.slice(i).join("."));
  }
  const names = new Set(
    cookies
      .split(";")
      .map((entry) => entry.split("=")[0].trim())
      .filter((name) => /^ph_.+_posthog$/.test(name)),
  );
  return [...names].flatMap((name) =>
    domains.map(
      (domain) =>
        `${name}=; Domain=${domain}; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`,
    ),
  );
}

/** Imported on demand by analytics.ts, which explains why; nothing else imports posthog-js. */
export function initPostHog(): PostHog {
  // A visitor from before host-only cookies gets a new anonymous id once.
  for (const removal of parentDomainCookieRemovals(
    document.cookie,
    window.location.hostname,
    window.location.protocol === "https:",
  )) {
    document.cookie = removal;
  }
  posthog.init(import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN, {
    api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
    defaults: "2026-01-30",
    // Host-only cookies. By default posthog-js sets them on the parent domain,
    // where the runtime's hosts (subdomains running lesson code) could read the
    // visitor's analytics id and session, or flip their tracking consent.
    cross_subdomain_cookie: false,
    __add_tracing_headers: [window.location.host, "localhost"],
    // Uncaught errors/rejections anywhere in the app — the route error boundary
    // only sees render-path failures.
    capture_exceptions: true,
    // Surveys are off in the project, but posthog-js still downloads its
    // surveys bundle (~33 KB br) when the remote config says false. Remove this
    // before launching a survey in PostHog.
    disable_surveys: true,
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
