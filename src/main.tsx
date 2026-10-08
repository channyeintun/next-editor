import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { hydrateServerQueryState } from "./queryClient";
import { loadDmpCodec } from "./core/dmp/dmpCodec";
import { analytics, bufferEarlyErrors, loadAnalyticsWhenIdle } from "./utils/analytics";
import { installPerformanceMetricsReporter } from "./utils/performanceMetrics";

// PostHog itself loads after the first render (loadAnalyticsWhenIdle, below).
bufferEarlyErrors();

installPerformanceMetricsReporter((metrics) => {
  analytics.capture("performance_metrics", { metrics });
});

// Warm the diff-match-patch WASM codec that the recording encode/decode/replay
// paths require, so it's ready before the user starts recording. A failure here
// is not silent: `START_RECORDING` refuses to start without the codec (see
// editorMachine's isDmpCodecMissing guard), because building a content delta
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
  <StrictMode>
    <App />
  </StrictMode>
);

if (root.dataset.ssr === "landing") {
  hydrateRoot(root, app);
} else {
  createRoot(root).render(app);
}

loadAnalyticsWhenIdle();
