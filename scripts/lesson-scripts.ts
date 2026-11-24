// Publish the lesson scripts the studio reads: each committed LessonScript is
// put in the bucket as an object named by the SHA-256 of its bytes, and then
// the lesson index that names them (src/studio/plans/publishedScripts.ts).
// A new or changed lesson reaches nexteditor.dev/studio with no build and no
// deploy.
//
//   bun scripts/lesson-scripts.ts list --remote|--local
//       the lessons at HEAD against the live index (added, changed, removed),
//       and the files in the working tree that differ from HEAD
//   bun scripts/lesson-scripts.ts publish --remote|--local [--dry-run] [--allow-removals]
//       put what the live index does not have yet, then the index
//
// --remote writes to PRODUCTION, the bucket nexteditor.dev serves. A person
// runs it, or an agent on that person's word; it uses their wrangler login.
// --local writes to the bucket `wrangler dev` keeps on this machine. Only the
// Worker on :8787 reads it: under `vp dev` and `vp preview` the dev server
// answers /api/studio/scripts from the folder itself
// (build/lessonScriptsDevPlugin.ts), so --local is for testing the Worker's
// route.
//
// What is published is HEAD, never the working tree: another session's
// half-written lesson is not published, and cannot stop a publish. HEAD must
// be on origin/main, so what is live is always something everyone can check
// out. The live index is the only record of what was published (there is no
// ledger on this machine): objects whose ids it names are in the bucket, since
// objects are never rewritten or deleted. Its `source` is the commit it was
// built from, and a publish refuses unless that commit is an ancestor of HEAD,
// so a stale checkout or a second machine cannot roll lessons back.
//
// Every script is validated with the schema in this checkout's working tree
// (YAML, schema, file name equals lesson.slug, the studio's default lessons
// present in their languages), and one failure stops the publish. That is not
// necessarily the schema of the studio deployed on the site: a change to the
// schema or the Director must be deployed before a lesson that needs it is
// published. The tool cannot see what is deployed, so it warns when that code
// changed since the commit the live index was built from, or differs from HEAD
// in the working tree. Just before the index is put, the live index is read
// again, and the publish stops if another one wrote it meanwhile. --dry-run
// prints every command and writes nothing. --allow-removals lets a lesson
// leave the index.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STUDIO_DEFAULT_LESSONS } from "../src/studio/plans/index.ts";
import {
  LESSON_SCRIPT_READER_PATHS,
  lessonChanges,
  lessonScriptReaderFiles,
  liveIndexMovedProblem,
  planPublish,
} from "../src/studio/plans/publishPlan.ts";
import {
  lessonFileNameProblem,
  lessonSlugOfFileName,
  publishedScriptFileOf,
} from "../src/studio/plans/publishedScriptEntry.ts";
import {
  PUBLISHED_SCRIPT_CONTENT_TYPE,
  PUBLISHED_SCRIPT_INDEX_CONTENT_TYPE,
  PUBLISHED_SCRIPT_INDEX_KEY,
  PUBLISHED_SCRIPT_INDEX_VERSION,
  encodePublishedScriptIndex,
  parsePublishedScriptIndex,
  publishedScriptObjectKey,
} from "../src/studio/plans/publishedScripts.ts";
import type {
  PublishedScriptEntry,
  PublishedScriptIndex,
} from "../src/studio/plans/publishedScripts.ts";
import { lessonScriptsDir } from "./lessonScriptsDir.ts";
import { boundBucketName } from "./r2Bucket.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER_CONFIG = resolve(ROOT, "infra/wrangler.toml");

/**
 * Remote puts after the first, at once. The first runs alone, so only one
 * wrangler refreshes the login. Two, not more: with four, the bucket's API
 * answered "internal error, please try again" within the first forty puts.
 */
const REMOTE_PUTS_AT_ONCE = 2;

