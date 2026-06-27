import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { instantiateDmpCodec } from "./dmpCodec";

// The dmp codec is a reproducible build artifact (`bun run build:wasm`) and is
// gitignored, so skip rather than fail when it hasn't been built locally/in CI.
// Resolve from the project root (vitest cwd); import.meta.url isn't a file: URL
// under the test transform.
const wasmPath = resolve(process.cwd(), "src/core/dmp/build/next-editor-dmp.wasm");
const hasArtifact = existsSync(wasmPath);

const enc = new TextEncoder();
const dec = new TextDecoder();

describe.skipIf(!hasArtifact)("dmp codec (diff-match-patch in Rust)", () => {
  const load = () => instantiateDmpCodec(readFileSync(wasmPath));

  it("round-trips a single contiguous edit with a compact delta", async () => {
    const codec = await load();
    const base = "export function value() { return 42; }\n".repeat(500);
    const target = base.replace("return 42", "return 1337");

    const a = enc.encode(base);
    const b = enc.encode(target);
    const delta = codec.diffDelta(a, b);

    expect(delta.length).toBeLessThan(b.length);
    expect(dec.decode(codec.applyDelta(a, delta))).toBe(target);
  });

  it("stays compact across scattered, non-contiguous edits", async () => {
    const codec = await load();
    const base = "line alpha\nline bravo\nline charlie\nline delta\nline echo\n".repeat(100);
    // Two edits far apart — the case where the affix model degenerated to a near-keyframe.
    const target = `X${base.slice(1, base.length - 1)}Y`;

    const a = enc.encode(base);
    const b = enc.encode(target);
    const delta = codec.diffDelta(a, b);

    // A handful of bytes, not a whole keyframe.
    expect(delta.length).toBeLessThan(64);
    expect(dec.decode(codec.applyDelta(a, delta))).toBe(target);
  });

  it("handles empty and full-replacement inputs", async () => {
    const codec = await load();
    const empty = new Uint8Array(0);

    expect(codec.applyDelta(empty, codec.diffDelta(empty, empty)).length).toBe(0);
    expect(dec.decode(codec.applyDelta(empty, codec.diffDelta(empty, enc.encode("hello"))))).toBe(
      "hello",
    );
    expect(
      codec.applyDelta(enc.encode("hello"), codec.diffDelta(enc.encode("hello"), empty)).length,
    ).toBe(0);
    expect(
      dec.decode(
        codec.applyDelta(
          enc.encode("aaaa"),
          codec.diffDelta(enc.encode("aaaa"), enc.encode("bbbb")),
        ),
      ),
    ).toBe("bbbb");
  });

  it("preserves multi-byte UTF-8 across edits", async () => {
    const codec = await load();
    const base = "café ☕ naïve — résumé";
    const target = "café ☕ NAÏVE — résumé!";
    const delta = codec.diffDelta(enc.encode(base), enc.encode(target));
    expect(dec.decode(codec.applyDelta(enc.encode(base), delta))).toBe(target);
  });

  it("throws on a corrupt/mismatched delta rather than returning garbage", async () => {
    const codec = await load();
    // A delta whose ops claim more source than `a` provides must fail loudly.
    expect(() => codec.applyDelta(enc.encode("abc"), new Uint8Array([0xff, 0xff, 0xff]))).toThrow(
      /applyDelta failed/,
    );
  });
});
