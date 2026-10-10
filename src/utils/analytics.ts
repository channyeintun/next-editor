import type { PostHog, Properties } from "posthog-js";
import { runWhenIdle } from "./idle";

// The app's only door to PostHog. posthog-js is ~105 KB gz, and as a static
// import of main.tsx it sat in the entry's blocking closure: every route
// downloaded it before any module ran, the route chunk request included. It
// now loads at idle after the first render (loadAnalyticsWhenIdle), and calls
// made before that queue here and replay, in order, once the client is up.
// The cost: session replay misses the first moments of a visit, and requests
// sent before init carry no X-POSTHOG-* tracing headers.
//
// Idle is a CPU signal, though. On the editor routes and the gallery the main
// thread goes idle while the page's own critical download is still on the
// wire (Monaco's ~1 MB chunk, the first row of thumbnails), and PostHog's
// ~145 KB then took a share of the bandwidth: on slow 4G, Monaco painted
// 0.7-0.9 s later. Those routes hand that download to deferAnalyticsUntil.

const LOAD_IDLE_TIMEOUT_MS = 2500;
// The longest deferAnalyticsUntil holds the load, counted from navigation
// start. Monaco's chunk finishes 10-14 s in on slow 4G, so a shorter cap would
// start PostHog inside that download again. A visit that ends before the load
// sends no pageview; Cloudflare's Web Analytics beacon still reports its Web
// Vitals.
const MAX_DEFERRAL_MS = 20_000;
// Both bounds only matter when the client never arrives (its chunk failed).
const MAX_QUEUED_CALLS = 100;
const MAX_BUFFERED_ERRORS = 20;

type PostHogCall = (posthog: PostHog) => void;
type UncaughtEvent = ErrorEvent | PromiseRejectionEvent;

let client: PostHog | null = null;
let unavailable = false;
let loadStarted = false;
const queuedCalls: PostHogCall[] = [];
const bufferedErrors: UncaughtEvent[] = [];
const deferrals: Promise<void>[] = [];
// Set once something can't wait for the deferrals; ends a wait in progress.
let deferralsCut = false;
let endDeferralWait: (() => void) | null = null;

function cutDeferralsShort(): void {
  deferralsCut = true;
  endDeferralWait?.();
}

/**
 * `sendsEvent`: the call reports something (an event or an exception), so the
 * client loads now rather than after the deferred downloads; a visit that
 * ends meanwhile would lose it. Calls that only set state (identity, replay)
 * apply whenever the client arrives.
 */
function withPostHog(call: PostHogCall, sendsEvent: boolean): void {
  if (client) {
    call(client);
  } else if (!unavailable && queuedCalls.length < MAX_QUEUED_CALLS) {
    queuedCalls.push(call);
    if (sendsEvent) cutDeferralsShort();
  }
}

export const analytics = {
  capture(event: string, properties?: Properties): void {
    withPostHog((posthog) => posthog.capture(event, properties), true);
  },
  captureException(error: unknown): void {
    withPostHog((posthog) => posthog.captureException(error), true);
  },
  identify(distinctId: string, properties?: Properties): void {
    withPostHog((posthog) => posthog.identify(distinctId, properties), false);
  },
  reset(): void {
    withPostHog((posthog) => posthog.reset(), false);
  },
  startSessionRecording(): void {
    withPostHog((posthog) => posthog.startSessionRecording(), false);
  },
  stopSessionRecording(): void {
    withPostHog((posthog) => posthog.stopSessionRecording(), false);
  },
};

function bufferUncaught(event: UncaughtEvent): void {
  if (bufferedErrors.length < MAX_BUFFERED_ERRORS) bufferedErrors.push(event);
}

function stopBufferingErrors(): void {
  window.removeEventListener("error", bufferUncaught);
  window.removeEventListener("unhandledrejection", bufferUncaught);
}

/**
 * PostHog's exception autocapture (`capture_exceptions`) only exists once the
 * client has loaded, so until then uncaught errors and rejections are held
 * here and reported when it arrives. Call before rendering.
 */
export function bufferEarlyErrors(): void {
  window.addEventListener("error", bufferUncaught);
  window.addEventListener("unhandledrejection", bufferUncaught);
}

/**
 * Holds PostHog's load back until `work` settles, whether it succeeds or not:
 * for a route's critical download, which PostHog would otherwise share the
 * network with. Call it when the route starts loading, before the first idle
 * moment. The wait ends at MAX_DEFERRAL_MS after navigation start at the
 * latest, and sooner when an event needs sending or the page is hidden.
 * Without effect once the load has started.
 */
export function deferAnalyticsUntil(work: Promise<unknown>): void {
  const settled = work.then(
    () => {},
    () => {},
  );
  if (!loadStarted) deferrals.push(settled);
}

async function allDeferralsSettled(): Promise<void> {
  // A deferral added during the wait (a quick click through to an editor
  // route) extends it, within the same cap.
  for (let waited = 0; waited < deferrals.length;) {
    const pending = deferrals.slice(waited);
    waited = deferrals.length;
    await Promise.all(pending);
  }
}

function waitForDeferrals(): Promise<void> {
  return new Promise((resolve) => {
    const cap = window.setTimeout(
      () => endDeferralWait?.(),
      Math.max(0, MAX_DEFERRAL_MS - performance.now()),
    );
    // A hidden page is one nobody is waiting on, and often a visit ending:
    // the queued events (performance metrics flush on hide) get their chance.
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") cutDeferralsShort();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    endDeferralWait = () => {
      endDeferralWait = null;
      window.clearTimeout(cap);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resolve();
    };
    void allDeferralsSettled().then(() => endDeferralWait?.());
  });
}

function loadClient(): void {
  import("./posthogClient")
    .then(({ initPostHog }) => {
      const posthog = initPostHog();
      client = posthog;
      stopBufferingErrors();
      // captureException unwraps an ErrorEvent or PromiseRejectionEvent the
      // way PostHog's own window handlers do, and before_send still applies.
      for (const event of bufferedErrors.splice(0)) posthog.captureException(event);
      for (const call of queuedCalls.splice(0)) call(posthog);
    })
    .catch((error: unknown) => {
      unavailable = true;
      stopBufferingErrors();
      bufferedErrors.length = 0;
      queuedCalls.length = 0;
      console.warn("Analytics failed to load", error);
    });
}

/**
 * Loads and initializes posthog-js once the main thread is idle, after any
 * deferAnalyticsUntil work. Call after rendering. The deferrals are read at
 * that first idle moment, so browsers without requestIdleCallback, whose idle
 * is a one-tick timer, wait for them too.
 */
export function loadAnalyticsWhenIdle(): void {
  runWhenIdle(() => {
    loadStarted = deferralsCut || deferrals.length === 0;
    if (loadStarted) {
      loadClient();
      return;
    }
    void waitForDeferrals().then(() => {
      loadStarted = true;
      runWhenIdle(loadClient, LOAD_IDLE_TIMEOUT_MS);
    });
  }, LOAD_IDLE_TIMEOUT_MS);
}
