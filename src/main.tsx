import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { hydrateServerQueryState } from "./queryClient";
import { loadDmpCodec } from "./storage/dmpCodec/dmpCodec";
import posthog from "posthog-js";
import { PostHogProvider } from "@posthog/react";
import {
  POSTHOG_REPLAY_PRIVACY_OPTIONS,
  sanitizePostHogEvent,
} from "./utils/posthogExceptionFilter";
import { installPerformanceMetricsReporter } from "./utils/performanceMetrics";

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
});

installPerformanceMetricsReporter((metrics) => {
  posthog.capture("performance_metrics", { metrics });
});

// Warm the diff-match-patch WASM codec that the recording encode/decode/replay
// paths require, so it's ready before the user starts recording. A failure here
// is not silent: `START_RECORDING` refuses to start without the codec (see
// editorMachine's isDmpCodecReady guard), because building a content delta
// without it throws inside an xstate assign, which stops the actor and loses the
// whole in-progress session.
void loadDmpCodec().catch((error: unknown) => {
  console.error("Failed to load the recording codec", error);
});

// Before the first render, so a server-resolved query is already in the cache
// when the route that needs it mounts (and never fetches for itself).
hydrateServerQueryState();

const root = document.getElementById("root")!;
const app = (
  <PostHogProvider client={posthog}>
    <StrictMode>
      <App />
    </StrictMode>
  </PostHogProvider>
);

if (root.dataset.ssr === "landing") {
  hydrateRoot(root, app);
} else {
  createRoot(root).render(app);
}
