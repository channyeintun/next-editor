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
// Every script is validated as the studio reads it (YAML, schema, file name
// equals lesson.slug, the studio's default lessons present in their
// languages), and one failure stops the publish. --dry-run prints every
// command and writes nothing. --allow-removals lets a lesson leave the index.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ENGLISH_STUDIO_PLAN_SLUG,
  DEFAULT_STUDIO_PLAN_SLUG,
} from "../src/studio/plans/index.ts";
import { lessonChanges, planPublish } from "../src/studio/plans/publishPlan.ts";
import type { DefaultLesson } from "../src/studio/plans/publishPlan.ts";
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

/** The lessons the studio opens on when the URL names none, each in the language of its voice. */
const DEFAULT_LESSONS: DefaultLesson[] = [
  { slug: DEFAULT_STUDIO_PLAN_SLUG, language: "my" },
  { slug: DEFAULT_ENGLISH_STUDIO_PLAN_SLUG, language: "en" },
];

/** Remote puts after the first, at once. The first runs alone, so only one wrangler refreshes the login. */
const REMOTE_PUTS_AT_ONCE = 4;

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
 * first failure: no put starts after one failed. True when all of them worked.
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
    const problem = await put(command);
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
  if (live) {
    const ancestor = isAncestor(checkout.top, live.index.source, head);
    if (ancestor !== true) {
      refusals.push(
        ancestor === false
          ? `the live index was built from ${live.index.source}, which is not an ancestor of HEAD: publishing would roll lessons back`
          : `the live index was built from "${live.index.source}", which this checkout does not know: fetch, then publish again`,
      );
    }
  }

  const plan = planPublish({ next: index, live, allowRemovals, defaultLessons: DEFAULT_LESSONS });
  refusals.push(...plan.refusals);
  console.log(
    `\n${Object.keys(index.lessons).length} lessons at HEAD ${head.slice(0, 10)}: ` +
      `${plan.added.length} added, ${plan.changed.length} changed, ${plan.removed.length} removed`,
  );
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
