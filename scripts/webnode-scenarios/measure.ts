// How the lessons and starters run on webnode: whether they pass, how long
// the install and the first preview take, and how much memory the tab uses.
// One lesson per dependency setup and every starter, in headless Chrome, one
// browser at a time. This is the measurement the scope rule asks for
// (src/core/webnode/README.md, "Scope"); what to compare its numbers with is
// in src/core/webnode/MEASUREMENTS.md.
//
//   bun scripts/webnode-scenarios/measure.ts              every target, RUNS times
//   bun scripts/webnode-scenarios/measure.ts <target>...  only these: a lesson's slug, starter:<name>
//   bun scripts/webnode-scenarios/measure.ts lessons      every lesson that installs something
//   bun scripts/webnode-scenarios/measure.ts --list       the setups, their lessons, the targets
//   bun scripts/webnode-scenarios/measure.ts --table      the table of the runs recorded so far
//
// RUNS=<n> (3) runs per target; the table shows the median. RESUME=1 keeps
// the runs already recorded and does only
// the missing ones. HOLD=<seconds> leaves the first preview open that long
// before going on, and MEASURE_DEBUG=1 prints every memory sample: together
// they show whether memory grows while a lesson sits open. PROFILE=<dir>
// keeps the browser's profile in that directory, so each run after the first
// is a later visit: it finds what the editor's page keeps between visits (the
// prepared forms of large modules, src/core/webnode/preparedStorage.ts). The
// runs are recorded, one JSON line each, in
// node_modules/.cache/webnode-measure/runs.jsonl (MEASURE_RUNS names another).
//
// One run, in a browser of its own with an empty cache (unless PROFILE):
//   boot     the runtime boots;
//   install  the lesson's init command, as the editor runs it (`sh -lc`), to its exit;
//   preview  from the start of the run command until the preview shows the
//            lesson's page (for a testing lesson: with its first test result),
//            or until a program without a page has printed its output;
//   final    a lesson's files as they are at its end (every `editor.type`
//            applied) are written, and the preview must still show the page.
// Memory is the footprint of Chrome's renderer processes, the figure its task
// manager shows: the tab, the runtime's and the preview's frames and all their
// workers. Chrome names the processes; macOS is asked for each one's footprint
// four times a second (so memory is measured on a Mac only). `peak` is the
// highest sum, `end` the last one.
//
// The webnode scripts are built minified, as a deployment ships them. The
// install comes from the npm registry, so the times move with the network.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parse } from "yaml";
import type { Browser } from "playwright-core";
import { plainText } from "./text";

process.env.WEBNODE_HARNESS_OUT ||= "node_modules/.cache/webnode-measure";
process.env.WEBNODE_HARNESS_MINIFY ??= "1";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT_DIR = resolve(ROOT, process.env.WEBNODE_HARNESS_OUT);
const RUNS_FILE = resolve(ROOT, process.env.MEASURE_RUNS || `${OUT_DIR}/runs.jsonl`);

/** What a target's run command leads to. */
type Shows =
  | {
      port: number;
      title: string;
      text?: string;
      result?: RegExp;
      /** The page has no text until the lesson writes it. */
      emptyAtStart?: boolean;
    }
  | { output: string };

interface Target {
  name: string;
  /** The dependency setup it stands for. */
  setup: string;
  files: Record<string, string>;
  /** The files that differ at the lesson's end. */
  finalFiles: Record<string, string>;
  initCommand: string;
  runCommand: string;
  environment: Record<string, string>;
  shows: Shows;
}

interface Run {
  target: string;
  setup: string;
  run: number;
  pass: boolean;
  /** The first step that failed, and how. */
  error: string | null;
  bootMs: number | null;
  installMs: number | null;
  previewMs: number | null;
  peakMb: number | null;
  endMb: number | null;
  /** What the preview showed first, and after the lesson's final files. */
  shown: string | null;
  final: string | null;
  consoleErrors: string[];
}

// ---------------------------------------------------------------- targets

/** The lesson measured for a setup, where the setup has one of these; else its first. */
const PREFERRED_LESSONS = new Set([
  "css-course-01-basics",
  "typescript-course-07-functions",
  "testing-course-02-first-vitest-test",
  "ai-course-07-generative-loop",
  "a11y-course-08-keyboard-focus",
  "react-crash-course-03-state-events",
  "testing-course-19-dom-testing",
]);

