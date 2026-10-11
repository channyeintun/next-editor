// The studio self-hosts onnxruntime-web's threaded-wasm loader pair (no CDN).
// `?url` keeps them as served assets, outside vite-plugin-wasm's path. Kept
// apart from engine.ts so tests can stand in for these asset imports.
export { default as ortWasmThreadedMjs } from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
export { default as ortWasmThreadedWasm } from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