/**
 * How often one put is tried before the publish stops. The pause doubles from
 * the first one up to the longest, about a minute of patience in all: a
 * publish that stops has to put every object again, since it keeps no record.
 */
const PUT_ATTEMPTS = 6;
const PUT_FIRST_PAUSE_MS = 2_000;
const PUT_LONGEST_PAUSE_MS = 30_000;

type Destination = "remote" | "local";

// ---------------------------------------------------------------- git

/** The repository that holds the scripts folder, and the folder's path inside it. */
interface ScriptsCheckout {
  top: string;
  /** The folder from the checkout's root, with a trailing slash ("src/studio/scripts/"). */
  prefix: string;
}

function git(cwd: string, args: string[], input?: Buffer): Buffer {
  const result = spawnSync("git", args, { cwd, input, maxBuffer: 1 << 30 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

/** Whether `ancestor` is an ancestor of `commit` (or the same commit); null when git does not know one of them. */
function isAncestor(cwd: string, ancestor: string, commit: string): boolean | null {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, commit], { cwd });
  return result.status === 0 ? true : result.status === 1 ? false : null;
}

function scriptsCheckout(): ScriptsCheckout {
  const dir = lessonScriptsDir();
  const [top, prefix] = git(dir, ["rev-parse", "--show-toplevel", "--show-prefix"])
    .toString()
    .split("\n");
  return { top, prefix };
}

/** Every `*.yaml` in the scripts folder at HEAD: its file name and its bytes. */
function headScripts(checkout: ScriptsCheckout): { name: string; bytes: Uint8Array }[] {
  const listing = git(checkout.top, ["ls-tree", "-z", "HEAD", "--", checkout.prefix || "."])
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [, type, object] = meta.split(" ");
      return { type, object, name: path.slice(checkout.prefix.length) };
    })
    .filter((item) => item.type === "blob" && item.name.endsWith(".yaml"))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  // One git process for every blob: the blobs ls-tree named at HEAD, so these
  // are HEAD's bytes, as `git show HEAD:<file>` gives them.
  const batch = git(
    checkout.top,
    ["cat-file", "--batch"],
    Buffer.from(listing.map((item) => `${item.object}\n`).join("")),
  );
  let at = 0;
  return listing.map((item) => {
    const headerEnd = batch.indexOf(0x0a, at);
    const [object, type, size] = batch.subarray(at, headerEnd).toString().split(" ");
    if (object !== item.object || type !== "blob") {
      throw new Error(`git cat-file gave ${object} ${type} for ${item.name}`);
    }
    const start = headerEnd + 1;
    const bytes = new Uint8Array(batch.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
    return { name: item.name, bytes };
  });
}

/** The index HEAD's scripts make, and every file that cannot be in it, with the reason. */
async function headIndex(
  checkout: ScriptsCheckout,
  head: string,
): Promise<{ index: PublishedScriptIndex; failures: string[]; bytesOf: Map<string, Uint8Array> }> {
  const lessons = Object.create(null) as Record<string, PublishedScriptEntry>;
  const failures: string[] = [];
  const bytesOf = new Map<string, Uint8Array>();
  for (const { name, bytes } of headScripts(checkout)) {
    const file = `${checkout.prefix}${name}`;
    try {
      const { entry, script } = await publishedScriptFileOf(bytes);
      const problem = lessonFileNameProblem(name, script.lesson.slug);
      if (problem) {
        failures.push(`${file}: ${problem}`);
        continue;
      }
      lessons[lessonSlugOfFileName(name)!] = entry;
      bytesOf.set(entry.id, bytes);
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    index: { version: PUBLISHED_SCRIPT_INDEX_VERSION, source: head, lessons },
    failures,
    bytesOf,
  };
}

/** The scripts in the working tree that are not as HEAD has them: these are not published. */
function workingTreeChanges(checkout: ScriptsCheckout): string[] {
  return git(checkout.top, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    "--",
    checkout.prefix || ".",
  ])
    .toString()
    .split("\0")
    .filter((line) => line.length > 3 && line.endsWith(".yaml"))
    .map((line) => `${line.slice(0, 2)} ${line.slice(3)}`);
}

