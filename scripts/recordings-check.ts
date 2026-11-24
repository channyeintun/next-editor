/**
 * Recordings check: replay's laws on real published recordings, run by hand.
 *
 *   bun scripts/recordings-check.ts [--count=N] [--slug=<lesson slug> …] [--cuts=K] [--seed=S] [--keep]
 *
 * Downloads published lessons from nexteditor.dev into a temporary folder of its
 * own, decodes each with the app's decoder, and checks that seeking lands where
 * playing does and that a cut keeps what is outside it. It prints one row per
 * recording and track, then totals and a hash of the table. The downloads are
 * deleted when it ends: nothing from a production recording is kept or written
 * into the repository.
 *
 * It is not a gate. A difference is information for a person: run it on main
 * before a change to replay or cutting and again after, and look for a new one
 * (USAGE in recordings-check/args.ts). Exit code 0 when it ran, 1 when it could not.
 *
 * The checks are in scripts/recordings-check/; this file is the I/O shell.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Recording } from "../src/core/src";
import { parseArgs, USAGE } from "./recordings-check/args.ts";
import { checkCutLaw, DEFAULT_CUT_LAW } from "./recordings-check/cutLaw.ts";
import {
  downloadRecording,
  isHumanRecording,
  lessonBySlug,
  newestLessons,
  type ListedLesson,
} from "./recordings-check/lessons.ts";
import { checkSeekVsPlay, DEFAULT_SEEK_VS_PLAY } from "./recordings-check/seekVsPlay.ts";
import { formatSize, spreadLine } from "./recordings-check/spread.ts";
import {
  formatTable,
  rowsOf,
  totalsLine,
  unreadableRow,
  type Row,
} from "./recordings-check/table.ts";
import { withTempFolder } from "./recordings-check/tempFolder.ts";

const DMP_WASM_PATH = fileURLToPath(
  new URL("../src/core/dmp/build/next-editor-dmp.wasm", import.meta.url),
);

const parsed = parseArgs(process.argv.slice(2));
if ("error" in parsed) {
  if (parsed.error) console.error(parsed.error);
  console.error(USAGE);
  process.exit(parsed.error ? 1 : 0);
}
const { options } = parsed;

/** Prints why the run could not happen, and ends it with exit code 1. */
class CannotRun extends Error {}

async function listLessons(): Promise<ListedLesson[]> {
  if (options.slugs.length === 0) return newestLessons(fetch, options.count);
  const lessons: ListedLesson[] = [];
  for (const slug of options.slugs) {
    try {
      lessons.push(await lessonBySlug(fetch, slug));
    } catch (error) {
      console.error(`skipped ${slug}: ${(error as Error).message}`);
    }
  }
  return lessons;
}

const elapsed = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)} s`;

async function run(folder: string) {
  // The app's bundler loads the diff codec as a WASM-ESM import; under bun it is
  // built from its bytes and installed, as studio-compare.ts does.
  const { installDmpCodec, instantiateDmpCodec } = await import("../src/core/dmp/dmpCodec.ts");
  installDmpCodec(await instantiateDmpCodec(await readFile(DMP_WASM_PATH)));
  const { decompressBinaryToRecording } = await import("../src/storage/recordingCodec.ts");

  let lessons: ListedLesson[];
  try {
    lessons = await listLessons();
  } catch (error) {
    throw new CannotRun(`could not list lessons: ${(error as Error).message}`);
  }
  if (lessons.length === 0) throw new CannotRun("no lessons to check");

  const rows: Row[] = [];
  const spread: string[] = [];
  let downloaded = 0;
  let downloadedBytes = 0;
  for (const lesson of lessons) {
    let bytes: Uint8Array;
    try {
      ({ bytes } = await downloadRecording(fetch, lesson, folder));
    } catch (error) {
      console.error(`skipped ${lesson.slug}: ${(error as Error).message}`);
      continue;
    }
    downloaded += 1;
    downloadedBytes += bytes.byteLength;

    let recording: Recording;
    try {
      recording = await decompressBinaryToRecording(bytes);
    } catch (error) {
      rows.push(unreadableRow(lesson.slug, (error as Error).message));
      spread.push(`${lesson.slug}  could not decode  ${formatSize(bytes.byteLength)}`);
      continue;
    }
    spread.push(spreadLine(lesson.slug, recording, bytes.byteLength, isHumanRecording(lesson)));

    const started = performance.now();
    const seek = checkSeekVsPlay(recording, { ...DEFAULT_SEEK_VS_PLAY, seed: options.seed });
    const seekTook = elapsed(started);
    const cutStarted = performance.now();
    const cut = checkCutLaw(recording, {
      ...DEFAULT_CUT_LAW,
      cuts: options.cuts,
      seed: options.seed,
    });
    console.error(
      `checked ${lesson.slug}: seek vs play ${seekTook}, cut law ${elapsed(cutStarted)}`,
    );
    rows.push(...rowsOf(lesson.slug, seek), ...rowsOf(lesson.slug, cut));
  }
  if (downloaded === 0) throw new CannotRun("no recording could be downloaded");

  console.log(`\nrecordings (${formatSize(downloadedBytes)} downloaded):`);
  for (const line of spread) console.log(`  ${line}`);
  console.log("");
  console.log(formatTable(rows));
  console.log("");
  console.log(
    "The editor handshake arrives right after each file switch here; its delay is covered by\n" +
      "the generated frames property in pathIndependence.test.ts, not by this run.",
  );
  console.log(totalsLine(rows));
}

const startedAt = performance.now();
try {
  await withTempFolder(
    {
      keep: options.keep,
      onKept: (path) => console.log(`kept the downloads in ${path}`),
    },
    run,
  );
  console.log(`took ${elapsed(startedAt)}`);
} catch (error) {
  if (!(error instanceof CannotRun)) throw error;
  console.error(error.message);
  process.exit(1);
}
