import type { PostHog, Properties } from "posthog-js";
import { runWhenIdle } from "./idle";

// The app's only door to PostHog. posthog-js is ~105 KB gz, and as a static
// import of main.tsx it sat in the entry's blocking closure: every route
// downloaded it before any module ran, the route chunk request included. It
// now loads at idle after the first render (loadAnalyticsWhenIdle), and calls
// made before that queue here and replay, in order, once the client is up.
// The cost: session replay misses the first moments of a visit, and requests
// sent before init carry no X-POSTHOG-* tracing headers.

const LOAD_IDLE_TIMEOUT_MS = 2500;
// Both bounds only matter when the client never arrives (its chunk failed).
const MAX_QUEUED_CALLS = 100;
const MAX_BUFFERED_ERRORS = 20;

type PostHogCall = (posthog: PostHog) => void;
type UncaughtEvent = ErrorEvent | PromiseRejectionEvent;

let client: PostHog | null = null;
let unavailable = false;
const queuedCalls: PostHogCall[] = [];
const bufferedErrors: UncaughtEvent[] = [];

function withPostHog(call: PostHogCall): void {
  if (client) {
    call(client);
  } else if (!unavailable && queuedCalls.length < MAX_QUEUED_CALLS) {
    queuedCalls.push(call);
  }
}

export const analytics = {
  capture(event: string, properties?: Properties): void {
    withPostHog((posthog) => posthog.capture(event, properties));
  },
  captureException(error: unknown): void {
    withPostHog((posthog) => posthog.captureException(error));
  },
  identify(distinctId: string, properties?: Properties): void {
    withPostHog((posthog) => posthog.identify(distinctId, properties));
  },
  reset(): void {
    withPostHog((posthog) => posthog.reset());
  },
  startSessionRecording(): void {
    withPostHog((posthog) => posthog.startSessionRecording());
  },
  stopSessionRecording(): void {
    withPostHog((posthog) => posthog.stopSessionRecording());
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

/** Loads and initializes posthog-js once the main thread is idle. Call after rendering. */
export function loadAnalyticsWhenIdle(): void {
  runWhenIdle(() => {
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
  }, LOAD_IDLE_TIMEOUT_MS);
}