/**
 * Why the deployed studio may not read what HEAD's scripts need: the files it
 * reads scripts with that changed between the commit the live index was built
 * from and HEAD, and those that differ from HEAD in the working tree (they
 * validate this publish, yet are in no commit). Warnings, not refusals: a
 * deploy after that commit may already carry the change.
 */
function readerWarnings(checkout: ScriptsCheckout, liveSource: string | null): string[] {
  const paths = [...LESSON_SCRIPT_READER_PATHS];
  const warnings: string[] = [];
  // The reader is this repository's code; the live source is a commit of the
  // scripts' checkout. They can be compared only when that is this repository.
  if (liveSource !== null && resolve(checkout.top) === resolve(ROOT)) {
    const changed = lessonScriptReaderFiles(
      git(ROOT, ["diff", "--name-only", liveSource, "HEAD", "--", ...paths])
        .toString()
        .split("\n")
        .filter(Boolean),
    );
    if (changed.length > 0) {
      warnings.push(
        `the script schema or the Director changed since ${liveSource.slice(0, 10)}, the commit the live index was built from ` +
          `(${changed.join(", ")}): a lesson that needs the change fails on the site until a studio built from HEAD is deployed`,
      );
    }
  }
  const uncommitted = lessonScriptReaderFiles(
    git(ROOT, ["status", "--porcelain", "-z", "--", ...paths])
      .toString()
      .split("\0")
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3)),
  );
  if (uncommitted.length > 0) {
    warnings.push(
      `the scripts were validated with a schema or Director that is not HEAD's (${uncommitted.join(", ")} differ in the working tree)`,
    );
  }
  return warnings;
}

// ---------------------------------------------------------------- bucket

/** The bucket the Worker binds as BUCKET, as infra/wrangler.toml names it. */
function bucketName(): string {
  return boundBucketName(WRANGLER_CONFIG);
}

/** A command as a person would type it, for the log and for --dry-run. */
function printable(command: string[]): string {
  return command.map((arg) => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg}'`)).join(" ");
}

function wrangler(destination: Destination, args: string[]): string[] {
  return [
    "bunx",
    "wrangler",
    "r2",
    "object",
    ...args,
    "--config",
    WRANGLER_CONFIG,
    `--${destination}`,
  ];
}

/** The live index and its text, or null when nothing was published to this bucket yet. */
function liveIndex(
  bucket: string,
  destination: Destination,
): { index: PublishedScriptIndex; text: string } | null {
  const command = wrangler(destination, [
    "get",
    `${bucket}/${PUBLISHED_SCRIPT_INDEX_KEY}`,
    "--pipe",
  ]);
  console.log(printable(command));
  const result = spawnSync(command[0], command.slice(1), { cwd: ROOT, maxBuffer: 1 << 28 });
  if (result.status !== 0) {
    const stderr = result.stderr.toString();
    if (stderr.includes("The specified key does not exist.")) {
      return null;
    }
    throw new Error(`reading the live index failed:\n${stderr.trim()}`);
  }
  const index = parsePublishedScriptIndex(JSON.parse(result.stdout.toString()));
  // Compared in its own encoding, which is the one a publish stores, so a
  // byte wrangler adds to what it pipes does not count as a change.
  return { index, text: encodePublishedScriptIndex(index) };
}

/** Run one put; the result is null when it worked, else what wrangler said. */
function put(command: string[]): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error) => done(String(error)));
    child.on("close", (status) => done(status === 0 ? null : output.trim() || `exit ${status}`));
  });
}

/**
 * Run the puts in order: the first alone, so only one wrangler refreshes an
 * expired login and writes it back, then `atOnce` at a time. Stops at the
 * first put that fails every try: no put starts after that. True when all of
 * them worked.
 */
