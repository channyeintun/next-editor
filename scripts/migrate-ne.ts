// One-shot migrator for .ne recordings written with the old codec (fflate
// DEFLATE segments + prefix/suffix affix content deltas) to the current codec
// (zstd segments + go-diff content deltas). The SCR3 byte layout is unchanged,
// so this reuses the real container decoder/encoder and only swaps the two
// things that changed: the compression algorithm and the content-delta encoding.
//
//   bun run scripts/migrate-ne.ts public/introduction.ne [more.ne ...]
//
// Each file is decoded, transcoded, re-encoded, verified frame-by-frame against
// the original, and only then overwritten (the originals are recoverable via git).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzlibSync } from "fflate";
import { isKeyframe } from "../src/core/src/utils/deltaTypes";
import type { ContentDelta, DeltaFrame } from "../src/core/src/utils/deltaTypes";
import { createContentDelta, reconstructFrameAtIndex } from "../src/core/src/utils/frameDelta";
import { type GoCodec, installGoCodec, instantiateGoCodec } from "../src/storage/goCodec/goCodec";
import {
  decodeRecordingStream,
  encodeRecordingToStream,
} from "../src/storage/streamingRecordingCodec";

const b64ToBytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));
const bytesToB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

// Old affix content delta: keep `prefixLen` from the front, `suffixLen` from the
// back of the previous content, and splice `insert` in the middle.
interface OldContentDelta {
  prefixLen: number;
  suffixLen: number;
  insert: string;
}
const applyOldContentDelta = (base: string, d: OldContentDelta): string =>
  base.slice(0, d.prefixLen) + d.insert + base.slice(base.length - d.suffixLen);

// During old-stream decode the real codec's zstdDecompress is the only entry
// point the container hits for compressed blobs; route it to fflate instead.
const fflateDecodeShim: GoCodec = {
  zstdDecompress: (input) => unzlibSync(input),
  zstdCompress: () => {
    throw new Error("migrate-ne: zstdCompress should not run while decoding the old stream");
  },
  diffDelta: () => {
    throw new Error("migrate-ne: diffDelta should not run while decoding the old stream");
  },
  applyDelta: () => {
    throw new Error("migrate-ne: applyDelta should not run while decoding the old stream");
  },
};

async function loadRealCodec(): Promise<GoCodec> {
  const wasmPath = resolve(process.cwd(), "public/next-editor-go.wasm");
  return instantiateGoCodec(readFileSync(wasmPath));
}

/**
 * Walks the stored frame timeline, reconstructing each frame's full content from
 * the old affix deltas. Returns the full content per frame index so we can both
 * rebuild go-diff deltas and verify the result.
 */
function reconstructFullContents(frames: DeltaFrame[]): string[] {
  const contents: string[] = [];
  let running = "";
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (isKeyframe(frame)) {
      running = frame.state.content;
    } else {
      const delta = frame.contentDelta as unknown as OldContentDelta | undefined;
      if (delta) running = applyOldContentDelta(running, delta);
    }
    contents[i] = running;
  }
  return contents;
}

/** Rewrites each delta frame's content delta from the affix form to go-diff. */
function rewriteContentDeltas(frames: DeltaFrame[], fullContents: string[]): number {
  let rewritten = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (isKeyframe(frame) || frame.contentDelta === undefined) continue;
    // Old deltas are relative to the previous stored frame (frames[i - 1]).
    const next = createContentDelta(fullContents[i - 1], fullContents[i]);
    if (next) {
      frame.contentDelta = next as ContentDelta;
    } else {
      delete frame.contentDelta;
    }
    rewritten++;
  }
  return rewritten;
}

async function migrateFile(path: string, realCodec: GoCodec): Promise<void> {
  const absolute = resolve(process.cwd(), path);
  const originalText = readFileSync(absolute, "utf8").trim();
  const originalBytes = b64ToBytes(originalText);

  // 1. Decode the old stream (deflate segments) via the fflate shim.
  installGoCodec(fflateDecodeShim);
  const recording = decodeRecordingStream(originalBytes);
  const frames = recording.frames;
  const fullContents = reconstructFullContents(frames);

  // 2. Transcode content deltas to go-diff (needs the real codec).
  installGoCodec(realCodec);
  const rewritten = rewriteContentDeltas(frames, fullContents);

  // 3. Re-encode with the real codec (zstd segments + go-diff deltas).
  const newBytes = await encodeRecordingToStream(recording);

  // 4. Verify: decode the new bytes and reconstruct every frame's content via
  //    the real go-diff replay path, asserting it matches the original timeline.
  const roundTrip = decodeRecordingStream(newBytes);
  if (roundTrip.frames.length !== frames.length) {
    throw new Error(`${path}: frame count changed (${frames.length} → ${roundTrip.frames.length})`);
  }
  for (let i = 0; i < fullContents.length; i++) {
    const rebuilt = reconstructFrameAtIndex(roundTrip.frames, i);
    if (!rebuilt || rebuilt.state.content !== fullContents[i]) {
      throw new Error(`${path}: frame ${i} content mismatch after migration`);
    }
  }

  // 5. Overwrite only after verification passes.
  writeFileSync(absolute, bytesToB64(newBytes), "utf8");

  const pct = ((newBytes.length / originalBytes.length) * 100).toFixed(1);
  console.log(
    `✓ ${path}: ${frames.length} frames (${rewritten} deltas rewritten), ` +
      `${(originalBytes.length / 1024).toFixed(0)}KB → ${(newBytes.length / 1024).toFixed(0)}KB (${pct}%)`,
  );
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: bun run scripts/migrate-ne.ts <file.ne> [more.ne ...]");
  process.exit(1);
}

const realCodec = await loadRealCodec();
for (const file of files) {
  await migrateFile(file, realCodec);
}
