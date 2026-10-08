import { describe, expect, it } from "vite-plus/test";
import { applyContentDelta, createAppendContentDelta, createContentDelta } from "./contentDelta";
import { DmpBaseMismatchError } from "../../dmp/dmpCodec";

describe("content deltas", () => {
  it("round-trips content deltas, including multi-byte UTF-8 edits", () => {
    const cases: Array<[string, string]> = [
      ["éx", "èy"],
      ["éa", "ĩa"],
      ["const label = 'a';", "const label = '漢';"],
      // Scattered, non-contiguous edits — the case the prefix/suffix model bloated.
      ["alpha\nbravo\ncharlie\ndelta\n", "ALPHA\nbravo\ncharlie\nDELTA\n"],
    ];

    for (const [prev, next] of cases) {
      const delta = createContentDelta(prev, next);
      expect(delta).not.toBeNull();
      expect(delta!.delta).toBeInstanceOf(Uint8Array);
      expect(applyContentDelta(prev, delta!)).toBe(next);
    }
  });

  it("returns null when content is unchanged", () => {
    expect(createContentDelta("same", "same")).toBeNull();
  });

  it("encodes append-only text as one codec-compatible suffix delta", () => {
    const base = "existing streamed response ".repeat(8);
    const appended = "plus a final 🌍 suffix";
    const created = createAppendContentDelta(base, appended);
    expect(created).not.toBeNull();
    if (!created) throw new Error("Expected an append-only content delta");

    const appendedBytes = new TextEncoder().encode(appended);
    expect(applyContentDelta(base, created)).toBe(base + appended);
    expect(created.delta.byteLength).toBeLessThan(new TextEncoder().encode(base + appended).length);
    expect(Array.from(created.delta.slice(-appendedBytes.byteLength))).toEqual(
      Array.from(appendedBytes),
    );
    expect(createAppendContentDelta(base, "")).toBeNull();
    expect(() => applyContentDelta(`${base}!`, created)).toThrow(DmpBaseMismatchError);

    const splitSurrogateBase = "split emoji: \ud83c";
    const splitSurrogateSuffix = "\udf0d";
    expect(createAppendContentDelta(splitSurrogateBase, splitSurrogateSuffix)).toBeNull();
    const fallback = createContentDelta(
      splitSurrogateBase,
      splitSurrogateBase + splitSurrogateSuffix,
    );
    expect(fallback).not.toBeNull();
    if (!fallback) throw new Error("Expected a split-surrogate fallback delta");
    expect(applyContentDelta("split emoji: �", fallback)).toBe("split emoji: 🌍");
  });
});
