/**
 * Studio compare — track-by-track comparison of two recordings.
 *
 *   bun scripts/studio-compare.ts <a.ne> <b.ne> [--json]
 *       [--p95=150] [--max=500] [--cursor=4] [--duration=100]
 *
 * Decodes both files with the app's own decoder and compares what a viewer
 * sees change on every track (editor, workspace, runtime, whiteboard, slides,
 * cursor, captions, chapters, duration): the changes must be the same and in
 * the same order, and the k-th change of a track may move in time only within
 * the tolerances. The usual use is a real-clock and a virtual-clock render of
 * one lesson.
 *
 * Prints one row per track, or the whole result with --json. Exits 0 when
 * every track is equal, 1 when any track differs beyond tolerance, and 2 when
 * the arguments are wrong or a file cannot be read or decoded.
 *
 * All the logic is in src/studio/trackDiff.ts; this file is the I/O shell.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Recording } from "../src/core/src";
import type { TrackComparison, TrackDiffOptions } from "../src/studio/trackDiff.ts";

const DMP_WASM_PATH = fileURLToPath(
  new URL("../src/core/dmp/build/next-editor-dmp.wasm", import.meta.url),
);

const USAGE =
  "usage: bun scripts/studio-compare.ts <a.ne> <b.ne> [--json] [--p95=ms] [--max=ms] [--cursor=px] [--duration=ms]";

const NUMBER_FLAGS: Record<string, keyof TrackDiffOptions> = {
  "--p95": "p95Ms",
  "--max": "maxMs",
  "--cursor": "cursorDistancePx",
  "--duration": "durationMs",
};

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const files: string[] = [];
  const options: Partial<TrackDiffOptions> = {};
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [flag, value] = arg.split("=", 2);
      const key = NUMBER_FLAGS[flag];
      const number = Number(value);
      if (!key || value === undefined || !Number.isFinite(number) || number < 0) {
        fail(`unknown or bad option ${arg}\n${USAGE}`);
      }
      options[key] = number;
      continue;
    }
    files.push(arg);
  }
  if (files.length !== 2) fail(USAGE);
  return { files: files as [string, string], options, json };
}

function cell(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function firstDifferenceText(track: TrackComparison): string {
  const difference = track.firstDifference;
  if (!difference) return "";
  const side = (label: string, value: typeof difference.a) =>
    value ? `${label} @${value.timeMs}ms ${value.description}` : `${label} (none)`;
  return [
    `#${difference.index} ${difference.reason}`,
    side("a", difference.a),
    side("b", difference.b),
    difference.detail ?? "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function printTable(tracks: TrackComparison[]): void {
  console.log(
    `${cell("track", 11)} ${cell("a", 6)} ${cell("b", 6)} ${cell("equal", 6)} ${cell("p95", 7)} ${cell("max", 7)} first difference`,
  );
  for (const track of tracks) {
    const extra = track.maxDistancePx === undefined ? "" : ` (${track.maxDistancePx}px apart)`;
    console.log(
      `${cell(track.track, 11)} ${cell(String(track.counts.a), 6)} ${cell(String(track.counts.b), 6)} ${cell(track.equal ? "yes" : "NO", 6)} ${cell(track.timing ? `${track.timing.p95Ms}ms` : "-", 7)} ${cell(track.timing ? `${track.timing.maxMs}ms` : "-", 7)} ${firstDifferenceText(track)}${extra}`,
    );
  }
}

async function main(): Promise<void> {
  const { files, options, json } = parseArgs(process.argv.slice(2));

  // Loaded here, not at the top, so a decoder that cannot load (its Rust
  // diff-match-patch WASM, fflate or msgpack) is reported as a reason rather
  // than a stack trace.
  let decode: (bytes: Uint8Array) => Promise<Recording>;
  let diff: typeof import("../src/studio/trackDiff.ts").diffRecordings;
  try {
    // Content deltas apply through the Rust diff-match-patch codec. The app
    // loads it as a WASM-ESM import through Vite; here it is built from its
    // bytes and installed, as the codec's own docs say a custom host should.
    const { installDmpCodec, instantiateDmpCodec } = await import("../src/core/dmp/dmpCodec.ts");
    installDmpCodec(await instantiateDmpCodec(await readFile(DMP_WASM_PATH)));
    ({ decompressBinaryToRecording: decode } = await import("../src/storage/recordingCodec.ts"));
    ({ diffRecordings: diff } = await import("../src/studio/trackDiff.ts"));
  } catch (error) {
    fail(
      `the recording decoder does not load here: ${(error as Error).message}\nCompare the two recordings in a page instead (src/studio/trackDiff.ts diffRecordings).`,
    );
  }

  const recordings: Recording[] = [];
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(file));
    } catch (error) {
      fail(`cannot read ${file}: ${(error as Error).message}`);
    }
    try {
      recordings.push(await decode(bytes));
    } catch (error) {
      fail(`cannot decode ${file}: ${(error as Error).message}`);
    }
  }

  let result: ReturnType<typeof diff>;
  try {
    result = diff(recordings[0], recordings[1], options);
  } catch (error) {
    // A delta that does not apply to its base (a damaged file) throws with the frame index.
    fail(`cannot compare: ${(error as Error).message}`);
  }

  if (json) {
    console.log(JSON.stringify({ a: files[0], b: files[1], ...result }, null, 2));
  } else {
    console.log(`a: ${files[0]}\nb: ${files[1]}\n`);
    printTable(result.tracks);
    console.log(`\n${result.equal ? "equal" : "DIFFERENT"}`);
  }
  process.exit(result.equal ? 0 : 1);
}

await main();
