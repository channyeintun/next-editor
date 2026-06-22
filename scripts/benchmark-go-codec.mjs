// Benchmarks the Go (zstd + go-diff) codec module against the codec primitives
// the app ships today:
//
//   * zstd (klauspost/compress, SpeedDefault) vs fflate zlibSync — the DEFLATE
//     used by the SCR3 segment codec (streamingRecordingCodec/format.ts).
//   * go-diff DiffToDelta vs the prefix/suffix ContentDelta model
//     (core/src/utils/frameDelta.ts).
//
// Run: node scripts/benchmark-go-codec.mjs
//
// It reports size (the thing that matters for recordings) and throughput, and
// asserts every codec round-trips, so a regression fails loudly.
import { performance } from "node:perf_hooks";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { zlibSync, unzlibSync } from "fflate";
import { loadGoCodec } from "./wasm-go-loader.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();
const SAMPLES = Number(process.env.SAMPLES ?? 5);
const MIN_SAMPLE_MS = Number(process.env.MIN_SAMPLE_MS ?? 200);

const fmt = (n) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
const kb = (bytes) => `${fmt(bytes / 1024)} KB`;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function bench(fn) {
  const samples = [];
  for (let s = 0; s < SAMPLES; s++) {
    const start = performance.now();
    let elapsed = 0;
    let count = 0;
    while (elapsed < MIN_SAMPLE_MS) {
      fn();
      count++;
      elapsed = performance.now() - start;
    }
    samples.push((count / elapsed) * 1000);
  }
  return median(samples);
}

// ---------------------------------------------------------------------------
// Payload generators that approximate what the SCR3 codec actually compresses.
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

// rrweb-ish event records: the kind of array that becomes one SCR3 segment.
function makeEventRecords(count) {
  const records = [];
  let t = Date.now();
  for (let i = 0; i < count; i++) {
    t += 16 + (i % 5);
    if (i % 4 === 0) {
      records.push({ type: 3, timestamp: t, data: { source: 1, x: i % 1280, y: (i * 7) % 720 } });
    } else {
      records.push({
        type: 3,
        timestamp: t,
        data: { source: 5, id: 30 + (i % 200), text: `tok_${i % 50}` },
      });
    }
  }
  return new Uint8Array(msgpackEncode(records));
}

function replaceAt(s, index, removeLen, insert) {
  return s.slice(0, index) + insert + s.slice(index + removeLen);
}

// ---------------------------------------------------------------------------
// Affix (prefix/suffix) ContentDelta — the model frameDelta.ts uses today.
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

// ===========================================================================
const api = await loadGoCodec(new URL("../public/next-editor-go.wasm", import.meta.url));

console.log("\n# Compression: Go zstd vs fflate (zlibSync)\n");
const compressionCases = [
  { name: "100KB code keyframe", bytes: enc.encode(makeCodeDoc(100 * 1024)) },
  { name: "5k event records (msgpack)", bytes: makeEventRecords(5000) },
  { name: "20k event records (msgpack)", bytes: makeEventRecords(20000) },
];

const compRows = [];
for (const c of compressionCases) {
  const zstd = api.zstdCompress(c.bytes);
  const zlib = zlibSync(c.bytes, { level: 6 });

  // Correctness: both must round-trip.
  if (dec.decode(api.zstdDecompress(zstd)) !== dec.decode(c.bytes))
    throw new Error(`${c.name}: zstd round-trip failed`);
  if (Buffer.compare(Buffer.from(unzlibSync(zlib)), Buffer.from(c.bytes)) !== 0)
    throw new Error(`${c.name}: zlib round-trip failed`);

  const zstdOps = bench(() => api.zstdCompress(c.bytes));
  const zlibOps = bench(() => zlibSync(c.bytes, { level: 6 }));

  compRows.push({
    case: c.name,
    raw: kb(c.bytes.length),
    "zlib (fflate)": kb(zlib.length),
    "zstd (Go)": kb(zstd.length),
    "size vs zlib": `${fmt((zstd.length / zlib.length) * 100)}%`,
    "zstd ops/s": fmt(zstdOps),
    "zlib ops/s": fmt(zlibOps),
  });
}
console.table(compRows);

console.log("\n# Delta: Go go-diff vs prefix/suffix affix model\n");
const code = makeCodeDoc(100 * 1024);
const deltaCases = [
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

const deltaRows = [];
for (const c of deltaCases) {
  const aBytes = enc.encode(c.prev);
  const bBytes = enc.encode(c.next);

  const affix = affixDelta(c.prev, c.next);
  if (applyAffix(c.prev, affix) !== c.next) throw new Error(`${c.name}: affix apply failed`);

  const gdDelta = api.diffDelta(aBytes, bBytes);
  const rebuilt = dec.decode(api.applyDelta(aBytes, gdDelta));
  if (rebuilt !== c.next) throw new Error(`${c.name}: go-diff apply failed`);

  deltaRows.push({
    case: c.name,
    "affix delta": kb(affixDeltaBytes(affix)),
    "go-diff delta": kb(gdDelta.length),
    "go-diff vs affix": `${fmt((gdDelta.length / affixDeltaBytes(affix)) * 100)}%`,
  });
}
console.table(deltaRows);
console.log("All codecs round-tripped ✓\n");
