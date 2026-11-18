// Running package.json scripts and executables: the lifecycle environment
// (`npm_lifecycle_event`, `npm_package_*`, `PATH` with every node_modules/.bin
// up to `/`), each tool's header, the pre/post hooks, and the child process
// itself: spawned with inherited stdio, sent the signals its tool passes on,
// and its end taken as its tool takes it (what the tool prints, the status
// it exits with, and whether it dies of the signal that ended the child).
import { exitStatusNumber } from "../../../signals";
import { EXEC_PATH, NODE_VERSION, ARCH, PLATFORM, DEFAULT_PATH } from "../../platform";
import { runtime } from "../../runtime";
import type { ExitStatus, ProcessRuntime } from "../../runtime";
import { PmError } from "./errors";
import { TOOL_VERSIONS, formatDuration } from "./output";
import type { Reporter, Tool } from "./output";
import { ancestors, join } from "./paths";

/** The fields of package.json that scripts read. */
export interface ScriptManifest {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
}

/** Quotes `arg` for `sh` when it needs it. */
export function shellQuote(arg: string): string {
  if (arg !== "" && /^[\w@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Every `node_modules/.bin` from `dir` up to `/`, nearest first. */
export function binDirs(dir: string): string[] {
  return ancestors(dir).map((ancestor) => join(ancestor, "node_modules/.bin"));
}

/** `npm_config_user_agent` for `tool`. */
export function userAgent(tool: Tool): string {
  const npm = tool === "npm" ? "" : " npm/?";
  const tail = tool === "npm" ? " workspaces/false" : "";
  return `${tool}/${TOOL_VERSIONS[tool]}${npm} node/v${NODE_VERSION} ${PLATFORM} ${ARCH}${tail}`;
}

/** The path a tool reports as `npm_execpath`. */
export function execPath(tool: Tool): string {
  return `/bin/${tool}`;
}

/** `base` with every node_modules/.bin from `dir` up prepended to `PATH`. */
export function pathWithBins(base: Record<string, string>, dir: string): Record<string, string> {
  const rest = base.PATH ?? DEFAULT_PATH;
  return { ...base, PATH: [...binDirs(dir), rest].filter(Boolean).join(":") };
}

/** The environment a lifecycle script runs with. */
export function scriptEnv(options: {
  tool: Tool;
  base: Record<string, string>;
  projectDir: string;
  manifest: ScriptManifest;
  event: string;
  script: string;
}): Record<string, string> {
  const { tool, manifest, projectDir } = options;
  const env = pathWithBins(options.base, projectDir);
  env.npm_lifecycle_event = options.event;
  env.npm_lifecycle_script = options.script;
  if (manifest.name !== undefined) {
    env.npm_package_name = manifest.name;
  }
  if (manifest.version !== undefined) {
    env.npm_package_version = manifest.version;
  }
  env.npm_package_json = join(projectDir, "package.json");
  env.npm_config_user_agent = userAgent(tool);
  env.npm_execpath = execPath(tool);
  env.npm_node_execpath = EXEC_PATH;
  env.NODE = EXEC_PATH;
  env.INIT_CWD = options.base.INIT_CWD ?? runtime().cwd;
  return env;
}

/**
 * The signals each tool passes on to what it runs, living on until that has
 * ended: npm's run-script and pnpm's lifecycle handle SIGINT and SIGTERM;
 * yarn 1 handles SIGTERM only, so Ctrl+C ends yarn itself. A signal a tool
 * does not pass on ends it, and so does any signal while it runs nothing.
 */
const PASSED_ON: Readonly<Record<Tool, readonly string[]>> = {
  npm: ["SIGINT", "SIGTERM"],
  pnpm: ["SIGINT", "SIGTERM"],
  yarn: ["SIGTERM"],
  bun: ["SIGINT", "SIGTERM"],
};

/**
 * The signals a Node program survives sending itself: Node ignores SIGPIPE
 * and starts its inspector on SIGUSR1. npm, pnpm and yarn are Node programs,
 * so a child that one of these ended does not take them with it.
 */
const NODE_SURVIVES = new Set(["SIGPIPE", "SIGUSR1"]);

/** The child in the foreground, and the tool that waits for it. */
let foreground: { pid: number; tool: Tool } | null = null;
/** Runtimes whose signals are already listened for (one per process; tests make several). */
const listening = new WeakSet<ProcessRuntime>();

/**
 * Declares the signals the tool handles, as Node does for npm, pnpm and yarn
 * from their start: SIGPIPE is ignored, so a write to a pipe whose reader
 * has gone fails with EPIPE instead (`Sink.lostReader`); SIGINT, SIGTERM and
 * SIGHUP are passed on to what the tool runs (`PASSED_ON`), or end it.
 */
export function handleSignals(): void {
  const rt = runtime();
  if (listening.has(rt)) {
    return;
  }
  listening.add(rt);
  rt.processes.setHandledSignals(["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"]);
  rt.processes.onSignal((signal) => {
    if (signal === "SIGPIPE") {
      return true;
    }
    if (foreground === null || !PASSED_ON[foreground.tool].includes(signal)) {
      return false;
    }
    try {
      rt.processes.kill(foreground.pid, signal);
    } catch {
      // The child is already gone.
    }
    return true;
  });
}

/** Spawns `command` with inherited stdio, passing `tool`'s signals on to it; resolves with how it ended. */
function spawnForeground(
  tool: Tool,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<ExitStatus> {
  const rt = runtime();
  handleSignals();
  const child = rt.processes.spawn({
    command,
    args,
    cwd,
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  foreground = { pid: child.pid, tool };
  rt.ref();
  return new Promise((resolve) => {
    rt.processes.onExit(child.pid, (status) => {
      if (foreground?.pid === child.pid) {
        foreground = null;
      }
      rt.unref();
      resolve(status);
    });
  });
}

/** What a tool ran, as its reports name it. */
export interface Ran {
  /** Where it ran: npm's `path`. */
  cwd: string;
  /** The command line, as `sh -c` got it. */
  line: string;
  /** A lifecycle script's event name; null for a command (`exec`, `npx`, a bin by its name). */
  event: string | null;
  /** A script that `install` ran: npm reports its failure, where `run` leaves the word to the script. */
  install: boolean;
}

/** npm's report of a command that failed: its exit code, or the signal that ended it. */
function npmCommandFailed(ran: Ran, how: { code: number } | { signal: string }): string {
  return [
    ...("code" in how ? [`npm error code ${how.code}`] : []),
    `npm error path ${ran.cwd}`,
    "npm error command failed",
    ...("signal" in how ? [`npm error signal ${how.signal}`] : []),
    `npm error command sh -c ${ran.line}`,
    "",
  ].join("\n");
}

/**
 * What a tool prints when what it ran exits with `code`, not 0. npm prints
 * nothing for `run`, `start`, `test` and `exec`: they are shell-out commands,
 * whose script is taken to have said what went wrong, so npm 10 and 11 pass
 * its status on silently (their "Lifecycle script … failed" lines are for
 * workspaces only); a script of `install` is reported. The others report a
 * script, and say nothing of a command.
 */
function reportExit(reporter: Reporter, ran: Ran, code: number): void {
  const { tool, sink } = reporter;
  if (tool === "npm") {
    if (ran.install) {
      reporter.npmLog(npmCommandFailed(ran, { code }));
    }
  } else if (ran.event === null) {
    return;
  } else if (tool === "pnpm") {
    sink.write(
      2,
      ran.event === "test"
        ? " ELIFECYCLE  Test failed. See above for more details.\n"
        : ` ELIFECYCLE  Command failed with exit code ${code}.\n`,
    );
  } else if (tool === "yarn") {
    sink.write(2, `error Command failed with exit code ${code}.\n`);
  } else {
    sink.write(2, `error: script "${ran.event}" exited with code ${code}\n`);
  }
}

/**
 * The status a tool goes on with once what it ran has ended: 0 to go on,
 * anything else to exit with, its report printed.
 *
 * A signal that ended the child is each tool's own matter:
 * - npm sends itself the same signal (@npmcli/run-script), so it dies of it
 *   and prints nothing. A signal Node survives leaves npm to report it and
 *   exit 1 (after 500 ms, which is not waited for here).
 * - pnpm takes a script SIGINT ended for one that ended well. Any other
 *   signal it sends itself and reports: the signal ends it (SIGKILL before
 *   it has said anything) unless Node survives the signal: then it exits 1.
 * - yarn reports the signal and exits 1.
 * - A command pnpm, yarn or bun ran by name (`exec`, `dlx`, a bin), and a
 *   script of bun's, give the status a shell reports: 128 + the signal's
 *   number.
 * A tool that dies of the signal is ended by the kernel as the signal ends a
 * process (`die`), so what started it sees the signal; nothing may follow.
 */
async function conclude(reporter: Reporter, ran: Ran, status: ExitStatus): Promise<number> {
  const { tool, sink } = reporter;
  const { signal } = status;
  if (signal === null) {
    const code = status.code ?? 1;
    if (code !== 0) {
      reportExit(reporter, ran, code);
    }
    return code;
  }
  if (tool === "npm") {
    if (NODE_SURVIVES.has(signal)) {
      reporter.npmLog(npmCommandFailed(ran, { signal }));
      return 1;
    }
  } else if (tool === "pnpm" && ran.event !== null) {
    if (signal === "SIGINT") {
      return 0;
    }
    if (signal !== "SIGKILL") {
      sink.write(2, " ELIFECYCLE  Command failed.\n");
    }
    if (NODE_SURVIVES.has(signal)) {
      return 1;
    }
  } else if (tool === "yarn" && ran.event !== null) {
    sink.write(2, `error Command failed with signal "${signal}".\n`);
    return 1;
  } else {
    const code = exitStatusNumber(status);
    reportExit(reporter, ran, code);
    return code;
  }
  await sink.flush();
  runtime().processes.die(signal);
  return exitStatusNumber(status);
}

/**
 * What pnpm prints as it dies of a write to output whose reader has gone:
 * Node's report of an 'error' event nobody listens for. pnpm prints a
 * script's header with `console.log`, whose first EPIPE Node's console takes,
 * but the next write's error is emitted with no listener left.
 */
const PNPM_EPIPE_REPORT = [
  "node:events:496",
  "      throw er; // Unhandled 'error' event",
  "      ^",
  "",
  "Error: write EPIPE",
  "Emitted 'error' event on Socket instance at:",
  "    at emitErrorNT (node:internal/streams/destroy:170:8)",
  "    at emitErrorCloseNT (node:internal/streams/destroy:129:3)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {",
  "  errno: -32,",
  "  code: 'EPIPE',",
  "  syscall: 'write'",
  "}",
  "",
  `Node.js v${NODE_VERSION}`,
  "",
].join("\n");

/**
 * Runs `command` in the foreground for `reporter`'s tool: the child has the
 * tool's stdio and gets the signals the tool passes on. Resolves with the
 * status the tool goes on with (see `conclude`).
 *
 * When what the tool printed before (the command's header) found its reader
 * gone, each tool ends as it does (npm 11.20 on macOS, npm 10.9 on Linux,
 * pnpm 9.12):
 * - npm has no handler for an error of its own output: it has started the
 *   command already when the EPIPE comes, and ends at once with 1, saying
 *   nothing. The command runs on to its end without it; nothing that would
 *   have followed (a post script) runs.
 * - pnpm survives the first such write and dies of the next one (exit code 1,
 *   Node's report of the unhandled error on stderr), before it starts the
 *   command that write was the header of. A lone script runs and pnpm exits
 *   with its status; with a pre script, only the pre script runs.
 * - yarn goes on, its output dropped.
 *
 * npm's children see the log level it was given (`npm_config_loglevel`), as
 * npm puts its configuration in the environment of what it runs.
 */
export async function runForeground(
  reporter: Reporter,
  command: string,
  args: string[],
  env: Record<string, string>,
  ran: Ran,
): Promise<number> {
  const { tool, sink } = reporter;
  await sink.flush();
  if (tool === "pnpm" && sink.lostWrites > 1) {
    sink.write(2, PNPM_EPIPE_REPORT);
    await sink.flush();
    return 1;
  }
  const childEnv =
    tool === "npm" && reporter.loglevel !== null
      ? { ...env, npm_config_loglevel: reporter.loglevel }
      : env;
  const ended = spawnForeground(tool, command, args, ran.cwd, childEnv);
  if (tool === "npm" && sink.lostReader) {
    return 1;
  }
  return conclude(reporter, ran, await ended);
}

/** Where and how a script runs. */
export interface ScriptContext {
  tool: Tool;
  reporter: Reporter;
  /** The directory holding package.json. */
  projectDir: string;
  manifest: ScriptManifest;
  /** The scripts are those of an install (`preinstall` … `prepare`), not of `run`. */
  install: boolean;
}

/**
 * Runs one script by its event name, printing the tool's header. Resolves
 * with the status the tool goes on with, the tool's report of a failure
 * printed (see `conclude`).
 */
export async function runLifecycle(
  context: ScriptContext,
  event: string,
  extraArgs: string[],
): Promise<number> {
  const script = context.manifest.scripts?.[event];
  if (script === undefined) {
    return 0;
  }
  const line = [script, ...extraArgs.map(shellQuote)].join(" ");
  const { reporter, manifest, tool } = context;
  const id = manifest.name
    ? `${manifest.name}${manifest.version ? `@${manifest.version}` : ""} `
    : "";
  // The header in one write, as each tool prints it: a reader that takes
  // only its first line (`| head -1`) has had all of it. npm prints none at
  // log level silent.
  if (tool === "pnpm") {
    reporter.line(["", `> ${id}${event} ${context.projectDir}`, `> ${line}`, ""].join("\n"));
  } else if (tool === "npm") {
    if (!reporter.silent) {
      reporter.line(["", `> ${id}${event}`, `> ${line}`, ""].join("\n"));
    }
  } else {
    reporter.line(`$ ${line}`);
  }
  const env = scriptEnv({
    tool,
    base: runtime().env,
    projectDir: context.projectDir,
    manifest,
    event,
    script,
  });
  return runForeground(reporter, "sh", ["-c", line], env, {
    cwd: context.projectDir,
    line,
    event,
    install: context.install,
  });
}

/** The error a tool gives for `run` of a script the manifest lacks. */
export function missingScript(tool: Tool, name: string): PmError {
  if (tool === "npm") {
    return new PmError("ENOSCRIPT", `Missing script: "${name}"`, [
      "",
      "To see a list of scripts, run:",
      "  npm run",
    ]);
  }
  if (tool === "yarn") {
    return new PmError("ENOSCRIPT", `Command "${name}" not found.`);
  }
  if (tool === "bun") {
    return new PmError("ENOSCRIPT", `Script not found "${name}"`);
  }
  return new PmError("ENOSCRIPT", `Missing script: ${name}`, [`Command "${name}" not found.`]);
}

/**
 * `run <name> [args]`: the script with its `pre`/`post` hooks around it, as
 * every tool runs them (pnpm since v8, bun). Resolves with the exit status;
 * the first script that fails ends the run.
 */
export async function runScript(
  context: ScriptContext,
  name: string,
  args: string[],
): Promise<number> {
  const started = Date.now();
  const scripts = context.manifest.scripts ?? {};
  if (scripts[name] === undefined) {
    throw missingScript(context.tool, name);
  }
  if (context.tool === "yarn") {
    context.reporter.line(`yarn run v${TOOL_VERSIONS.yarn}`);
  }
  for (const event of [`pre${name}`, name, `post${name}`]) {
    if (scripts[event] === undefined) {
      continue;
    }
    const status = await runLifecycle(context, event, event === name ? args : []);
    if (status !== 0) {
      return status;
    }
  }
  if (context.tool === "yarn") {
    context.reporter.line(`Done in ${formatDuration("yarn", Date.now() - started)}.`);
  }
  return 0;
}

/** Prints the scripts of a manifest (`run` with no name). */
export function listScripts(context: ScriptContext): void {
  const entries = Object.entries(context.manifest.scripts ?? {});
  const { reporter } = context;
  if (reporter.silent) {
    return;
  }
  if (entries.length === 0) {
    if (context.tool === "pnpm") {
      reporter.line("There are no scripts specified.");
    }
    return;
  }
  if (context.tool === "npm") {
    const id = context.manifest.name
      ? `${context.manifest.name}@${context.manifest.version ?? ""}`
      : "";
    reporter.line(`Scripts available in ${id} via \`npm run-script\`:`);
    for (const [name, script] of entries) {
      reporter.line(`  ${name}`);
      reporter.line(`    ${script}`);
    }
    return;
  }
  reporter.line(context.tool === "pnpm" ? 'Commands available via "pnpm run":' : "Scripts:");
  for (const [name, script] of entries) {
    reporter.line(`  ${name}`);
    reporter.line(`    ${script}`);
  }
}
