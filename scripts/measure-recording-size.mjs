// One-off storage-size measurement for SCR3 recording files (see plan.md §5).
// Walks the append-only SCR3 container and reports the compressed byte breakdown
// per segment kind, so storage regressions are visible without a test suite.
//
// Usage: node scripts/measure-recording-size.mjs [path-to.ne ...]
//        (defaults to public/lessons/introduction/introduction.ne)
//
// Format: files may be raw binary SCR3 (first 4 bytes: 0x53 0x43 0x52 0x33 / "SCR3")
// or legacy base64-encoded text. The script auto-detects and decodes accordingly.
//
// Format source of truth: src/storage/streamingRecordingCodec/format.ts

import { readFile } from "node:fs/promises";

const MAGIC = "SCR3";
const HEADER_PREFIX_SIZE = 12; // magic(4) + version(2) + flags(2) + metaLen(4)
// Segment header byte layout depends on the stream's formatVersion (see format.ts):
//   v1 (14 bytes): kind(1) + len(4) + ts(4) + idx(4) + keyframe(1)
//   v2 (22 bytes): kind(1) + len(4) + startTs(4) + endTs(4) + idx(4) + cluster(4) + flags(1)
const LEGACY_SEGMENT_HEADER_SIZE = 14;
const SEGMENT_HEADER_SIZE = 22;
const FOOTER_TRAILER_SIZE = 8; // footerLen(4) + magic(4)

function segmentHeaderSize(formatVersion) {
  return formatVersion < 2 ? LEGACY_SEGMENT_HEADER_SIZE : SEGMENT_HEADER_SIZE;
}

// Mirrors SEGMENT_KIND in src/storage/streamingRecordingCodec/format.ts, in index
// order. This is a plain .mjs run under node (see package.json), so it cannot
// import the .ts source — keep it in step by hand. Audio and camera are never
// inline segments; they stay sibling files, so there is no audio kind here.
const KIND_NAME = [
  "frames",
  "slide",
  "preview",
  "previewDoc",
  "previewPatch",
  "workspace",
  "runtime",
  "cursor",
  "whiteboard",
  "chat",
  "finalMeta",
  "workspaceAsset",
];

function formatBytes(bytes) {
  const units = ["B", "KB", "MB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(2)} ${units[unit]}`;
}

function decodeBase64(text) {
  return new Uint8Array(Buffer.from(text.trim(), "base64"));
}

function measure(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC) {
    throw new Error(`Not an SCR3 stream (magic "${magic}")`);
  }

  const formatVersion = view.getUint16(4, true);
  const segHeaderSize = segmentHeaderSize(formatVersion);
  const metaLen = view.getUint32(8, true);
  const headerEnd = HEADER_PREFIX_SIZE + metaLen;
  const headerBytes = headerEnd;

  let segmentsEnd = bytes.length;
  let footerBytes = 0;
  const hasFooterMagic =
    bytes.length >= FOOTER_TRAILER_SIZE &&
    String.fromCharCode(
      bytes[bytes.length - 4],
      bytes[bytes.length - 3],
      bytes[bytes.length - 2],
      bytes[bytes.length - 1],
    ) === MAGIC;
  if (hasFooterMagic) {
    const footerLen = view.getUint32(bytes.length - FOOTER_TRAILER_SIZE, true);
    const footerStart = bytes.length - FOOTER_TRAILER_SIZE - footerLen;
    if (footerStart >= headerEnd) {
      segmentsEnd = footerStart;
      footerBytes = bytes.length - footerStart;
    }
  }

  const perKind = KIND_NAME.map((name) => ({ name, count: 0, payload: 0 }));
  let offset = headerEnd;
  while (offset + segHeaderSize <= segmentsEnd) {
    const kind = view.getUint8(offset);
    const byteLength = view.getUint32(offset + 1, true);
    const payloadEnd = offset + segHeaderSize + byteLength;
    if (payloadEnd > segmentsEnd) break;
    // Segments are self-delimiting, so a kind newer than this table is still
    // walked past — but it is reported in its own bucket rather than dropped.
    // Silently discarding it is how a whole track can regress and measure as
    // zero growth, which is the one thing this script exists to catch.
    // `??=` rather than a length check: an out-of-range kind extends the array
    // and leaves holes behind it, and a later kind can land in one of those.
    perKind[kind] ??= { name: `unknown kind ${kind}`, count: 0, payload: 0 };
    perKind[kind].count += 1;
    perKind[kind].payload += byteLength;
    offset = payloadEnd;
  }

  return { total: bytes.length, headerBytes, footerBytes, perKind: perKind.filter(Boolean) };
}

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) paths.push("public/lessons/introduction/introduction.ne");

  for (const path of paths) {
    const buffer = await readFile(path);
    let bytes = new Uint8Array(buffer);

    // Check if it's raw binary SCR3 (first 4 bytes: 0x53 0x43 0x52 0x33)
    if (!(bytes[0] === 0x53 && bytes[1] === 0x43 && bytes[2] === 0x52 && bytes[3] === 0x33)) {
      // Fall back to legacy base64 decoding
      bytes = decodeBase64(buffer.toString("utf8"));
    }

    const { total, headerBytes, footerBytes, perKind } = measure(bytes);
    const segmentTotal = perKind.reduce((sum, k) => sum + k.payload, 0);
    const segmentHeaderOverhead =
      perKind.reduce((sum, k) => sum + k.count, 0) * SEGMENT_HEADER_SIZE;

    console.log(`\n${path}`);
    console.log(`  file size:          ${formatBytes(buffer.length)}`);
    console.log(`  binary stream:      ${formatBytes(total)}`);
    console.log(`  header:             ${formatBytes(headerBytes)}`);
    console.log(`  footer index:       ${formatBytes(footerBytes)}`);
    console.log(`  segment headers:    ${formatBytes(segmentHeaderOverhead)}`);
    console.log(`  segment payload:    ${formatBytes(segmentTotal)}`);
    console.log("  segments by kind:");
    for (const kind of perKind) {
      if (kind.count === 0) continue;
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