/** The testing course's panel once a test run has finished: its status beside the heading. */
const TEST_RESULT = /\bVitest (PASS|FAIL)\b/;

interface LessonScript {
  lesson: { workspace: { files: Record<string, string> } };
  runtime?: {
    kind?: string;
    initCommand?: string;
    runCommand?: string;
    expectedPort?: number;
    environment?: Record<string, string>;
  };
  scenes?: { actions?: LessonAction[] }[];
}
interface LessonAction {
  type: string;
  target?: { file: string; after: string; occurrence?: number };
  text?: string;
}

/** A lesson's files at its end: every `editor.type`, in the script's order. */
function filesAtEnd(slug: string, script: LessonScript): Record<string, string> {
  const files = { ...script.lesson.workspace.files };
  for (const scene of script.scenes ?? []) {
    for (const action of scene.actions ?? []) {
      if (action.type !== "editor.type" || !action.target) {
        continue;
      }
      const { file, after, occurrence = 1 } = action.target;
      const content = files[file];
      let at = -1;
      for (let seen = 0; seen < occurrence; seen += 1) {
        at = content === undefined ? -1 : content.indexOf(after, at + 1);
        if (at < 0) {
          break;
        }
      }
      if (content === undefined || at < 0) {
        throw new Error(`${slug}: an editor.type of ${file} has no place to insert at`);
      }
      const end = at + after.length;
      files[file] = content.slice(0, end) + (action.text ?? "") + content.slice(end);
    }
  }
  return files;
}

interface Setup {
  label: string;
  lessons: string[];
}

/** The label of the setup that installs nothing. */
const NO_DEPENDENCIES = "no dependencies";

function dependenciesOf(files: Record<string, string>): [string, string][] {
  const manifest = files["package.json"] ? JSON.parse(files["package.json"]) : {};
  return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).sort() as [
    string,
    string,
  ][];
}

/** The runtime lessons, grouped by what they install; the largest group first. */
async function lessonSetups(): Promise<{ setups: Setup[]; scripts: Map<string, LessonScript> }> {
  const { LESSON_SCRIPTS } = await import("./lessons");
  const scripts = new Map<string, LessonScript>();
  const groups = new Map<string, string[]>();
  for (const name of readdirSync(LESSON_SCRIPTS).sort()) {
    if (!name.endsWith(".yaml")) {
      continue;
    }
    const script = parse(readFileSync(`${LESSON_SCRIPTS}${name}`, "utf8")) as LessonScript;
    if (script.runtime?.kind !== "webcontainer") {
      continue;
    }
    const slug = name.replace(/\.yaml$/, "");
    scripts.set(slug, script);
    const label =
      dependenciesOf(script.lesson.workspace.files)
        .map(([dependency, version]) => `${dependency}@${version}`)
        .join(" ") || NO_DEPENDENCIES;
    groups.set(label, [...(groups.get(label) ?? []), slug]);
  }
  const setups = [...groups]
    .map(([label, lessons]) => ({ label, lessons }))
    .sort((a, b) => b.lessons.length - a.lessons.length || a.label.localeCompare(b.label));
  return { setups, scripts };
}

async function lessonTarget(slug: string, setup: string, script: LessonScript): Promise<Target> {
  const { titleOf, EMPTY_AT_START } = await import("./lessons");
  const files = script.lesson.workspace.files;
  const atEnd = filesAtEnd(slug, script);
  const manifest = files["package.json"] ? JSON.parse(files["package.json"]) : {};
  // The page's title: index.html's, or the one a component renders (a lesson
  // whose server renders the whole document has no index.html).
  const titled =
    files["index.html"] ?? Object.values(files).find((contents) => /<title>/i.test(contents));
  return {
    name: slug,
    setup,
    files,
    finalFiles: Object.fromEntries(
      Object.entries(atEnd).filter(([path, contents]) => files[path] !== contents),
    ),
    initCommand: script.runtime?.initCommand ?? "",
    runCommand: script.runtime?.runCommand ?? "pnpm dev",
    environment: script.runtime?.environment ?? {},
    shows: script.runtime?.initCommand
      ? {
          port: script.runtime?.expectedPort ?? 5173,
          title: titleOf(titled ?? ""),
          emptyAtStart: EMPTY_AT_START.has(slug),
          ...(manifest.devDependencies?.vitest || manifest.dependencies?.vitest
            ? { result: TEST_RESULT }
            : {}),
        }
      : // A concept lesson: its `dev` script is an `echo`.
        { output: String(manifest.scripts?.dev ?? "").replace(/^echo\s+/, "") },
  };
}