async function putAll(
  commands: { label: string; command: string[] }[],
  atOnce: number,
): Promise<boolean> {
  let next = 0;
  let done = 0;
  let failed = false;
  const putNext = async () => {
    const { label, command } = commands[next++];
    let problem = await put(command);
    // A put names its object by its bytes (or is the index, written whole), so
    // sending it again is safe; a dropped connection on a slow line should not
    // cost the whole publish.
    for (let attempt = 2; problem !== null && attempt <= PUT_ATTEMPTS && !failed; attempt++) {
      console.error(`  putting ${label} failed; trying again (${attempt} of ${PUT_ATTEMPTS})`);
      const pauseMs = Math.min(PUT_FIRST_PAUSE_MS * 2 ** (attempt - 2), PUT_LONGEST_PAUSE_MS);
      await new Promise((resume) => setTimeout(resume, pauseMs));
      problem = await put(command);
    }
    if (problem !== null) {
      failed = true;
      console.error(`putting ${label} failed:\n${problem}`);
      return;
    }
    done += 1;
    console.log(`  put ${label} (${done}/${commands.length})`);
  };
  const worker = async () => {
    while (!failed && next < commands.length) await putNext();
  };
  if (commands.length > 0) await putNext();
  await Promise.all(Array.from({ length: atOnce }, worker));
  return !failed;
}

// ---------------------------------------------------------------- commands

function destinationOf(args: string[], command: string): Destination {
  const remote = args.includes("--remote");
  const local = args.includes("--local");
  if (remote === local) {
    throw new Error(
      `${command} needs exactly one of --remote (production) or --local (wrangler dev's bucket)`,
    );
  }
  return remote ? "remote" : "local";
}

async function list(args: string[]): Promise<number> {
  const destination = destinationOf(args, "list");
  const checkout = scriptsCheckout();
  const head = git(checkout.top, ["rev-parse", "HEAD"]).toString().trim();
  const { index, failures } = await headIndex(checkout, head);
  const live = liveIndex(bucketName(), destination);

  console.log(
    live
      ? `\nHEAD ${head.slice(0, 10)} against the ${destination} index built from ${live.index.source.slice(0, 10)}:`
      : `\nHEAD ${head.slice(0, 10)}; the ${destination} bucket has no lesson index yet:`,
  );
  const changes = lessonChanges(index, live?.index ?? null);
  for (const [label, slugs] of Object.entries(changes)) {
    console.log(`  ${label}: ${slugs.length}`);
    for (const slug of slugs) console.log(`    ${slug}`);
  }
  if (failures.length > 0) {
    console.log(`  not valid at HEAD (a publish refuses): ${failures.length}`);
    for (const failure of failures) console.log(`    ${failure}`);
  }
  const working = workingTreeChanges(checkout);
  console.log(`\nIn the working tree and not at HEAD (not published): ${working.length}`);
  for (const line of working) console.log(`  ${line}`);
  return 0;
}

