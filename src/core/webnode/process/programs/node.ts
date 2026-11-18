// The `node` command: reads its options, installs Node's globals, runs the
// entry file (or `-e` code, or a worker thread's script) and keeps the process
// alive for as long as something is pending, as Node's event loop does.
import { NODE_VERSION } from "../platform";
import { runtime } from "../runtime";
import type { ExitStatus } from "../runtime";
import {
  configureLoader,
  importModule,
  Module,
  onMainModule,
  reportUnresolved,
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
import {
  afterTurn,
  eventLoopHolds,
  gateNextMacrotask,
  runMacrotask,
  runNextTicks,
} from "../node/eventLoop";
import { installGlobals } from "../node/globals";
import { writeFd } from "../node/internal/fdWrite";
import { loadBuiltin, setProcessBuiltins } from "../node/index";
import { BUILTIN_MODULE_NAMES } from "../node/names";
import path from "../node/path";
import { createProcess } from "../node/process";
import type { NodeProcess } from "../node/process";
import util from "../node/util";
import {
  postThreadMessage,
  THREAD_ONLINE_MESSAGE,
  threadErrorMessage,
} from "../node/worker_threads";
import type { ProcessClient } from "../sysClient";
import { pathWithBins, shellQuote } from "./npm/scripts";
import { createRejectionReporter, isRejectionMode } from "./rejections";
import type { RejectionMode } from "./rejections";
import { processWatchHost, runWatchSupervisor, watchReporter } from "./watch";
import { TSX_CHILD_OPTION, TSX_WATCH_OPTION } from "./watchOptions";
import type { TsxWatchSettings } from "./watchOptions";
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
  /** `--unhandled-rejections=<mode>`, as given. */
  unhandledRejections: string | null;
  /** `--watch` or `--watch-path`: supervise the program (watch.ts). */
  watch: boolean;
  watchPaths: string[];
  watchPreserveOutput: boolean;
  watchKillSignal: string | null;
  /** Supervise as `tsx watch` does, with these settings (TSX_WATCH_OPTION). */
  tsxWatch: TsxWatchSettings | null;
  /** Started by a tsx watch supervisor (TSX_CHILD_OPTION): "ipc" when the program keeps its channel. */
  tsxChild: "hidden" | "ipc" | null;
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
    unhandledRejections: null,
    watch: false,
    watchPaths: [],
    watchPreserveOutput: false,
    watchKillSignal: null,
    tsxWatch: null,
    tsxChild: null,
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
      case "--unhandled-rejections":
        options.unhandledRejections = value ?? "";
        break;
      case "--watch":
        options.watch = true;
        break;
      case "--watch-path":
        // As in Node, a path to watch starts watch mode by itself.
        options.watch = true;
        options.watchPaths.push(value ?? "");
        break;
      case "--watch-preserve-output":
        options.watchPreserveOutput = true;
        break;
      case "--watch-kill-signal":
        options.watchKillSignal = value ?? "";
        break;
      case TSX_WATCH_OPTION:
        options.watch = true;
        options.tsxWatch = JSON.parse(value ?? "") as TsxWatchSettings;
        break;
      case TSX_CHILD_OPTION:
        options.tsxChild = value === "ipc" ? "ipc" : "hidden";
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
      // webnode's own options for tsx watch never show in process.execArgv.
      const listed = allowScript && name !== TSX_WATCH_OPTION && name !== TSX_CHILD_OPTION;
      if (equals > 0) {
        apply(name, argument.slice(equals + 1));
        if (listed) {
          options.execArgv.push(argument);
        }
        index += 1;
      } else if (VALUE_OPTIONS.has(name)) {
        apply(name, list[index + 1]);
        if (listed) {
          options.execArgv.push(argument, list[index + 1] ?? "");
        }
        index += 2;
      } else {
        apply(name, undefined);
        if (listed) {
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

/**
 * Writes `text` to fd 2 with a blocking write, as Node writes its fatal
 * report: past `process.stderr`, so a program that ended, destroyed or corked
 * that stream still has the report reach its reader. Every write the stream
 * made before has been handed to the kernel already (its writes to a pipe,
 * a terminal or a file are blocking or in order with this one), so the report
 * comes after them; what a corked stream holds stays there, as in Node.
 */
function writeFatalReport(text: string): void {
  try {
    writeFd(2, new TextEncoder().encode(text));
  } catch {
    // fd 2 is closed, or its reader has gone: nothing is left to report through.
  }
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

  // A program under tsx watch is not given the channel its reports use,
  // unless tsx would give it one (TSX_CHILD_OPTION).
  const process: NodeProcess = createProcess({
    loadBuiltin,
    ipc: options.tsxChild === "hidden" ? null : client.ipc,
  });
  configureLoader({
    loadBuiltin,
    conditions: options.conditions,
    report: watchReporter({
      env: process.env,
      process,
      ipc: client.ipc,
      tsxChild: options.tsxChild !== null,
      parentPort: thread ? thread.port : null,
    }),
  });
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

  const printFatal = (error: unknown) => {
    writeFatalReport(`\n${describeError(error)}\n\nNode.js v${NODE_VERSION}\n`);
  };

  const fatal = (error: unknown): never => {
    // As Node: the program's 'exit' listeners run first, and the error is
    // printed after them.
    if ((process as { _exiting?: boolean })._exiting) {
      printFatal(error);
    } else {
      process.on("exit", () => printFatal(error));
    }
    process.exitCode = process.exitCode || 1;
    return process.exit(1);
  };

  // A thread's uncaught error goes to its parent's `error` event and the
  // thread ends with 1. Node posts it with the port's own `postMessage`, so
  // what a program made of that method takes it.
  const handToParent = (target: NonNullable<typeof thread>, error: unknown): never => {
    target.port.postMessage(threadErrorMessage(error));
    return rt.processes.exit(1);
  };

  const reportUncaught = (
    error: unknown,
    origin: "uncaughtException" | "unhandledRejection" = "uncaughtException",
  ) => {
    let handled: boolean;
    try {
      handled = (
        process as unknown as { _handleUncaught(error: unknown, origin: string): boolean }
      )._handleUncaught(error, origin);
    } catch (thrown) {
      // An 'uncaughtException' listener (or the capture callback) threw. In a
      // thread, Node hands that error to the parent as any other; on the main
      // thread it prints it and ends with code 7. Neither runs the 'exit'
      // listeners.
      if (thread) {
        return handToParent(thread, thrown);
      }
      printFatal(thrown);
      return rt.processes.exit(7);
    }
    if (handled) {
      return;
    }
    if (thread) {
      handToParent(thread, error);
    }
    fatal(error);
  };

  globalThis.addEventListener("error", (event) => {
    event.preventDefault();
    reportUncaught((event as ErrorEvent).error ?? new Error((event as ErrorEvent).message));
  });
  const rejectionMode: RejectionMode | null =
    options.unhandledRejections === null
      ? "throw"
      : isRejectionMode(options.unhandledRejections)
        ? options.unhandledRejections
        : null;
  if (rejectionMode === null) {
    process.stderr.write("node: invalid value for --unhandled-rejections\n");
    process.exit(9);
  }
  const rejections = createRejectionReporter(process, rejectionMode, (error) =>
    reportUncaught(error, "unhandledRejection"),
  );
  globalThis.addEventListener("unhandledrejection", (event) => {
    const { reason, promise } = event as PromiseRejectionEvent;
    event.preventDefault();
    rejections.unhandled(reason, promise);
  });
  globalThis.addEventListener("rejectionhandled", (event) => {
    rejections.handled((event as PromiseRejectionEvent).promise);
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

  // Watch mode's supervisor: `--run` still runs the script once, as in Node.
  const supervising = options.watch && !thread && options.run === null;

  for (const file of thread ? [] : options.envFiles) {
    try {
      if (supervising) {
        // The supervisor reads the file but leaves its variables to the
        // program, so a changed file restarts it with the new values.
        rt.fs.readFile(path.resolve(file.path));
      } else {
        (process as unknown as { loadEnvFile(file: string): void }).loadEnvFile(file.path);
      }
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
  if (supervising && options.evalSource !== null) {
    process.stderr.write("node: either --watch or --eval can be used, not both\n");
    process.exit(9);
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
        if (client.refCount() > 0) {
          checkScheduled = false;
          return;
        }
        // A macrotask: the ticks its listeners queue run as it returns.
        runMacrotask(() => {
          process.emit("beforeExit", process.exitCode ?? 0);
        });
        // As Node, look for pending work once those ticks and the promise jobs
        // after them have all run: as the next macrotask is about to start.
        // With none pending, Node runs nothing more (an unref'd immediate, a
        // message on an unref'd port), so the macrotasks wait for the decision.
        let pending = false;
        const letMacrotasksRun = gateNextMacrotask(() => {
          pending = client.refCount() > eventLoopHolds();
          return pending;
        });
        // The decision comes two tasks later: the browser reports a rejection
        // the listeners left unhandled in a task of its own, and its report is
        // part of what 'beforeExit' started.
        const decide = () => {
          const own = eventLoopHolds();
          if (own > 0 && client.refCount() <= own) {
            // Ticks or a report of rejections are still on their way.
            afterTurn(() => nativeSetTimeout(decide, 0));
            return;
          }
          checkScheduled = false;
          if (pending || client.refCount() > 0) {
            // Work was pending, so the loop goes on. Where it has finished
            // already, Node emits 'beforeExit' again; where it has not, the
            // check comes back once the process is idle.
            letMacrotasksRun();
            if (client.refCount() <= 0) {
              scheduleExitCheck();
            }
            return;
          }
          try {
            if (entryPending) {
              process.stderr.write("Warning: Detected unsettled top-level await\n");
              process.exit(13);
            }
            process.exit(process.exitCode ?? 0);
          } finally {
            // Reached only when the exit did not happen (an 'exit' listener
            // threw): the process lives on, with its macrotasks.
            letMacrotasksRun();
          }
        };
        afterTurn(() => nativeSetTimeout(decide, 0));
      }, 0);
    }, 0);
  };
  client.onIdle(scheduleExitCheck);

  if (supervising) {
    // Runs none of the program's code (no preloads either): the child does.
    // It lives on in its child, its watchers and its signal handlers.
    try {
      runWatchSupervisor(
        {
          execArgv: options.execArgv,
          command: options.readStdin
            ? ["-", ...options.scriptArgs]
            : options.script === null
              ? options.scriptArgs
              : [options.script, ...options.scriptArgs],
          script: options.script,
          watchPaths: options.watchPaths,
          preserveOutput: options.watchPreserveOutput,
          killSignal: options.watchKillSignal,
          envFiles: options.envFiles,
          nodeOptions:
            init.env.NODE_OPTIONS === undefined ? null : splitWords(init.env.NODE_OPTIONS),
          tsx: options.tsxWatch,
        },
        processWatchHost(process),
      );
    } catch (error) {
      reportUncaught(error);
    }
    scheduleExitCheck();
    return;
  }

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
    if (options.imports.length > 0) {
      // Start-up ends here, before the `--import` preloads load in promise
      // jobs: what the `-r` preloads queued with nextTick runs first, as in Node.
      runNextTicks();
    }
    for (const specifier of options.imports) {
      scheduleExitCheck();
      await importModule(specifier, `${rt.cwd}/[import]`);
    }

    let result: void | Promise<unknown> = undefined;
    try {
      if (thread) {
        process.argv = ["/bin/node", thread.eval ? "[worker eval]" : thread.filename, ...init.argv];
        postThreadMessage(thread.port, { type: THREAD_ONLINE_MESSAGE });
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
    } catch (error) {
      // 'uncaughtException' first; the ticks follow, as after any macrotask.
      reportUncaught(error);
    }

    // What the entry (and an 'uncaughtException' listener) queued with
    // nextTick runs before any promise job it started. An ES module entry has
    // not run yet: its ticks, queued from a promise job, wait for those, as in
    // Node, and so do a CommonJS entry's after an `--import`, which leaves it
    // in a promise job too.
    if (options.imports.length === 0) {
      runNextTicks();
    }
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

/**
 * `node --run <name>`: runs the nearest package.json's script through the
 * shell, as Node's task runner does. Resolves with the exit code for `node`.
 */
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
  const child = rt.processes.spawn({
    command: "sh",
    args: ["-c", command],
    cwd: scope.directory,
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  rt.ref();
  const status = await new Promise<ExitStatus>((resolve) => {
    rt.processes.onExit(child.pid, resolve);
  });
  rt.unref();
  // Node's task runner: 1 for any exit code but 0, and 0 when a signal ended
  // the script. It sends the script no signal of its own.
  return status.code !== null && status.code !== 0 ? 1 : 0;
}

function resolveMain(script: string): string {
  const from = `${runtime().cwd}/[main]`;
  let resolved: ReturnType<typeof resolveSpecifier>;
  try {
    resolved = resolveSpecifier(script, from, "require", []);
  } catch (error) {
    // Under watch mode, creating the missing script restarts the program.
    reportUnresolved(script, from, error);
    throw error;
  }
  if ("builtin" in resolved) {
    throw new Error(`Cannot run builtin module ${resolved.builtin} as a script`);
  }
  return resolved.filename;
}

/**
 * Makes every builtin module a global that loads when it is first read, as
 * Node does for `-e` and `-p` code (`node -p "os.cpus().length"`), though not
 * for a file or for stdin. A name the global object has already is left
 * alone, and so is `crypto`, which stays Web Crypto as a property (`runEval`
 * binds the name for a script). Assigning to one replaces it.
 */
function defineBuiltinGlobals(require: (name: string) => unknown): void {
  const global = globalThis as unknown as Record<string, unknown>;
  for (const name of BUILTIN_MODULE_NAMES) {
    if (
      name.startsWith("_") ||
      name.includes("/") ||
      name === "crypto" ||
      Object.hasOwn(global, name)
    ) {
      continue;
    }
    const replace = (value: unknown) => {
      // Deleting first turns the accessor back into a plain property.
      delete global[name];
      global[name] = value;
    };
    Object.defineProperty(global, name, {
      configurable: true,
      enumerable: false,
      get: () => {
        const builtin = require(name);
        Object.defineProperty(global, name, {
          configurable: true,
          enumerable: false,
          get: () => builtin,
          set: replace,
        });
        return builtin;
      },
      set: replace,
    });
  }
}

/** Runs `-e` / `-p` / stdin code: a script with `require` in scope, or an ES module. */
function runEval(
  source: string,
  filename: string,
  options: NodeOptions,
  process: NodeProcess,
): void | Promise<unknown> {
  const format =
    options.inputType === "module" ? "esm" : options.inputType === "commonjs" ? "cjs" : null;
  const require = Module.createRequire(filename);
  const fromOption = options.evalSource !== null;
  if (fromOption) {
    defineBuiltinGlobals(require);
  }
  let prepared = prepareSource(source, filename, format);
  if (prepared.format === "esm") {
    // runSource evaluates it in a promise job, as Node evaluates a module:
    // its ticks run after the promise jobs it queues.
    return runSource(source, filename, "esm");
  }
  if (fromOption && /\bcrypto\b/.test(source)) {
    // In a script given with `-e` or `-p`, Node makes the name `crypto` the
    // `node:crypto` module, not Web Crypto, by wrapping the code like this.
    prepared = prepareSource(
      options.print
        ? `let crypto=require("node:crypto");{${source}}`
        : `(crypto=>{{${source}}})(require('node:crypto'))`,
      filename,
      "cjs",
    );
  }

  // A script sees these as globals, and `-p` prints its completion value.
  const global = globalThis as unknown as Record<string, unknown>;
  const module = new Module(filename, null);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(runtime().cwd);
  global.require = require;
  global.module = module;
  global.exports = module.exports;
  global.__filename = filename;
  global.__dirname = runtime().cwd;
  global[DYNAMIC_IMPORT_BINDING] = (specifier: unknown) =>
    importModule(String(specifier), filename);
  // eslint-disable-next-line no-eval -- `node -e`/`-p` evaluates the given script
  const value = (0, eval)(`${prepared.code}${sourceUrlComment(filename)}`) as unknown;
  if (options.print) {
    // Node prints the value once the script's work is done: at the first
    // 'beforeExit', or at 'exit' when the process ends without one.
    const print = () => {
      process.stdout.write(`${typeof value === "string" ? value : util.inspect(value)}\n`);
    };
    process.on("exit", print);
    process.once("beforeExit", () => {
      print();
      process.off("exit", print);
    });
  }
  return undefined;
}
