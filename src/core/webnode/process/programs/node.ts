// The `node` command: reads its options, installs Node's globals, runs the
// entry file (or `-e` code, or a worker thread's script) and keeps the process
// alive for as long as something is pending, as Node's event loop does.
import { NODE_VERSION } from "../platform";
import { runtime } from "../runtime";
import {
  configureLoader,
  importModule,
  Module,
  onMainModule,
  runEntry,
  runSource,
} from "../loader/modules";
import { findPackageScope, resolveSpecifier } from "../loader/resolve";
import {
  DYNAMIC_IMPORT_BINDING,
  prepareSource,
  sourceUrlComment,
  transformReady,
} from "../loader/transform";
import { installGlobals } from "../node/globals";
import { loadBuiltin, setProcessBuiltins } from "../node/index";
import path from "../node/path";
import { createProcess, runNextTicks, unhandledRejectionError } from "../node/process";
import type { NodeProcess } from "../node/process";
import util from "../node/util";
import { THREAD_ERROR_MESSAGE, THREAD_ONLINE_MESSAGE } from "../node/worker_threads";
import type { ProcessClient } from "../sysClient";
import { pathWithBins, shellQuote, spawnAndWait } from "./npm/scripts";
import type { ProcessInit } from "../../protocol";

interface NodeOptions {
  evalSource: string | null;
  print: boolean;
  requires: string[];
  imports: string[];
  conditions: string[];
  inputType: string | null;
  envFiles: { path: string; ifExists: boolean }[];
  /** `--run <script>`: the package.json script to run instead of a file. */
  run: string | null;
  watch: boolean;
  readStdin: boolean;
  script: string | null;
  scriptArgs: string[];
  /** The options before the script, as `process.execArgv`. */
  execArgv: string[];
  version: boolean;
  help: boolean;
}

/** Options whose value is the next argument (`node --help` lists them as `--name=...`). */
const VALUE_OPTIONS = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-r",
  "--require",
  "--import",
  "-C",
  "--conditions",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--env-file-if-exists",
  "--run",
  "--title",
  "--input-type",
  "--stack-trace-limit",
  "--max-http-header-size",
  "--max-old-space-size",
  "--max-semi-space-size",
  "--stack-size",
  "--watch-path",
  "--watch-kill-signal",
  "--inspect-port",
  "--inspect-publish-uid",
  "--diagnostic-dir",
  "--redirect-warnings",
  "--unhandled-rejections",
  "--disable-warning",
  "--disable-proto",
  "--dns-result-order",
  "--allow-fs-read",
  "--allow-fs-write",
  "--cpu-prof-dir",
  "--cpu-prof-interval",
  "--cpu-prof-name",
  "--heap-prof-dir",
  "--heap-prof-interval",
  "--heap-prof-name",
  "--heapsnapshot-near-heap-limit",
  "--heapsnapshot-signal",
  "--icu-data-dir",
  "--localstorage-file",
  "--max-old-space-size-percentage",
  "--network-family-autoselection-attempt-timeout",
  "--openssl-config",
  "--report-filename",
  "--report-signal",
  "--secure-heap",
  "--secure-heap-min",
  "--snapshot-blob",
  "--test-concurrency",
  "--test-coverage-branches",
  "--test-coverage-exclude",
  "--test-coverage-functions",
  "--test-coverage-include",
  "--test-coverage-lines",
  "--test-global-setup",
  "--test-name-pattern",
  "--test-random-seed",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-skip-pattern",
  "--test-timeout",
  "--tls-cipher-list",
  "--tls-keylog",
  "--trace-event-categories",
  "--trace-event-file-pattern",
  "--trace-require-module",
  "--use-largepages",
  "--v8-pool-size",
]);

function splitWords(text: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    words.push(match[1] ?? match[2] ?? match[3]);
  }
  return words;
}

