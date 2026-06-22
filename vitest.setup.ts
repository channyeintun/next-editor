import "@testing-library/jest-dom";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installGoCodec, instantiateGoCodec } from "./src/storage/goCodec/goCodec";

// The recording codec now requires the Go (zstd + go-diff) WASM module. There is
// no fetch server under vitest, so install it synchronously from the built
// artifact. It is a reproducible build (`bun run build:wasm-go`); fail loudly
// with a clear instruction if it's missing rather than letting every codec test
// throw an opaque "Go codec not loaded".
const goCodecPath = resolve(process.cwd(), "public/next-editor-go.wasm");
if (!existsSync(goCodecPath)) {
  throw new Error(
    `Go codec artifact missing at ${goCodecPath}. Run \`bun run build:wasm-go\` before testing.`,
  );
}
installGoCodec(await instantiateGoCodec(readFileSync(goCodecPath)));

// jsdom does not implement Blob.prototype.arrayBuffer, which real browsers (our
// Chromium target) provide. Polyfill it via FileReader so code under test can
// read uploaded File/Blob bytes the same way it does in production.
if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}
