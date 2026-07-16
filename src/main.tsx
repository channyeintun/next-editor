import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { loadDmpCodec } from "./storage/dmpCodec/dmpCodec";
import posthog from "posthog-js";
import { PostHogProvider } from "@posthog/react";
import {
  POSTHOG_SENSITIVE_SURFACE_SELECTOR,
  shouldSendPostHogEvent,
} from "./utils/posthogExceptionFilter";

posthog.init(import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN, {
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
  defaults: "2026-01-30",
  __add_tracing_headers: [window.location.host, "localhost"],
  // Uncaught errors/rejections anywhere in the app — the route error boundary
  // only sees render-path failures.
  capture_exceptions: true,
  before_send: (event) => (shouldSendPostHogEvent(event) ? event : null),
  session_recording: {
    // Workspace source, filenames, previews, runtime/agent/API output, slides,
    // recordings, and drawings must not land in third-party replays. The editor
    // root blocks the complete surface; the narrow selectors cover legacy embeds.
    // (docs/observability-integration-plan.md §9, decision 1).
    maskAllInputs: true,
    blockSelector: POSTHOG_SENSITIVE_SURFACE_SELECTOR,
  },
});

// Warm the diff-match-patch WASM codec that the recording encode/decode/replay
// paths require, so it's ready before the user starts recording.
void loadDmpCodec();

createRoot(document.getElementById("root")!).render(
  <PostHogProvider client={posthog}>
    <StrictMode>
      <App />
    </StrictMode>
  </PostHogProvider>,
);
