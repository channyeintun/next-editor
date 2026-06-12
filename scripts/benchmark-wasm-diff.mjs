import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const WASM_PAGE_SIZE = 65536;
const WASM_SCRATCH_BASE_OFFSET = WASM_PAGE_SIZE;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_TAG = 0x80;
const SAMPLE_COUNT = Number(process.env.SAMPLES ?? 5);
const MIN_SAMPLE_MS = Number(process.env.MIN_SAMPLE_MS ?? 250);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
let sink = 0;

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function makeCodeDoc(targetBytes) {
  const lines = [];
  let size = 0;
  let index = 0;

  while (size < targetBytes) {
    const line = `export function value${index}() { return ${index % 997}; }\n`;
    lines.push(line);
    size += line.length;
    index++;
  }

  return lines.join("");
}

function replaceAt(input, index, removeLength, insert) {
  return input.slice(0, index) + insert + input.slice(index + removeLength);
}

function createCases() {
  const small = makeCodeDoc(2 * 1024);
  const medium = makeCodeDoc(100 * 1024);
  const large = makeCodeDoc(1024 * 1024);
  const utf8 = "const label = 'é漢🙂';\n".repeat(5000);
  const utf8Middle = Math.floor(utf8.length / 2);

  return [
    {
      name: "2KB middle edit",
      previous: small,
      next: replaceAt(small, Math.floor(small.length / 2), 8, "changedValue"),
    },
    {
      name: "100KB append",
      previous: medium,
      next: `${medium}const appendedValue = 42;\n`,
    },
    {
      name: "100KB early edit",
      previous: medium,
      next: replaceAt(medium, 96, 1, "X"),
    },
    {
      name: "1MB middle edit",
      previous: large,
      next: replaceAt(large, Math.floor(large.length / 2), 10, "replacement"),
    },
    {
      name: "UTF-8 middle edit",
      previous: utf8,
      next: replaceAt(utf8, utf8Middle, 1, "ĩ"),
    },
  ];
}

async function loadWasmExports() {
  const wasmBytes = await readFile(new URL("../public/next-editor.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  return instance.exports;
}

function prepareWasmStringPair(exports, str1, str2) {
  const bytes1 = textEncoder.encode(str1);
  const bytes2 = textEncoder.encode(str2);
  const baseOffset = WASM_SCRATCH_BASE_OFFSET;
  const totalSizeNeeded = baseOffset + bytes1.length + bytes2.length;

  if (exports.memory.buffer.byteLength < totalSizeNeeded) {
    const pagesNeeded = Math.ceil(
      (totalSizeNeeded - exports.memory.buffer.byteLength) / WASM_PAGE_SIZE,
    );
    if (pagesNeeded > 0) exports.memory.grow(pagesNeeded);
  }

  new Uint8Array(exports.memory.buffer, baseOffset, bytes1.length).set(bytes1);
  new Uint8Array(exports.memory.buffer, baseOffset + bytes1.length, bytes2.length).set(bytes2);

  return {
    bytes1,
    bytes2,
    ptr1: baseOffset,
    ptr2: baseOffset + bytes1.length,
  };
}

function prefixBytesToCharacterLength(bytes, prefixBytes) {
  let safePrefixBytes = Math.min(prefixBytes, bytes.length);

  while (
    safePrefixBytes > 0 &&
    safePrefixBytes < bytes.length &&
    (bytes[safePrefixBytes] & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_TAG
  ) {
    safePrefixBytes--;
  }

  if (safePrefixBytes <= 0) return 0;
  return textDecoder.decode(bytes.subarray(0, safePrefixBytes)).length;
}

function suffixBytesToCharacterLength(bytes, suffixBytes) {
  let safeSuffixBytes = Math.min(suffixBytes, bytes.length);

  while (safeSuffixBytes > 0) {
    const suffixStart = bytes.length - safeSuffixBytes;
    if ((bytes[suffixStart] & UTF8_CONTINUATION_MASK) !== UTF8_CONTINUATION_TAG) break;
    safeSuffixBytes--;
  }

  if (safeSuffixBytes <= 0) return 0;
  return textDecoder.decode(bytes.subarray(bytes.length - safeSuffixBytes)).length;
}

function findCommonPrefixLengthWasm(exports, str1, str2) {
  const { bytes1, bytes2, ptr1, ptr2 } = prepareWasmStringPair(exports, str1, str2);
  const prefixBytes = exports.findCommonPrefix(ptr1, bytes1.length, ptr2, bytes2.length);
  return prefixBytesToCharacterLength(bytes1, prefixBytes);
}

function findCommonSuffixLengthWasm(exports, str1, str2) {
  const { bytes1, bytes2, ptr1, ptr2 } = prepareWasmStringPair(exports, str1, str2);
  const suffixBytes = exports.findCommonSuffix(ptr1, bytes1.length, ptr2, bytes2.length);
  return suffixBytesToCharacterLength(bytes1, suffixBytes);
}

function findCommonAffixLengthsWasm(exports, str1, str2) {
  const { bytes1, bytes2, ptr1, ptr2 } = prepareWasmStringPair(exports, str1, str2);
  const prefixBytes = exports.findCommonPrefix(ptr1, bytes1.length, ptr2, bytes2.length);
  const suffixBytes = exports.findCommonSuffix(
    ptr1 + prefixBytes,
    bytes1.length - prefixBytes,
    ptr2 + prefixBytes,
    bytes2.length - prefixBytes,
  );

  return {
    prefixLen: prefixBytesToCharacterLength(bytes1, prefixBytes),
    suffixLen: suffixBytesToCharacterLength(bytes1, suffixBytes),
  };
}

function findCommonPrefixLengthTs(str1, str2) {
  const minLen = Math.min(str1.length, str2.length);
  let i = 0;
  while (i < minLen && str1[i] === str2[i]) i++;
  return i;
}

function findCommonSuffixLengthTs(str1, str2) {
  const minLen = Math.min(str1.length, str2.length);
  let i = 0;
  while (i < minLen && str1[str1.length - 1 - i] === str2[str2.length - 1 - i]) i++;
  return i;
}

function createContentDeltaWith(prefixFn, suffixFn, previous, next) {
  if (previous === next) return null;

  const prefixLen = prefixFn(previous, next);
  const prevRemainder = previous.slice(prefixLen);
  const nextRemainder = next.slice(prefixLen);
  const suffixLen = suffixFn(prevRemainder, nextRemainder);
  const insert = nextRemainder.slice(0, nextRemainder.length - suffixLen);

  return { prefixLen, suffixLen, insert };
}

function createContentDeltaWithAffixes(affixFn, previous, next) {
  if (previous === next) return null;

  const { prefixLen, suffixLen } = affixFn(previous, next);
  const nextRemainder = next.slice(prefixLen);
  const insert = nextRemainder.slice(0, nextRemainder.length - suffixLen);

  return { prefixLen, suffixLen, insert };
}

function applyContentDelta(base, delta) {
  if (!delta) return base;
  return base.slice(0, delta.prefixLen) + delta.insert + base.slice(base.length - delta.suffixLen);
}

function bench(fn) {
  const samples = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    const start = performance.now();
    let elapsed = 0;
    let count = 0;

    while (elapsed < MIN_SAMPLE_MS) {
      const result = fn();
      sink ^= result ? result.prefixLen + result.suffixLen + result.insert.length : 1;
      count++;
      elapsed = performance.now() - start;
    }

    samples.push((count / elapsed) * 1000);
  }

  return {
    opsPerSecond: median(samples),
    samples,
  };
}

function assertValidDelta(name, previous, next, delta) {
  const applied = applyContentDelta(previous, delta);
  if (applied !== next) {
    throw new Error(`${name} produced an invalid content delta`);
  }
}

function printRows(rows) {
  const headers = [
    "case",
    "TypeScript ops/s",
    "WASM separate ops/s",
    "WASM combined ops/s",
    "combined vs TS",
    "combined vs separate",
  ];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => String(row[column]).length)),
  );

  const printLine = (columns) => {
    console.log(columns.map((column, index) => String(column).padEnd(widths[index])).join("  "));
  };

  printLine(headers);
  printLine(widths.map((width) => "-".repeat(width)));
  for (const row of rows) printLine(row);
}

