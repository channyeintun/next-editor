import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DmpBaseMismatchError, instantiateDmpCodec } from "./dmpCodec";

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

  it("emits a mandatory CHECK op as the first op of every delta", async () => {
    const codec = await load();
    const delta = codec.diffDelta(enc.encode("same"), enc.encode("same"));
    // tag = (hashLen << 2) | CHECK = (4 << 2) | 3 = 0x13, then 4 hash bytes.
    expect(delta[0]).toBe(0x13);
    expect(delta.length).toBeGreaterThanOrEqual(5);
  });

  it("rejects applying a delta to a same-length wrong base (the silent-corruption case)", async () => {
    const codec = await load();
    const base = enc.encode("The quick brown fox jumps over the lazy dog");
    const wrongBase = enc.encode("The quick brown fox jumps over the lazy cat");
    const delta = codec.diffDelta(base, enc.encode("The quick brown fox JUMPED over the lazy dog"));

    expect(wrongBase.length).toBe(base.length);
    expect(() => codec.applyDelta(wrongBase, delta)).toThrow(DmpBaseMismatchError);
    expect(() => codec.applyDelta(wrongBase, delta)).toThrow(/base mismatch/);
  });

  it("rejects a delta missing its CHECK op (pre-check-op format)", async () => {
    const codec = await load();
    // A bare EQUAL op copying the whole 3-byte source: tag = (3 << 2) | 0.
    const legacyDelta = new Uint8Array([3 << 2]);
    expect(() => codec.applyDelta(enc.encode("abc"), legacyDelta)).toThrow(DmpBaseMismatchError);
    // An empty delta is also no longer valid — every delta carries a CHECK head.
    expect(() => codec.applyDelta(new Uint8Array(0), new Uint8Array(0))).toThrow(/applyDelta/);
  });

  it("property: random edits round-trip; equal-length wrong bases always fail", async () => {
    const codec = await load();
    // Deterministic LCG so failures are reproducible.
    let seed = 0xdecafbad;
    const rand = (max: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % max;
    };
    const alphabet = "abcdefghij\nãé☕";

    for (let round = 0; round < 50; round++) {
      const baseLen = 1 + rand(400);
      let base = "";
      for (let i = 0; i < baseLen; i++) base += alphabet[rand(alphabet.length)];

      // Random scattered edits.
      let target = base;
      for (let edits = 0; edits <= rand(4); edits++) {
        const at = rand(target.length + 1);
        const del = rand(Math.min(8, target.length - at + 1));
        let ins = "";
        for (let i = 0; i < rand(8); i++) ins += alphabet[rand(alphabet.length)];
        target = target.slice(0, at) + ins + target.slice(at + del);
      }

      const a = enc.encode(base);
      const b = enc.encode(target);
      const delta = codec.diffDelta(a, b);
      expect(dec.decode(codec.applyDelta(a, delta))).toBe(target);

      // Same-length corrupted base must be rejected, not silently applied.
      // (`baseLen` is always ≥ 1, so there is always a byte to corrupt.)
      const wrong = a.slice();
      wrong[rand(wrong.length)] ^= 0x01;
      expect(() => codec.applyDelta(wrong, delta)).toThrow(DmpBaseMismatchError);
    }
  });

  it("bounds a bulk structural edit instead of stalling the recorder", async () => {
    const codec = await load();
    // Myers is O(N·D): a large document that changes *throughout* (rename-all,
    // reformat, agent rewrite) used to run unbounded — 16s for this input, on
    // the thread that records frames. WORK_BUDGET caps it (src/core/dmp/src/lib.rs).
    const base = Array.from(
      { length: 10_000 },
      (_, i) => `  const value${i} = compute(input${i}, ${i});`,
    ).join("\n");
    const target = base.replaceAll("value", "result");

    const a = enc.encode(base);
    const b = enc.encode(target);

    const started = performance.now();
    const delta = codec.diffDelta(a, b);
    const elapsed = performance.now() - started;

    // Budget is ~200ms of diff; allow generous slack for slow/loaded CI while
    // still failing loudly if the bound is ever removed (unbounded is ~16s).
    expect(elapsed).toBeLessThan(3_000);
    // Degrading to a replace must stay *correct* — only the delta gets bigger.
    expect(dec.decode(codec.applyDelta(a, delta))).toBe(target);
  });
});
