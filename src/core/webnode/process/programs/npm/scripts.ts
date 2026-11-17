// Running package.json scripts and executables: the lifecycle environment
// (`npm_lifecycle_event`, `npm_package_*`, `PATH` with every node_modules/.bin
// up to `/`), each tool's header, npm/yarn's pre/post hooks, and the child
// process itself — spawned through the shell with inherited stdio, signals
// forwarded, its status returned (128 + signal number when a signal ended it).
import { EXEC_PATH, NODE_VERSION, ARCH, PLATFORM, DEFAULT_PATH } from "../../platform";
import { runtime } from "../../runtime";
import type { ProcessRuntime } from "../../runtime";
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

/** Linux signal numbers, for the `128 + n` exit status. */
const SIGNALS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

/** The exit status a shell reports for a child that ended with `status`. */
export function exitStatusCode(status: { code: number | null; signal: string | null }): number {
  if (status.signal) {
    return 128 + (SIGNALS[status.signal] ?? 0);
  }
  return status.code ?? 1;
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

let currentChild: number | null = null;
/** Runtimes whose signals are already forwarded (one per process; tests make several). */
const forwarding = new WeakSet<ProcessRuntime>();

/** Spawns `command` with inherited stdio and resolves with its exit status. */
export function spawnAndWait(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<number> {
  const rt = runtime();
  if (!forwarding.has(rt)) {
    forwarding.add(rt);
    rt.processes.onSignal((signal) => {
      if (currentChild === null) {
        return false;
      }
      try {
        rt.processes.kill(currentChild, signal);
      } catch {
        // The child is already gone.
      }
      return true;
    });
  }
  const child = rt.processes.spawn({
    command,
    args,
    cwd,
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  currentChild = child.pid;
  rt.ref();
  return new Promise((resolve) => {
    rt.processes.onExit(child.pid, (status) => {
      if (currentChild === child.pid) {
        currentChild = null;
      }
      rt.unref();
      resolve(exitStatusCode(status));
    });
  });
}

/** Where and how a script runs. */
export interface ScriptContext {
  tool: Tool;
  reporter: Reporter;
  /** The directory holding package.json. */
  projectDir: string;
  manifest: ScriptManifest;
}

/** Runs one script by its event name, printing the tool's header. Resolves with its status. */
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
  if (tool === "pnpm") {
    reporter.line();
    reporter.line(`> ${id}${event} ${context.projectDir}`);
    reporter.line(`> ${line}`);
    reporter.line();
  } else if (tool === "npm") {
    reporter.line();
    reporter.line(`> ${id}${event}`);
    reporter.line(`> ${line}`);
    reporter.line();
  } else {
    reporter.line(`$ ${line}`);
  }
  await reporter.sink.flush();
  const env = scriptEnv({
    tool,
    base: runtime().env,
    projectDir: context.projectDir,
    manifest,
    event,
    script,
  });
  return spawnAndWait("sh", ["-c", line], context.projectDir, env);
}

function reportFailure(context: ScriptContext, event: string, status: number): void {
  const { reporter } = context;
  const script = context.manifest.scripts?.[event] ?? "";
  if (context.tool === "pnpm") {
    reporter.sink.write(2, ` ELIFECYCLE  Command failed with exit code ${status}.\n`);
  } else if (context.tool === "npm") {
    reporter.sink.write(
      2,
      [
        `npm error Lifecycle script \`${event}\` failed with error:`,
        `npm error code ${status}`,
        `npm error path ${context.projectDir}`,
        `npm error command failed`,
        `npm error command sh -c ${script}`,
        "",
      ].join("\n"),
    );
  } else if (context.tool === "yarn") {
    reporter.sink.write(2, `error Command failed with exit code ${status}.\n`);
  } else {
    reporter.sink.write(2, `error: script "${event}" exited with code ${status}\n`);
  }
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
 * every tool runs them (pnpm since v8, bun). Resolves with the exit status; failures print the
 * tool's lifecycle error.
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
      reportFailure(context, event, status);
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
