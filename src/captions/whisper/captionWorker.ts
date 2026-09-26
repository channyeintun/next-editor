import { expose } from "comlink";
// The WASM-only build of ONNX Runtime, as the studio's pocket-tts uses.
import * as ort from "onnxruntime-web/wasm";
// Self-hosted loader pair, served as assets (no CDN).
import ortWasmMjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { loadWhisperAssets } from "./whisperAssets";
import { transcribeWithWhisper, type Transcript } from "./whisperTranscriber";

// ============================================================================
// Captioning runs here, off the page: model download, features, and decoding.
// One thread: this worker is already off the main thread, and ONNX Runtime's
// own pthread workers would re-run this bundle (see the "ort" chunk group in
// vite.config.ts for why that breaks).
// ============================================================================

export interface CaptionWorkerRequest {
  /** 16 kHz mono samples; transferred. */
  samples: Float32Array;
  language?: string;
  prompt?: string;
}

export type CaptionWorkerProgress =
  | { phase: "model"; loadedBytes: number; totalBytes: number }
  | { phase: "transcribe"; doneSeconds: number; totalSeconds: number };

ort.env.wasm.wasmPaths = { mjs: ortWasmMjs, wasm: ortWasm };
ort.env.wasm.numThreads = 1;

const api = {
  async transcribe(
    request: CaptionWorkerRequest,
    onProgress: (progress: CaptionWorkerProgress) => void,
  ): Promise<Transcript> {
    const assets = await loadWhisperAssets((loadedBytes, totalBytes) =>
      onProgress({ phase: "model", loadedBytes, totalBytes }),
    );
    const transcript = await transcribeWithWhisper(ort, assets, request.samples, {
      language: request.language,
      prompt: request.prompt,
      onProgress: (doneSeconds, totalSeconds) =>
        onProgress({ phase: "transcribe", doneSeconds, totalSeconds }),
    });
    return transcript;
  },
};

export type CaptionWorkerApi = typeof api;

expose(api);
