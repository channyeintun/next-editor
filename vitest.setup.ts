import "@testing-library/jest-dom";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installDmpCodec, instantiateDmpCodec } from "./src/storage/dmpCodec/dmpCodec";

// The recording codec's content delta requires the diff-match-patch WASM module.
// Vitest doesn't run Vite's WASM-ESM import, so install it synchronously from the
// built artifact's bytes. It is a reproducible build (`bun run build:wasm`); fail
// loudly with a clear instruction if it's missing rather than letting every codec
// test throw an opaque "dmp codec not loaded".
const dmpCodecPath = resolve(process.cwd(), "src/core/dmp/build/next-editor-dmp.wasm");
if (!existsSync(dmpCodecPath)) {
  throw new Error(
    `dmp codec artifact missing at ${dmpCodecPath}. Run \`bun run build:wasm\` before testing.`,
  );
}
installDmpCodec(await instantiateDmpCodec(readFileSync(dmpCodecPath)));

// jsdom does not implement Blob.prototype.arrayBuffer or Blob.prototype.stream,
// which real browsers (our Chromium target) provide. Polyfill them via FileReader
// so code under test can read uploaded File/Blob bytes the same way it does in
// production.
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

if (typeof Blob !== "undefined" && typeof Blob.prototype.stream !== "function") {
  Blob.prototype.stream = function stream(this: Blob): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      start: async (controller) => {
        try {
          const bytes = new Uint8Array(await this.arrayBuffer()) as Uint8Array<ArrayBuffer>;
          if (bytes.byteLength > 0) controller.enqueue(bytes);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  };
}