async function starterTargets(): Promise<Target[]> {
  const { STARTERS, STARTERS_ROOT } = await import("./starters");
  const targets: Target[] = [];
  for (const [name, starter] of Object.entries(STARTERS)) {
    const project = (await import(STARTERS_ROOT + starter.file))[starter.factory]();
    const files: Record<string, string> = {};
    for (const [path, file] of Object.entries(
      project.files as Record<string, { content?: string }>,
    )) {
      if (typeof file.content === "string") {
        files[path] = file.content;
      }
    }
    targets.push({
      name: `starter:${name}`,
      setup:
        dependenciesOf(files)
          .map(([dependency, version]) => `${dependency}@${version}`)
          .join(" ") || NO_DEPENDENCIES,
      files,
      finalFiles: {},
      initCommand: "pnpm install",
      runCommand: "pnpm dev",
      environment: {},
      shows: starter.shows,
    });
  }
  return targets;
}

/** Every target: one lesson per setup, then the starters. */
async function allTargets(): Promise<{ targets: Target[]; setups: Setup[] }> {
  const { setups, scripts } = await lessonSetups();
  const targets: Target[] = [];
  for (const setup of setups) {
    const slug = setup.lessons.find((lesson) => PREFERRED_LESSONS.has(lesson)) ?? setup.lessons[0];
    targets.push(await lessonTarget(slug, setup.label, scripts.get(slug)!));
  }
  return { targets: [...targets, ...(await starterTargets())], setups };
}

/** The target `name` names: any runtime lesson, or a starter. */
async function targetNamed(name: string): Promise<Target> {
  const { targets, setups } = await allTargets();
  const known = targets.find((target) => target.name === name);
  if (known) {
    return known;
  }
  const setup = setups.find((one) => one.lessons.includes(name));
  if (!setup) {
    throw new Error(`no runtime lesson or starter named ${name} (see --list)`);
  }
  const { scripts } = await lessonSetups();
  return lessonTarget(name, setup.label, scripts.get(name)!);
}

// ---------------------------------------------------------------- memory

/**
 * Reads a process's physical footprint from macOS, in bytes (`proc_pid_rusage`,
 * the `ri_phys_footprint` of `rusage_info_v4`); null for a process that is gone.
 */
async function footprintReader(): Promise<(pid: number) => number | null> {
  // Bun's foreign-function interface; the project has no types for Bun's own modules.
  const { dlopen, FFIType, ptr } = (await import("bun:ffi" as string)) as {
    dlopen(
      library: string,
      symbols: Record<string, { args: unknown[]; returns: unknown }>,
    ): { symbols: { proc_pid_rusage(pid: number, flavor: number, buffer: unknown): number } };
    FFIType: { i32: unknown; ptr: unknown };
    ptr(view: ArrayBufferView): unknown;
  };
  const { symbols } = dlopen("/usr/lib/libproc.dylib", {
    proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  const RUSAGE_INFO_V4 = 4;
  const usage = new BigUint64Array(64);
  /** `ri_phys_footprint`: the tenth 64-bit field, after the 16-byte uuid and seven counters. */
  const PHYS_FOOTPRINT = 9;
  return (pid) =>
    symbols.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(usage)) === 0
      ? Number(usage[PHYS_FOOTPRINT])
      : null;
}

/**
 * Samples the footprint of the browser's renderer processes four times a
 * second until `stop`, which answers the highest and the last sum, in MB.
 * Chrome names its processes (`SystemInfo.getProcessInfo`); the figure comes
 * from the system, because Chrome's own memory dumps (the tracing domain)
 * wait for every worker to answer, and a worker blocked in a synchronous call
 * holds them up for as long as a dev server runs.
 */
async function sampleMemory(
  browser: Browser,
): Promise<{ stop(): Promise<{ peakMb: number; endMb: number } | null> }> {
  if (process.platform !== "darwin") {
    return { stop: async () => null };
  }
  const session = await browser.newBrowserCDPSession();
  const footprint = await footprintReader();
  const sums: number[] = [];
  let sampling = false;
  const sample = async () => {
    if (sampling) {
      return;
    }
    sampling = true;
    try {
      const { processInfo } = await session.send("SystemInfo.getProcessInfo");
      let bytes = 0;
      for (const one of processInfo) {
        if (one.type === "renderer") {
          bytes += footprint(one.id) ?? 0;
        }
      }
      sums.push(bytes / 2 ** 20);
    } catch {
      // The browser is closing: no sample.
    } finally {
      sampling = false;
    }
  };
  const timer = setInterval(() => void sample(), 250);
  return {
    async stop() {
      clearInterval(timer);
      await sample();
      if (process.env.MEASURE_DEBUG === "1") {
        console.error(`memory, MB per sample: ${sums.map((sum) => Math.round(sum)).join(" ")}`);
      }
      return sums.length ? { peakMb: Math.max(...sums), endMb: sums.at(-1)! } : null;
    },
  };
}

// ---------------------------------------------------------------- one run

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The end of what a command printed, on one line. */
function tail(output: string, lines = 12): string {
  return plainText(output)
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("Progress:"))
    .slice(-lines)
    .join(" | ")
    .slice(-900);
}

