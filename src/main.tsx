import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { loadGoCodec } from "./storage/goCodec/goCodec";

// Warm the Go codec (zstd + go-diff) that the recording encode/decode/replay
// paths require, so it's ready before the user starts recording.
void loadGoCodec();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