function parseOptions(args: string[], environment: Record<string, string>): NodeOptions {
  const options: NodeOptions = {
    evalSource: null,
    print: false,
    requires: [],
    imports: [],
    conditions: [],
    inputType: null,
    envFiles: [],
    run: null,
    watch: false,
    readStdin: false,
    script: null,
    scriptArgs: [],
    execArgv: [],
    version: false,
    help: false,
  };

  const apply = (name: string, value: string | undefined) => {
    switch (name) {
      case "-e":
      case "--eval":
        options.evalSource = value ?? "";
        break;
      case "-p":
      case "--print":
        options.evalSource = value ?? "";
        options.print = true;
        break;
      case "-r":
      case "--require":
        options.requires.push(value ?? "");
        break;
      case "--import":
        options.imports.push(value ?? "");
        break;
      case "-C":
      case "--conditions":
        options.conditions.push(value ?? "");
        break;
      case "--input-type":
        options.inputType = value ?? null;
        break;
      case "--env-file":
      case "--env-file-if-exists":
        options.envFiles.push({ path: value ?? "", ifExists: name === "--env-file-if-exists" });
        break;
      case "--run":
        options.run = value ?? "";
        break;
      case "--watch":
        options.watch = true;
        break;
      case "--stack-trace-limit":
        Error.stackTraceLimit = Number(value);
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        // Every other option changes nothing here.
        break;
    }
  };

  let afterDoubleDash = false;
  const consume = (list: string[], allowScript: boolean) => {
    let index = 0;
    while (index < list.length) {
      const argument = list[index];
      if (argument === "--") {
        index += 1;
        afterDoubleDash = allowScript;
        break;
      }
      if (argument === "-" && allowScript) {
        options.readStdin = true;
        index += 1;
        break;
      }
      if (!argument.startsWith("-")) {
        break;
      }
      const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
      const name = equals > 0 ? argument.slice(0, equals) : argument;
      if (equals > 0) {
        apply(name, argument.slice(equals + 1));
        if (allowScript) {
          options.execArgv.push(argument);
        }
        index += 1;
      } else if (VALUE_OPTIONS.has(name)) {
        apply(name, list[index + 1]);
        if (allowScript) {
          options.execArgv.push(argument, list[index + 1] ?? "");
        }
        index += 2;
      } else {
        apply(name, undefined);
        if (allowScript) {
          options.execArgv.push(argument);
        }
        index += 1;
      }
    }
    return list.slice(index);
  };

  consume(splitWords(environment.NODE_OPTIONS ?? ""), false);
  const rest = consume(args, true);
  if (options.run !== null) {
    // `node --run <script> -- <args>`: only what follows `--` goes to the script.
    const dashes = rest.indexOf("--");
    options.scriptArgs = afterDoubleDash ? rest : dashes >= 0 ? rest.slice(dashes + 1) : [];
  } else if (options.evalSource === null && !options.readStdin && rest.length > 0) {
    options.script = rest[0];
    options.scriptArgs = rest.slice(1);
  } else {
    options.scriptArgs = rest;
  }
  return options;
}

function readAllStdin(): string {
  const rt = runtime();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = rt.fs.read(0, 65536, null);
    if (chunk.byteLength === 0) {
      break;
    }
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return util.inspect(error, { colors: false });
  }
  return `Uncaught ${util.inspect(error)}`;
}