async function measure(target: Target, run: number): Promise<Run> {
  const { chromium } = await import("playwright-core");
  const { serve, previewFrame } = await import("../webnode-harness");
  const { tree } = await import("./lessons");
  const result: Run = {
    target: target.name,
    setup: target.setup,
    run,
    pass: false,
    error: null,
    bootMs: null,
    installMs: null,
    previewMs: null,
    peakMb: null,
    endMb: null,
    shown: null,
    final: null,
    consoleErrors: [],
  };
  const server = await serve();
  // A profile kept between runs: a later run is a later visit of the same browser.
  const profile = process.env.PROFILE ? resolve(ROOT, process.env.PROFILE) : null;
  const visit = profile
    ? await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true })
    : null;
  const browser =
    visit?.browser() ?? (await chromium.launch({ channel: "chrome", headless: true }));
  const memory = await sampleMemory(browser);
  try {
    const page = visit ? (visit.pages()[0] ?? (await visit.newPage())) : await browser.newPage();
    const consoleErrors = new Set<string>();
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.add(message.text().slice(0, 240));
      }
    });
    page.on("pageerror", (error) => consoleErrors.add(`pageerror: ${error.message.slice(0, 240)}`));
    await page.goto(server.url);
    const call = <R>(method: string, ...args: unknown[]) =>
      page.evaluate(
        ([name, parameters]) =>
          (
            window as unknown as {
              webnodeHarness: Record<string, (...args: unknown[]) => unknown>;
            }
          ).webnodeHarness[name as string](...(parameters as unknown[])),
        [method, args] as const,
      ) as Promise<R>;
    const fail = (message: string) => new Error(message);
    const env = Object.keys(target.environment).length ? target.environment : undefined;

    let started = Date.now();
    await call("boot");
    result.bootMs = Date.now() - started;
    await call("mount", tree(target.files));

    if (target.initCommand) {
      started = Date.now();
      const install = await call<{ code: number | null; output: string; timedOut: boolean }>(
        "run",
        "sh",
        ["-lc", target.initCommand],
        { timeoutMs: 400000, env },
      );
      if (install.code !== 0) {
        throw fail(
          `${target.initCommand}: ${install.timedOut ? "timed out" : `exit ${install.code}`}: ${tail(install.output)}`,
        );
      }
      result.installMs = Date.now() - started;
    }

    started = Date.now();
    const shows = target.shows;
    if ("output" in shows) {
      const program = await call<{ code: number | null; output: string; timedOut: boolean }>(
        "run",
        "sh",
        ["-lc", target.runCommand],
        { timeoutMs: 120000, env },
      );
      const printed = plainText(program.output).trim();
      if (program.code !== 0 || !printed.endsWith(shows.output)) {
        throw fail(
          `${target.runCommand}: ${program.timedOut ? "timed out" : `exit ${program.code}`}: ${tail(program.output)}`,
        );
      }
      result.previewMs = Date.now() - started;
      result.shown = printed.slice(-200);
    } else {
      // On pipes, as the editor starts a lesson's run command.
      const runner = await call<number>("start", "sh", ["-lc", target.runCommand], env, null);
      const runnerState = () => call<{ output: string; exited: number | null }>("read", runner);
      let url: string | null = null;
      for (const deadline = Date.now() + 120000; url === null;) {
        const servers = await call<{ port: number; url: string }[]>("servers");
        url = servers.find((one) => one.port === shows.port)?.url ?? null;
        if (url === null) {
          const state = await runnerState();
          if (state.exited !== null || Date.now() >= deadline) {
            throw fail(
              `${target.runCommand}: no server on port ${shows.port}: ` +
                `${state.exited !== null ? `it exited ${state.exited}` : "none after 120 s"}: ${tail(state.output)}`,
            );
          }
          await sleep(25);
        }
      }
      const frame = previewFrame(page);
      type View = { title: string; text: string; overlay: string | null } | null;
      /** The page as the lesson starts it: its title, and text unless it starts without any. */
      const atStart = (view: View) =>
        view !== null &&
        view.title === shows.title &&
        view.overlay === null &&
        (shows.text
          ? view.text.includes(shows.text)
          : view.text.length > 0 || !!shows.emptyAtStart) &&
        (shows.result ? shows.result.test(view.text) : true);
      /** The page at the lesson's end: the lesson may have given it another title. */
      const atEnd = (view: View) =>
        view !== null &&
        view.overlay === null &&
        view.text.length > 0 &&
        (shows.result ? shows.result.test(view.text) : true);
      const describe = (view: View) =>
        view === null
          ? "no document"
          : view.overlay !== null
            ? `error overlay: ${view.overlay.slice(0, 500)}`
            : `title ${JSON.stringify(view.title)}, text ${JSON.stringify(view.text.slice(0, 300))}`;
      const waitReady = async (what: string, timeoutMs: number, ready = atStart) => {
        const deadline = Date.now() + timeoutMs;
        let view = await frame.read(url);
        while (!ready(view) && Date.now() < deadline) {
          await sleep(100);
          view = await frame.read(url);
        }
        if (!ready(view)) {
          const state = await runnerState();
          throw fail(
            `${what}: the preview did not show the lesson's page within ${timeoutMs / 1000} s: ` +
              `${describe(view)}; the server printed: ${tail(state.output, 6)}`,
          );
        }
        return view!;
      };
      const stillRunning = async (when: string) => {
        const state = await runnerState();
        if (state.exited !== null) {
          throw fail(`${when}: ${target.runCommand} exited ${state.exited}: ${tail(state.output)}`);
        }
      };

      await frame.show(url);
      const first = await waitReady("first preview", 90000);
      result.previewMs = Date.now() - started;
      result.shown = first.text.slice(0, 300);
      await sleep(2500 + Number(process.env.HOLD ?? 0) * 1000);
      await waitReady("after settling", 1000);
      await stillRunning("after settling");

      if (Object.keys(target.finalFiles).length) {
        for (const [path, contents] of Object.entries(target.finalFiles)) {
          await call("writeFile", path, contents);
        }
        // The dev server takes the change up (a testing lesson runs its tests again).
        await sleep(4000);
        const last = await waitReady("with the lesson's final files", 30000, atEnd);
        await sleep(1500);
        result.final = ((await frame.read(url)) ?? last).text.slice(0, 300);
        await waitReady("with the lesson's final files, after settling", 1000, atEnd);
        await stillRunning("with the lesson's final files");
      }
    }
    result.pass = true;
    result.consoleErrors = [...consoleErrors].slice(0, 6);
  } catch (error) {
    result.error = (error instanceof Error ? error.message : String(error)).slice(0, 1500);
  } finally {
    const sampled = await memory.stop().catch(() => null);
    result.peakMb = sampled ? Math.round(sampled.peakMb) : null;
    result.endMb = sampled ? Math.round(sampled.endMb) : null;
    await (visit ?? browser).close();
    server.stop();
  }
  return result;
}

