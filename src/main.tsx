import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { loadDmpCodec } from "./storage/dmpCodec/dmpCodec";
import posthog from "posthog-js";
import { PostHogProvider } from "@posthog/react";

posthog.init(import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN, {
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
  defaults: "2026-01-30",
  __add_tracing_headers: [window.location.host, "localhost"],
  // Uncaught errors/rejections anywhere in the app — the route error boundary
  // only sees render-path failures.
  capture_exceptions: true,
  session_recording: {
    // Users' code and drawings must not land in third-party replays: block
    // Monaco and Excalidraw wholesale, mask every input
    // (docs/observability-integration-plan.md §9, decision 1).
    maskAllInputs: true,
    blockSelector: ".monaco-editor, .excalidraw",
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