/** Runs the `node` program for the worker `init` describes. Does not return to its caller's flow. */
export async function runNode(init: ProcessInit, client: ProcessClient): Promise<void> {
  const rt = runtime();
  const thread = init.thread;
  // A thread's argv is its script's arguments; its options are its execArgv
  // (the parent's, unless the Worker named others), as in Node.
  const options = parseOptions(thread ? init.execArgv : init.argv.slice(1), init.env);
  rt.execArgv = thread ? [...init.execArgv] : [...init.execArgv, ...options.execArgv];

  await transformReady;
  configureLoader({ loadBuiltin, conditions: options.conditions });

  const process: NodeProcess = createProcess({ loadBuiltin, ipc: client.ipc });
  setProcessBuiltins({
    get process() {
      return process;
    },
    get console() {
      return globalThis.console;
    },
  });
  installGlobals(process);
  onMainModule((module) => {
    process.mainModule = module;
  });

  const fatal = (error: unknown): never => {
    try {
      process.stderr.write(`\n${describeError(error)}\n\nNode.js v${NODE_VERSION}\n`);
    } catch {
      // Nothing left to report through.
    }
    process.exitCode = process.exitCode || 1;
    return process.exit(1);
  };

  const reportUncaught = (
    error: unknown,
    origin: "uncaughtException" | "unhandledRejection" = "uncaughtException",
  ) => {
    const handled = (
      process as unknown as { _handleUncaught(error: unknown, origin: string): boolean }
    )._handleUncaught(error, origin);
    if (handled) {
      return;
    }
    if (thread) {
      // A thread's error goes to its parent's `error` event.
      const serialized =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error;
      thread.port.postMessage({ type: THREAD_ERROR_MESSAGE, error: serialized });
      rt.processes.exit(1);
    }
    fatal(error);
  };

  globalThis.addEventListener("error", (event) => {
    event.preventDefault();
    reportUncaught((event as ErrorEvent).error ?? new Error((event as ErrorEvent).message));
  });
  globalThis.addEventListener("unhandledrejection", (event) => {
    const { reason, promise } = event as PromiseRejectionEvent;
    event.preventDefault();
    if (process.listenerCount("unhandledRejection") > 0) {
      process.emit("unhandledRejection", reason, promise);
      return;
    }
    reportUncaught(unhandledRejectionError(reason), "unhandledRejection");
  });
  globalThis.addEventListener("rejectionhandled", (event) => {
    process.emit("rejectionHandled", (event as PromiseRejectionEvent).promise);
  });

  // A thread only takes the options that change how modules load.
  if (options.version && !thread) {
    process.stdout.write(`v${NODE_VERSION}\n`);
    process.exit(0);
  }
  if (options.help && !thread) {
    process.stdout.write(
      "Usage: node [options] [ script.js ] [arguments]\n       node [options] -e script [arguments]\n",
    );
    process.exit(0);
  }

  for (const file of thread ? [] : options.envFiles) {
    try {
      (process as unknown as { loadEnvFile(file: string): void }).loadEnvFile(file.path);
    } catch (error) {
      void error;
      if (file.ifExists) {
        process.stderr.write(`${file.path} not found. Continuing without it.\n`);
        continue;
      }
      process.stderr.write(`node: ${file.path}: not found\n`);
      process.exit(9);
    }
  }

  if (options.run !== null && !thread) {
    process.exit(await runPackageScript(options.run, options.scriptArgs, process));
  }
  if (options.watch && !thread) {
    if (options.evalSource !== null) {
      process.stderr.write("node: either --watch or --eval can be used, not both\n");
      process.exit(9);
    }
    // Restarting on changes is not implemented: say so rather than pretend.
    process.stderr.write(
      "node: --watch is not supported in webnode; the program runs once and is not restarted when files change\n",
    );
  }

  // Exit once nothing is pending: no timer, server, socket, child or request.
  let entryPending = false;
  let checkScheduled = false;
  const nativeSetTimeout = (
    globalThis as unknown as { __webnodeNativeSetTimeout?: typeof setTimeout }
  ).__webnodeNativeSetTimeout!;
  const scheduleExitCheck = () => {
    if (checkScheduled) {
      return;
    }
    checkScheduled = true;
    // Two turns of the event loop: a rejected promise nobody handles is
    // reported in a task of its own, which must get to run before the process
    // decides it has nothing left to do.
    nativeSetTimeout(() => {
      nativeSetTimeout(() => {
        checkScheduled = false;
        if (client.refCount() > 0) {
          return;
        }
        process.emit("beforeExit", process.exitCode ?? 0);
        if (client.refCount() > 0) {
          return;
        }
        if (entryPending) {
          process.stderr.write("Warning: Detected unsettled top-level await\n");
          process.exit(13);
        }
        process.exit(process.exitCode ?? 0);
      }, 0);
    }, 0);
  };
  client.onIdle(scheduleExitCheck);

  // While the entry is still in a top-level await it holds no ref: if nothing
  // else keeps the process alive, the exit check finds it pending and exits
  // 13, as Node does. An `--import` preload that never settles ends the
  // process the same way, but with its exit code, and the entry never runs.
  // Each await below is preceded by a check so that it also runs when nothing
  // ever refs or unrefs.
  try {
    if (options.requires.length > 0) {
      Module._preloadModules(options.requires);
    }
    for (const specifier of options.imports) {
      scheduleExitCheck();
      await importModule(specifier, `${rt.cwd}/[import]`);
    }

    let result: void | Promise<unknown>;
    if (thread) {
      process.argv = ["/bin/node", thread.eval ? "[worker eval]" : thread.filename, ...init.argv];
      thread.port.postMessage({ type: THREAD_ONLINE_MESSAGE });
      result = thread.eval
        ? runSource(thread.filename, `${rt.cwd}/[worker eval]`)
        : runEntry(resolveMain(thread.filename));
    } else if (options.evalSource !== null || options.readStdin || options.script === null) {
      const stdinIsTerminal = rt.tty.isatty(0);
      if (options.evalSource === null && !options.readStdin && stdinIsTerminal) {
        process.stderr.write("node: the interactive REPL is not available in webnode\n");
        process.exit(1);
      }
      const source = options.evalSource ?? readAllStdin();
      const filename = `${rt.cwd}/${options.evalSource === null ? "[stdin]" : "[eval]"}`;
      process.argv = ["/bin/node", ...options.scriptArgs];
      result = runEval(source, filename, options, process);
    } else {
      const main = resolveMain(path.resolve(options.script));
      process.argv = ["/bin/node", main, ...options.scriptArgs];
      result = runEntry(main);
    }

    // What the entry queued with nextTick runs before any promise job it started.
    runNextTicks();
    if (result instanceof Promise) {
      entryPending = true;
      scheduleExitCheck();
      await result;
    }
  } catch (error) {
    reportUncaught(error);
  } finally {
    entryPending = false;
  }
  scheduleExitCheck();
}

