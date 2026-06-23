// Benchmarks the AssemblyScript diff-match-patch codec against the prefix/suffix
// ("affix") content-delta model it replaced, on recording-shaped payloads.
//
//   * diff-match-patch DiffToDelta vs the affix prefix/suffix model
//     (the old core/src/utils/frameDelta.ts ContentDelta).
//
// Run: node scripts/benchmark-dmp-codec.mjs
//
// It reports delta size (the thing that matters for recordings) and asserts
// every delta round-trips, so a regression fails loudly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const enc = new TextEncoder();
const dec = new TextDecoder();
const fmt = (n) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
const kb = (bytes) => `${fmt(bytes / 1024)} KB`;

// ---------------------------------------------------------------------------
// Load the zero-import codec directly (no fetch/import object needed).
// ---------------------------------------------------------------------------
const wasmPath = fileURLToPath(
  new URL("../src/core/assembly/build/next-editor-dmp.wasm", import.meta.url),
);
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const ex = instance.exports;
const ERROR = 0xffffffffffffffffn;
const u8 = () => new Uint8Array(ex.memory.buffer);
const write = (a) => {
  const p = ex.alloc(a.length || 1);
  u8().set(a, p);
  return p;
};
const read = (packed, label) => {
  const v = BigInt.asUintN(64, packed);
  if (v === ERROR) throw new Error(`${label} failed`);
  const ptr = Number(v >> 32n);
  const len = Number(v & 0xffffffffn);
  if (ptr === 0) return new Uint8Array(0);
  const out = u8().slice(ptr, ptr + len);
  ex.freeBuf(ptr);
  return out;
};
const diffDelta = (a, b) => {
  const pa = write(a);
  const pb = write(b);
  try {
    return read(ex.diffDelta(pa, a.length, pb, b.length), "diffDelta");
  } finally {
    ex.freeBuf(pa);
    ex.freeBuf(pb);
  }
};
const applyDelta = (a, d) => {
  const pa = write(a);
  const pd = write(d);
  try {
    return read(ex.applyDelta(pa, a.length, pd, d.length), "applyDelta");
  } finally {
    ex.freeBuf(pa);
    ex.freeBuf(pd);
  }
};

// ---------------------------------------------------------------------------
// Affix (prefix/suffix) ContentDelta — the model frameDelta.ts used before.
// Serialized footprint = 4 (prefixLen) + 4 (suffixLen) + insert bytes.
// ---------------------------------------------------------------------------
function affixDelta(prev, next) {
  if (prev === next) return { prefixLen: 0, suffixLen: 0, insert: "" };
  const min = Math.min(prev.length, next.length);
  let p = 0;
  while (p < min && prev[p] === next[p]) p++;
  let s = 0;
  while (s < min - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  return { prefixLen: p, suffixLen: s, insert: next.slice(p, next.length - s) };
}
const affixDeltaBytes = (d) => 8 + enc.encode(d.insert).length;
const applyAffix = (base, d) =>
  base.slice(0, d.prefixLen) + d.insert + base.slice(base.length - d.suffixLen);

// ---------------------------------------------------------------------------
function makeCodeDoc(targetBytes) {
  let out = "";
  let i = 0;
  while (out.length < targetBytes) {
    out += `export function value${i}() { return ${i % 997}; }\n`;
    i++;
  }
  return out;
}
function replaceAt(s, index, removeLen, insert) {
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

console.log("\n# Content delta: diff-match-patch (AssemblyScript) vs affix model\n");
const rows = [];
for (const c of cases) {
  const aBytes = enc.encode(c.prev);
  const bBytes = enc.encode(c.next);

  const affix = affixDelta(c.prev, c.next);
  if (applyAffix(c.prev, affix) !== c.next) throw new Error(`${c.name}: affix apply failed`);

  const dmp = diffDelta(aBytes, bBytes);
  if (dec.decode(applyDelta(aBytes, dmp)) !== c.next)
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