const exports = await loadWasmExports();
const cases = createCases();
const rows = [];

for (const testCase of cases) {
  const tsDelta = createContentDeltaWith(
    findCommonPrefixLengthTs,
    findCommonSuffixLengthTs,
    testCase.previous,
    testCase.next,
  );
  const wasmDelta = createContentDeltaWith(
    (a, b) => findCommonPrefixLengthWasm(exports, a, b),
    (a, b) => findCommonSuffixLengthWasm(exports, a, b),
    testCase.previous,
    testCase.next,
  );
  const combinedWasmDelta = createContentDeltaWithAffixes(
    (a, b) => findCommonAffixLengthsWasm(exports, a, b),
    testCase.previous,
    testCase.next,
  );

  assertValidDelta(`${testCase.name} TypeScript`, testCase.previous, testCase.next, tsDelta);
  assertValidDelta(`${testCase.name} WASM separate`, testCase.previous, testCase.next, wasmDelta);
  assertValidDelta(
    `${testCase.name} WASM combined`,
    testCase.previous,
    testCase.next,
    combinedWasmDelta,
  );

  for (let i = 0; i < 100; i++) {
    createContentDeltaWith(
      findCommonPrefixLengthTs,
      findCommonSuffixLengthTs,
      testCase.previous,
      testCase.next,
    );
    createContentDeltaWith(
      (a, b) => findCommonPrefixLengthWasm(exports, a, b),
      (a, b) => findCommonSuffixLengthWasm(exports, a, b),
      testCase.previous,
      testCase.next,
    );
    createContentDeltaWithAffixes(
      (a, b) => findCommonAffixLengthsWasm(exports, a, b),
      testCase.previous,
      testCase.next,
    );
  }

  const ts = bench(() =>
    createContentDeltaWith(
      findCommonPrefixLengthTs,
      findCommonSuffixLengthTs,
      testCase.previous,
      testCase.next,
    ),
  );
  const wasmSeparate = bench(() =>
    createContentDeltaWith(
      (a, b) => findCommonPrefixLengthWasm(exports, a, b),
      (a, b) => findCommonSuffixLengthWasm(exports, a, b),
      testCase.previous,
      testCase.next,
    ),
  );
  const wasmCombined = bench(() =>
    createContentDeltaWithAffixes(
      (a, b) => findCommonAffixLengthsWasm(exports, a, b),
      testCase.previous,
      testCase.next,
    ),
  );

  rows.push([
    testCase.name,
    formatNumber(ts.opsPerSecond),
    formatNumber(wasmSeparate.opsPerSecond),
    formatNumber(wasmCombined.opsPerSecond),
    `${formatNumber(wasmCombined.opsPerSecond / ts.opsPerSecond)}x`,
    `${formatNumber(wasmCombined.opsPerSecond / wasmSeparate.opsPerSecond)}x`,
  ]);
}

printRows(rows);
console.log(`sink=${sink}`);