/** `node --run <name>`: runs the nearest package.json's script through the shell, as Node does. */
async function runPackageScript(
  name: string,
  args: string[],
  process: NodeProcess,
): Promise<number> {
  const rt = runtime();
  const scope = findPackageScope(rt.cwd);
  if (scope === null) {
    process.stderr.write(`Can't find package.json for directory ${rt.cwd}\n`);
    return 1;
  }
  const manifest = path.join(scope.directory, "package.json");
  const scripts = (scope.json as { scripts?: Record<string, unknown> }).scripts ?? {};
  const script = Object.hasOwn(scripts, name) ? scripts[name] : undefined;
  if (typeof script !== "string") {
    const available = Object.entries(scripts)
      .map(([key, value]) => `  ${key}: ${String(value)}\n`)
      .join("");
    process.stderr.write(
      `Missing script: "${name}" for ${manifest}\n${available ? `\nAvailable scripts are:\n${available}` : ""}`,
    );
    return 1;
  }
  const env = pathWithBins({ ...rt.env }, scope.directory);
  env.NODE_RUN_SCRIPT_NAME = name;
  env.NODE_RUN_PACKAGE_JSON_PATH = manifest;
  const command = [script, ...args.map(shellQuote)].join(" ");
  return spawnAndWait("sh", ["-c", command], scope.directory, env);
}

function resolveMain(script: string): string {
  const resolved = resolveSpecifier(script, `${runtime().cwd}/[main]`, "require", []);
  if ("builtin" in resolved) {
    throw new Error(`Cannot run builtin module ${resolved.builtin} as a script`);
  }
  return resolved.filename;
}

/** Runs `-e` / `-p` / stdin code: a script with `require` in scope, or an ES module. */
function runEval(
  source: string,
  filename: string,
  options: NodeOptions,
  process: NodeProcess,
): void | Promise<unknown> {
  const prepared = prepareSource(
    source,
    filename,
    options.inputType === "module" ? "esm" : options.inputType === "commonjs" ? "cjs" : null,
  );
  if (prepared.format === "esm") {
    return runSource(source, filename, "esm");
  }

  // A script sees these as globals, and `-p` prints its completion value.
  const global = globalThis as unknown as Record<string, unknown>;
  const module = new Module(filename, null);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(runtime().cwd);
  global.require = Module.createRequire(filename);
  global.module = module;
  global.exports = module.exports;
  global.__filename = filename;
  global.__dirname = runtime().cwd;
  global[DYNAMIC_IMPORT_BINDING] = (specifier: unknown) =>
    importModule(String(specifier), filename);
  // eslint-disable-next-line no-eval -- `node -e`/`-p` evaluates the given script
  const value = (0, eval)(`${prepared.code}${sourceUrlComment(filename)}`) as unknown;
  if (options.print) {
    process.stdout.write(`${typeof value === "string" ? value : util.inspect(value)}\n`);
  }
  return undefined;
}
