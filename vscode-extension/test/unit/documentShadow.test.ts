import { describe, expect, it } from "vitest";
import { DocumentShadow } from "../../src/capture/DocumentShadow";
import type { ContentChange } from "../../src/model/events";
import { sha256Hex } from "../../src/capture/hash";

function shadowOf(text: string, eol: "LF" | "CRLF" = "LF") {
  return new DocumentShadow(text, 1, eol, 0);
}

// VS Code delivers a transaction's changes with offsets valid against the
// evolving buffer when applied in array order (descending start offsets for
// multi-cursor edits). Apply the same way and compare.
function applyLikeVsCode(original: string, changes: ContentChange[]): string {
  let text = original;
  for (const change of changes) {
    text =
      text.slice(0, change.rangeOffsetUtf16) +
      change.text +
      text.slice(change.rangeOffsetUtf16 + change.rangeLengthUtf16);
  }
  return text;
}

describe("DocumentShadow", () => {
  it("applies a simple insert", () => {
    const shadow = shadowOf("hello world");
    const changes = [{ rangeOffsetUtf16: 5, rangeLengthUtf16: 0, text: "," }];
    const result = shadow.applyTransaction(changes, 2, "hello, world", "LF");
    expect(result.ok).toBe(true);
    expect(shadow.text).toBe("hello, world");
    expect(shadow.sha256).toBe(sha256Hex("hello, world"));
  });

  it("applies a multi-cursor transaction in array order (descending offsets)", () => {
    const original = "aaa\nbbb\nccc";
    const changes = [
      { rangeOffsetUtf16: 8, rangeLengthUtf16: 0, text: "3" },
      { rangeOffsetUtf16: 4, rangeLengthUtf16: 0, text: "2" },
      { rangeOffsetUtf16: 0, rangeLengthUtf16: 0, text: "1" },
    ];
    const expected = applyLikeVsCode(original, changes);
    const shadow = shadowOf(original);
    const result = shadow.applyTransaction(changes, 2, expected, "LF");
    expect(result.ok).toBe(true);
    expect(shadow.text).toBe("1aaa\n2bbb\n3ccc");
  });

  it("handles surrogate pairs with UTF-16 offsets", () => {
    const original = "a😀b"; // 😀 is two UTF-16 code units
    expect(original.length).toBe(4);
    const changes = [{ rangeOffsetUtf16: 3, rangeLengthUtf16: 1, text: "X" }];
    const expected = "a😀X";
    const shadow = shadowOf(original);
    const result = shadow.applyTransaction(changes, 2, expected, "LF");
    expect(result.ok).toBe(true);
    expect(shadow.text).toBe(expected);
  });

  it("handles combining characters", () => {
    const original = "éclair"; // e + combining acute
    const changes = [{ rangeOffsetUtf16: 2, rangeLengthUtf16: 0, text: "-" }];
    const expected = "é-clair";
    const shadow = shadowOf(original);
    expect(shadow.applyTransaction(changes, 2, expected, "LF").ok).toBe(true);
    expect(shadow.text).toBe(expected);
  });

  it("handles CRLF documents", () => {
    const original = "one\r\ntwo\r\n";
    const changes = [{ rangeOffsetUtf16: 5, rangeLengthUtf16: 3, text: "2" }];
    const expected = "one\r\n2\r\n";
    const shadow = shadowOf(original, "CRLF");
    expect(shadow.applyTransaction(changes, 2, expected, "CRLF").ok).toBe(true);
    expect(shadow.text).toBe(expected);
  });

  it("rewrites line endings for an EOL-only transaction", () => {
    const shadow = shadowOf("a\nb\nc");
    const expected = "a\r\nb\r\nc";
    const result = shadow.applyTransaction([], 2, expected, "CRLF");
    expect(result.ok).toBe(true);
    expect(shadow.text).toBe(expected);
    expect(shadow.eol).toBe("CRLF");
  });

  it("detects content mismatch and resets to observed state", () => {
    const shadow = shadowOf("abc");
    const changes = [{ rangeOffsetUtf16: 0, rangeLengthUtf16: 1, text: "X" }];
    const result = shadow.applyTransaction(changes, 2, "totally different", "LF");
    expect(result).toMatchObject({ ok: false, code: "content-mismatch" });
    // Reset to observed VS Code state (plan §8.4.8).
    expect(shadow.text).toBe("totally different");
    expect(shadow.version).toBe(2);
  });

  it("detects out-of-bounds ranges", () => {
    const shadow = shadowOf("abc");
    const changes = [{ rangeOffsetUtf16: 2, rangeLengthUtf16: 5, text: "X" }];
    const result = shadow.applyTransaction(changes, 2, "abX", "LF");
    expect(result).toMatchObject({ ok: false, code: "range-out-of-bounds" });
  });

  it("rejects non-increasing versions", () => {
    const shadow = shadowOf("abc");
    const result = shadow.applyTransaction([], 1, "abc", "LF");
    expect(result).toMatchObject({ ok: false, code: "version-mismatch" });
  });

  it("randomized non-overlapping multi-change transactions replay exactly", () => {
    // Deterministic PRNG so failures are reproducible.
    let state = 42;
    const rand = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const alphabet = ["a", "b", "\n", "😀", "é", "日", "\t", "z"];
    const randomText = (length: number) =>
      Array.from({ length }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");

    for (let round = 0; round < 200; round++) {
      const original = randomText(Math.floor(rand() * 80));
      const shadow = shadowOf(original);

      // Build non-overlapping ranges, then apply descending like VS Code.
      // Bounded draw count: short documents simply yield fewer ranges.
      const cuts = new Set<number>();
      const changeCount = 1 + Math.floor(rand() * 4);
      for (let draw = 0; draw < changeCount * 8 && cuts.size < changeCount * 2; draw++) {
        cuts.add(Math.floor(rand() * (original.length + 1)));
      }
      const sorted = [...cuts].sort((a, b) => a - b);
      const ranges: { start: number; end: number }[] = [];
      for (let i = 0; i + 1 < sorted.length; i += 2) {
        ranges.push({ start: sorted[i] ?? 0, end: sorted[i + 1] ?? 0 });
      }
      const changes: ContentChange[] = ranges
        .sort((a, b) => b.start - a.start)
        .map(({ start, end }) => ({
          rangeOffsetUtf16: start,
          rangeLengthUtf16: end - start,
          text: randomText(Math.floor(rand() * 6)),
        }));

      const expected = applyLikeVsCode(original, changes);
      const result = shadow.applyTransaction(changes, 2, expected, "LF");
      expect(result.ok).toBe(true);
      expect(shadow.text).toBe(expected);
      expect(shadow.sha256).toBe(sha256Hex(expected));
    }
  });
});