// ---------------------------------------------------------------- the table

function recordedRuns(): Run[] {
  return existsSync(RUNS_FILE)
    ? readFileSync(RUNS_FILE, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Run)
    : [];
}

function median(values: (number | null)[]): number | null {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
}

const seconds = (ms: number | null) => (ms === null ? "–" : (ms / 1000).toFixed(1));

/** The table of `runs`: one row per target, the median of its runs that passed. */
function table(runs: Run[]): string {
  const rows = [
    "| setup | target | pass | install s | preview s | peak MB | end MB |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const failures: string[] = [];
  for (const name of new Set(runs.map((run) => run.target))) {
    const ofTarget = runs.filter((run) => run.target === name);
    const passed = ofTarget.filter((run) => run.pass);
    rows.push(
      `| ${ofTarget[0].setup} | ${name} | ${[
        `${passed.length}/${ofTarget.length}`,
        seconds(median(passed.map((run) => run.installMs))),
        seconds(median(passed.map((run) => run.previewMs))),
        String(median(passed.map((run) => run.peakMb)) ?? "–"),
        String(median(passed.map((run) => run.endMb)) ?? "–"),
      ].join(" | ")} |`,
    );
    const failed = ofTarget.find((run) => !run.pass);
    if (failed) {
      failures.push(`- ${name}: ${failed.error}`);
    }
  }
  return (
    `The median of the runs that passed.\n\n${rows.join("\n")}` +
    (failures.length ? `\n\nFirst failure of each:\n${failures.join("\n")}` : "")
  );
}

// ---------------------------------------------------------------- main

async function buildPages(): Promise<void> {
  const { buildAll } = await import("../webnode-harness");
  await buildAll();
}

/** One run in a process of its own: Playwright under Bun starts one browser per process. */
async function runInChild(target: string, run: number): Promise<Run> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--one", target, String(run)],
    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
  );
  const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60 * 1000);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  await new Promise((closed) => child.once("close", closed));
  clearTimeout(timer);
  const line = output.split("\n").find((one) => one.startsWith("RESULT "));
  if (line) {
    return JSON.parse(line.slice("RESULT ".length)) as Run;
  }
  const { setup } = await targetNamed(target);
  return {
    target,
    setup,
    run,
    pass: false,
    error: `the run ended without a result (exit ${child.exitCode}): ${output.slice(-400)}`,
    bootMs: null,
    installMs: null,
    previewMs: null,
    peakMb: null,
    endMb: null,
    shown: null,
    final: null,
    consoleErrors: [],
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--one") {
    const [, name, run] = args;
    const result = await measure(await targetNamed(name), Number(run));
    console.log(`RESULT ${JSON.stringify(result)}`);
    process.exit(0);
  }
  if (args[0] === "--table") {
    console.log(table(recordedRuns()));
    return;
  }
  if (args[0] === "--list") {
    const { targets, setups } = await allTargets();
    const total = setups.reduce((sum, setup) => sum + setup.lessons.length, 0);
    console.log(`${total} runtime lessons in ${setups.length} setups:`);
    for (const setup of setups) {
      const target = targets.find(
        (one) => one.setup === setup.label && setup.lessons.includes(one.name),
      );
      console.log(
        `${String(setup.lessons.length).padStart(4)}  ${setup.label}\n        measured: ${target?.name}`,
      );
    }
    console.log("starters:");
    for (const target of targets.filter((one) => one.name.startsWith("starter:"))) {
      console.log(`      ${target.name}  ${target.setup}`);
    }
    return;
  }

  const { targets, setups } = await allTargets();
  const names = args.length
    ? args.flatMap((name) =>
        // `lessons`: every lesson of a setup that has dependencies.
        name === "lessons"
          ? setups
              .filter((setup) => setup.label !== NO_DEPENDENCIES)
              .flatMap((setup) => setup.lessons)
          : [name],
      )
    : targets.map((target) => target.name);
  const runs = Number(process.env.RUNS ?? 3);
  mkdirSync(dirname(RUNS_FILE), { recursive: true });
  const done = process.env.RESUME === "1" ? recordedRuns() : [];
  if (process.env.RESUME !== "1") {
    writeFileSync(RUNS_FILE, "");
  }
  await buildPages();
  for (const name of names) {
    for (let run = 1; run <= runs; run += 1) {
      if (done.some((one) => one.target === name && one.run === run)) {
        continue;
      }
      const result = await runInChild(name, run);
      appendFileSync(RUNS_FILE, `${JSON.stringify(result)}\n`);
      console.log(
        `${result.pass ? "ok  " : "FAIL"} ${name} #${run}: install ${seconds(result.installMs)} s, ` +
          `preview ${seconds(result.previewMs)} s, peak ${result.peakMb} MB, end ${result.endMb} MB` +
          (result.error ? `\n     ${result.error}` : ""),
      );
    }
  }
  console.log(`\n${table(recordedRuns().filter((run) => names.includes(run.target)))}`);
}

await main();
