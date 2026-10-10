/**
 * One-off storage-size measurement for SCR3 recording files. Walks the
 * append-only SCR3 container and reports the compressed byte breakdown per
 * segment kind, so storage regressions are visible without a test suite.
 *
 *   bun scripts/measure-recording-size.ts [path-to.ne ...]
 *   (defaults to public/lessons/introduction/introduction.ne)
 *
 * The byte layout comes from src/storage/streamingRecordingCodec/format.ts, so
 * this reads exactly the files the app reads (format versions 2–5) and refuses
 * the ones it refuses.
 */

import { readFile } from "node:fs/promises";

import {
  findFooterStart,
  parseHeader,
  readSegmentHeader,
  SEGMENT_HEADER_SIZE,
  SEGMENT_KIND,
} from "../src/storage/streamingRecordingCodec/format.ts";

const KIND_NAMES = new Map<number, string>(
  Object.entries(SEGMENT_KIND).map(([name, kind]) => [kind, name]),
);

interface KindTally {
  name: string;
  count: number;
  payload: number;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(2)} ${units[unit]}`;
}

function measure(bytes: Uint8Array) {
  const { headerEnd } = parseHeader(bytes);
  const footerStart = findFooterStart(bytes, headerEnd);
  const segmentsEnd = footerStart ?? bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const perKind = new Map<number, KindTally>();
  let offset = headerEnd;
  while (offset + SEGMENT_HEADER_SIZE <= segmentsEnd) {
    const { kind, byteLength } = readSegmentHeader(view, offset);
    const payloadEnd = offset + SEGMENT_HEADER_SIZE + byteLength;
    if (payloadEnd > segmentsEnd) break;
    // Segments are self-delimiting, so a kind newer than SEGMENT_KIND is still
    // walked past, but it is reported in its own bucket rather than dropped.
    // Silently discarding it is how a whole track can regress and measure as
    // zero growth, which is the one thing this script exists to catch.
    let tally = perKind.get(kind);
    if (!tally) {
      tally = { name: KIND_NAMES.get(kind) ?? `unknown kind ${kind}`, count: 0, payload: 0 };
      perKind.set(kind, tally);
    }
    tally.count += 1;
    tally.payload += byteLength;
    offset = payloadEnd;
  }

  return {
    total: bytes.length,
    headerBytes: headerEnd,
    footerBytes: footerStart === null ? 0 : bytes.length - footerStart,
    perKind: [...perKind.entries()].sort(([left], [right]) => left - right).map(([, t]) => t),
  };
}

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) paths.push("public/lessons/introduction/introduction.ne");

  for (const path of paths) {
    const bytes = new Uint8Array(await readFile(path));
    const { total, headerBytes, footerBytes, perKind } = measure(bytes);
    const segmentTotal = perKind.reduce((sum, kind) => sum + kind.payload, 0);
    const segmentHeaderOverhead =
      perKind.reduce((sum, kind) => sum + kind.count, 0) * SEGMENT_HEADER_SIZE;

    console.log(`\n${path}`);
    console.log(`  file size:          ${formatBytes(bytes.length)}`);
    console.log(`  binary stream:      ${formatBytes(total)}`);
    console.log(`  header:             ${formatBytes(headerBytes)}`);
    console.log(`  footer index:       ${formatBytes(footerBytes)}`);
    console.log(`  segment headers:    ${formatBytes(segmentHeaderOverhead)}`);
    console.log(`  segment payload:    ${formatBytes(segmentTotal)}`);
    console.log("  segments by kind:");
    for (const kind of perKind) {
      console.log(
        `    ${kind.name.padEnd(15)} ${String(kind.count).padStart(5)} seg  ${formatBytes(kind.payload)}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
