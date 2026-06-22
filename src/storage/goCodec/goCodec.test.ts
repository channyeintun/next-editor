import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { instantiateGoCodec } from "./goCodec";

// The Go codec is a reproducible build artifact (`bun run build:wasm-go`) and is
// gitignored, so skip rather than fail when it hasn't been built locally/in CI.
// Resolve from the project root (vitest cwd); import.meta.url isn't a file: URL
// under the test transform.
const wasmPath = resolve(process.cwd(), "public/next-editor-go.wasm");
const hasArtifact = existsSync(wasmPath);

const enc = new TextEncoder();
const dec = new TextDecoder();

describe.skipIf(!hasArtifact)("Go codec (via hand-written WASI shim, not node:wasi)", () => {
  const load = () => instantiateGoCodec(readFileSync(wasmPath));

  it("zstd round-trips and beats the raw size on compressible input", async () => {
    const codec = await load();
    const text = "export function value() { return 42; }\n".repeat(2000);
    const input = enc.encode(text);

    const compressed = codec.zstdCompress(input);
    expect(compressed.length).toBeLessThan(input.length);
    expect(dec.decode(codec.zstdDecompress(compressed))).toBe(text);
  });

  it("zstd handles empty input", async () => {
    const codec = await load();
    const compressed = codec.zstdCompress(new Uint8Array(0));
    expect(codec.zstdDecompress(compressed).length).toBe(0);
  });

  it("go-diff delta reconstructs the target, including scattered edits", async () => {
    const codec = await load();
    const base = "line alpha\nline bravo\nline charlie\nline delta\nline echo\n".repeat(100);
    // Two edits far apart — the case where the affix model degenerates.
    const target = `X${base.slice(1, base.length - 1)}Y`;

    const a = enc.encode(base);
    const b = enc.encode(target);
    const delta = codec.diffDelta(a, b);

    expect(delta.length).toBeLessThan(b.length); // delta is compact, not a keyframe
    expect(dec.decode(codec.applyDelta(a, delta))).toBe(target);
  });

  it("throws on a corrupt zstd frame rather than returning garbage", async () => {
    const codec = await load();
    expect(() => codec.zstdDecompress(enc.encode("not a zstd frame"))).toThrow(
      /zstdDecompress failed/,
    );
  });
});
