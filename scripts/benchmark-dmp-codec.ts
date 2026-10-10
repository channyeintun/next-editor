// Benchmarks the Rust diff-match-patch codec against the prefix/suffix
// ("affix") content-delta model it replaced, on recording-shaped payloads.
//
//   * diff-match-patch DiffToDelta vs the affix prefix/suffix model
//     (the old core/src/utils/frameDelta.ts ContentDelta).
//
// Run: bun scripts/benchmark-dmp-codec.ts
//
// It reports delta size (the thing that matters for recordings) and asserts
// every delta round-trips, so a regression fails loudly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { instantiateDmpCodec } from "../src/core/dmp/dmpCodec.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const fmt = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
const kb = (bytes: number) => `${fmt(bytes / 1024)} KB`;

// ---------------------------------------------------------------------------
// Instantiate the zero-import codec from its bytes through the app's own
// binding, so the benchmark measures exactly the ABI the recorder uses.
// ---------------------------------------------------------------------------
const wasmPath = fileURLToPath(
  new URL("../src/core/dmp/build/next-editor-dmp.wasm", import.meta.url),
);
const codec = await instantiateDmpCodec(readFileSync(wasmPath));

// ---------------------------------------------------------------------------
// Affix (prefix/suffix) ContentDelta — the model frameDelta.ts used before.
// Serialized footprint = 4 (prefixLen) + 4 (suffixLen) + insert bytes.
// ---------------------------------------------------------------------------
interface AffixDelta {
  prefixLen: number;
  suffixLen: number;
  insert: string;
}

function affixDelta(prev: string, next: string): AffixDelta {
  if (prev === next) return { prefixLen: 0, suffixLen: 0, insert: "" };
  const min = Math.min(prev.length, next.length);
  let p = 0;
  while (p < min && prev[p] === next[p]) p++;
  let s = 0;
  while (s < min - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  return { prefixLen: p, suffixLen: s, insert: next.slice(p, next.length - s) };
}
const affixDeltaBytes = (d: AffixDelta) => 8 + enc.encode(d.insert).length;
const applyAffix = (base: string, d: AffixDelta) =>
  base.slice(0, d.prefixLen) + d.insert + base.slice(base.length - d.suffixLen);

// ---------------------------------------------------------------------------
function makeCodeDoc(targetBytes: number): string {
  let out = "";
  let i = 0;
  while (out.length < targetBytes) {
    out += `export function value${i}() { return ${i % 997}; }\n`;
    i++;
  }
  return out;
}
function replaceAt(s: string, index: number, removeLen: number, insert: string): string {
  return s.slice(0, index) + insert + s.slice(index + removeLen);
}

const code = makeCodeDoc(100 * 1024);
const cases = [
  { name: "single middle edit", prev: code, next: replaceAt(code, code.length >> 1, 8, "CHANGED") },
  { name: "append tail", prev: code, next: `${code}export const extra = 1;\n` },
  {
    name: "scattered: head + tail edit",
    prev: code,
    next: replaceAt(replaceAt(code, code.length - 40, 4, "ZZZ"), 40, 4, "AAA"),
  },
  {
    name: "scattered: 5 edits spread out",
    prev: code,
    next: (() => {
      let s = code;
      for (let k = 1; k <= 5; k++) s = replaceAt(s, Math.floor((code.length * k) / 6), 3, `Q${k}Q`);
      return s;
    })(),
  },
];

console.log("\n# Content delta: diff-match-patch (Rust) vs affix model\n");
const rows = [];
for (const c of cases) {
  const aBytes = enc.encode(c.prev);
  const bBytes = enc.encode(c.next);

  const affix = affixDelta(c.prev, c.next);
  if (applyAffix(c.prev, affix) !== c.next) throw new Error(`${c.name}: affix apply failed`);

  const dmp = codec.diffDelta(aBytes, bBytes);
  if (dec.decode(codec.applyDelta(aBytes, dmp)) !== c.next)
    throw new Error(`${c.name}: dmp apply failed`);

  rows.push({
    case: c.name,
    "affix delta": kb(affixDeltaBytes(affix)),
    "dmp delta": kb(dmp.length),
    "dmp vs affix": `${fmt((dmp.length / affixDeltaBytes(affix)) * 100)}%`,
  });
}
console.table(rows);
console.log("All deltas round-tripped ✓\n");