async function publish(args: string[]): Promise<number> {
  const destination = destinationOf(args, "publish");
  const dryRun = args.includes("--dry-run");
  const allowRemovals = args.includes("--allow-removals");
  const checkout = scriptsCheckout();
  const head = git(checkout.top, ["rev-parse", "HEAD"]).toString().trim();
  const refusals: string[] = [];

  if (isAncestor(checkout.top, "HEAD", "origin/main") !== true) {
    refusals.push(
      `HEAD ${head.slice(0, 10)} is not on origin/main (as this checkout last fetched it): push it first`,
    );
  }
  const { index, failures, bytesOf } = await headIndex(checkout, head);
  refusals.push(...failures);

  const bucket = bucketName();
  const live = liveIndex(bucket, destination);
  const ancestor = live ? isAncestor(checkout.top, live.index.source, head) : null;
  if (live && ancestor !== true) {
    refusals.push(
      ancestor === false
        ? `the live index was built from ${live.index.source}, which is not an ancestor of HEAD: publishing would roll lessons back`
        : `the live index was built from "${live.index.source}", which this checkout does not know: fetch, then publish again`,
    );
  }

  const plan = planPublish({
    next: index,
    live,
    allowRemovals,
    defaultLessons: STUDIO_DEFAULT_LESSONS,
  });
  refusals.push(...plan.refusals);
  console.log(
    `\n${Object.keys(index.lessons).length} lessons at HEAD ${head.slice(0, 10)}: ` +
      `${plan.added.length} added, ${plan.changed.length} changed, ${plan.removed.length} removed`,
  );
  // Compared only with a commit this checkout knows and that HEAD descends from.
  const liveSource = live && ancestor === true ? live.index.source : null;
  for (const warning of readerWarnings(checkout, liveSource)) {
    console.warn(`warning: ${warning}`);
  }
  if (refusals.length > 0) {
    console.error(`\npublish refused:`);
    for (const refusal of refusals) console.error(`  ${refusal}`);
    return 1;
  }
  if (plan.puts.length === 0 && !plan.putIndex) {
    console.log(`the ${destination} index is already HEAD's: nothing to put`);
    return 0;
  }

  // The files wrangler puts from. A dry run makes none and names a stand-in.
  const files = dryRun
    ? join(tmpdir(), "lesson-scripts-XXXXXX")
    : mkdtempSync(join(tmpdir(), "lesson-scripts-"));
  try {
    const puts = plan.puts.map((id) => {
      const file = join(files, id);
      if (!dryRun) writeFileSync(file, bytesOf.get(id)!);
      return {
        label: id.slice(0, 12),
        command: wrangler(destination, [
          "put",
          `${bucket}/${publishedScriptObjectKey(id)}`,
          "--file",
          file,
          "--content-type",
          PUBLISHED_SCRIPT_CONTENT_TYPE,
        ]),
      };
    });
    const indexFile = join(files, "index.json");
    const indexPut = {
      label: "the index",
      command: wrangler(destination, [
        "put",
        `${bucket}/${PUBLISHED_SCRIPT_INDEX_KEY}`,
        "--file",
        indexFile,
        "--content-type",
        PUBLISHED_SCRIPT_INDEX_CONTENT_TYPE,
      ]),
    };

    console.log(
      `${puts.length} objects to put in ${bucket} (${destination}), then ${plan.putIndex ? "the index" : "no index"}`,
    );
    if (dryRun) {
      for (const { command } of puts) console.log(printable(command));
      if (plan.putIndex) console.log(printable(indexPut.command));
      return 0;
    }
    // Local puts each start their own copy of the local bucket on one folder: one at a time.
    if (!(await putAll(puts, destination === "remote" ? REMOTE_PUTS_AT_ONCE : 1))) {
      console.error(
        "publish stopped: the index was not put, so nothing reads the objects put so far",
      );
      return 1;
    }
    if (plan.putIndex) {
      const moved = liveIndexMovedProblem(live, liveIndex(bucket, destination));
      if (moved) {
        console.error(`publish stopped: ${moved}`);
        return 1;
      }
      writeFileSync(indexFile, plan.indexText);
      // Last: an index never names an object that is not in the bucket.
      if (!(await putAll([indexPut], 1))) return 1;
    }
    console.log(`published HEAD ${head.slice(0, 10)} to ${bucket} (${destination})`);
    return 0;
  } finally {
    if (!dryRun) rmSync(files, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "list":
      return list(args);
    case "publish":
      return publish(args);
    default:
      console.error(
        "usage: bun scripts/lesson-scripts.ts <list --remote|--local | publish --remote|--local [--dry-run] [--allow-removals]>",
      );
      return 2;
  }
}

process.exit(
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }),
);
