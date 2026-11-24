/**
 * Studio compare — track-by-track comparison of two recordings.
 *
 *   bun scripts/studio-compare.ts <a.ne> <b.ne> [--json] [--<tolerance>=<value>]
 *
 * Every tolerance has a flag (USAGE below says what each one loosens); the
 * defaults are DEFAULT_TRACK_DIFF_OPTIONS in src/studio/trackDiff.ts, where
 * the measurement behind each is written down.
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
import {
  DEFAULT_TRACK_DIFF_OPTIONS,
  diffRecordings,
  type TrackComparison,
  type TrackDiffOptions,
} from "../src/studio/trackDiff.ts";

const DMP_WASM_PATH = fileURLToPath(
  new URL("../src/core/dmp/build/next-editor-dmp.wasm", import.meta.url),
);

/** Each flag, the tolerance it sets, and what a larger value lets through. */
const NUMBER_FLAGS: Record<string, { key: keyof TrackDiffOptions; loosens: string }> = {
  "--p95": {
    key: "p95Ms",
    loosens: "ms: more of a track's changes may sit late or early (the p95 of |time a - time b|)",
  },
  "--max": { key: "maxMs", loosens: "ms: any one change may sit this late or early" },
  "--cursor": {
    key: "cursorDistancePx",
    loosens: "px: the two pointer paths, and where they rest, may lie this far apart",
  },
  "--shift": {
    key: "cursorMaxShiftMs",
    loosens: "ms: a whole pointer run may be slid this far in time to line up with the other",
  },
  "--slack": {
    key: "cursorTimeSlackMs",
    loosens: "ms: each pointer point may match the other path anywhere this near in time",
  },
  "--rest-gap": {
    key: "cursorRestGapMs",
    loosens:
      "ms: a longer pause still counts as one pointer move, and one drag-select; fewer rests and selections are compared",
  },
  "--order": {
    key: "orderMarginMs",
    loosens: "ms: changes on two tracks this close in time may swap order",
  },
  "--duration": {
    key: "durationMs",
    loosens: "ms: the two recordings' lengths may differ this much",
  },
};

const USAGE = [
  "usage: bun scripts/studio-compare.ts <a.ne> <b.ne> [--json] [--<tolerance>=<value>]",
  "Each tolerance flag loosens the comparison when raised and tightens it when lowered:",
  ...Object.entries(NUMBER_FLAGS).map(
    ([flag, { key, loosens }]) =>
      `  ${`${flag}=${DEFAULT_TRACK_DIFF_OPTIONS[key]}`.padEnd(16)} ${loosens}`,
  ),
].join("\n");

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
      const key = NUMBER_FLAGS[flag]?.key;
      const number = Number(value);
      if (!key || !value || !Number.isFinite(number) || number < 0) {
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
  try {
    // Content deltas apply through the Rust diff-match-patch codec. The app
    // loads it as a WASM-ESM import through Vite; here it is built from its
    // bytes and installed, as the codec's own docs say a custom host should.
    const { installDmpCodec, instantiateDmpCodec } = await import("../src/core/dmp/dmpCodec.ts");
    installDmpCodec(await instantiateDmpCodec(await readFile(DMP_WASM_PATH)));
    ({ decompressBinaryToRecording: decode } = await import("../src/storage/recordingCodec.ts"));
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

  let result: ReturnType<typeof diffRecordings>;
  try {
    result = diffRecordings(recordings[0], recordings[1], options);
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
