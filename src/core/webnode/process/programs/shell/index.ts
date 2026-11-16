// The shell program's entry point: `sh`, `bash`, `zsh` and `jsh` are all this
// program. Parses the command line (`-c`, `-s`, `-i`, `-l`, `-e`, `-x`, …),
// sets up the environment and signal handling, then runs a command string, a
// script file, standard input or the interactive loop.
import { DEFAULT_PATH, HOME_DIR, SHELL_PATH, USERNAME } from "../../platform";
import { runtime } from "../../runtime";
import { applySetFlag } from "./builtins";
import { baseName, errorText } from "./commands/util";
import { ExitSignal } from "./context";
import { runInteractive } from "./interactive";
import { Shell } from "./interpreter";
import type { ProcessState } from "./interpreter";
import { decode, readAllAsync, writeFd } from "./io";
import { declareHandledSignals } from "./signals";

const OPTION_NAMES = new Set([
  "errexit",
  "xtrace",
  "nounset",
  "pipefail",
  "noglob",
  "noclobber",
  "allexport",
  "verbose",
]);

interface Invocation {
  command: string | null;
  script: string | null;
  readStdin: boolean;
  interactive: boolean | null;
  arg0: string;
  positional: string[];
  flags: string[];
  options: string[];
}

/** Parses the shell's own arguments. Throws an `Error` for a bad option. */
export function parseInvocation(argv: string[]): Invocation {
  const name = baseName(argv[0] ?? "sh");
  const result: Invocation = {
    command: null,
    script: null,
    readStdin: false,
    interactive: null,
    arg0: argv[0] ?? "sh",
    positional: [],
    flags: [],
    options: [],
  };
  let wantCommand = false;
  let i = 1;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (
      arg === "--login" ||
      arg === "--norc" ||
      arg === "--noprofile" ||
      arg === "--posix" ||
      arg === "--noediting"
    ) {
      continue;
    }
    if (arg === "--version") {
      throw new VersionRequest(name);
    }
    if (arg.startsWith("--")) {
      throw new Error(`${arg}: invalid option`);
    }
    if ((arg.startsWith("-") || arg.startsWith("+")) && arg.length > 1) {
      for (const letter of arg.slice(1)) {
        if (letter === "c") {
          wantCommand = true;
        } else if (letter === "s") {
          result.readStdin = true;
        } else if (letter === "i") {
          result.interactive = true;
        } else if (letter === "l") {
          // A login shell: nothing extra to read.
        } else if (letter === "o") {
          const option = argv[++i];
          if (option === undefined || !OPTION_NAMES.has(option)) {
            throw new Error(`${option ?? ""}: invalid option name`);
          }
          result.options.push(`${arg[0]}${option}`);
        } else {
          result.flags.push(`${arg[0]}${letter}`);
        }
      }
      continue;
    }
    break;
  }
  const rest = argv.slice(i);
  if (wantCommand) {
    if (rest.length === 0) {
      throw new Error("-c: option requires an argument");
    }
    result.command = rest[0];
    result.arg0 = rest[1] ?? argv[0] ?? "sh";
    result.positional = rest.slice(2);
  } else if (!result.readStdin && rest.length > 0) {
    result.script = rest[0];
    result.arg0 = rest[0];
    result.positional = rest.slice(1);
  } else {
    result.positional = rest;
  }
  return result;
}

class VersionRequest extends Error {
  constructor(name: string) {
    super(name);
  }
}

/** The environment a new shell starts with: the process's, plus PWD, HOME, PATH, SHELL, USER, SHLVL. */
function initialEnvironment(env: Record<string, string>, cwd: string): Record<string, string> {
  const next = { ...env };
  next.PWD = cwd;
  next.HOME ??= HOME_DIR;
  next.PATH ??= DEFAULT_PATH;
  next.SHELL ??= SHELL_PATH;
  next.USER ??= USERNAME;
  const level = Number(next.SHLVL ?? "0");
  next.SHLVL = String(Number.isFinite(level) ? level + 1 : 1);
  return next;
}

/** Runs the shell with `argv` (`["sh", "-c", "…"]`, `["jsh"]`, …) and returns its exit status. */
export async function runShell(argv: string[]): Promise<number> {
  const rt = runtime();
  let invocation: Invocation;
  try {
    invocation = parseInvocation(argv);
  } catch (error) {
    if (error instanceof VersionRequest) {
      writeFd(1, `${error.message} (webnode) 0.1.0\n`);
      return 0;
    }
    writeFd(2, `sh: ${(error as Error).message}\n`);
    return 2;
  }
  let stdinIsTty = false;
  try {
    stdinIsTty = rt.tty.isatty(0);
  } catch {
    stdinIsTty = false;
  }
  const interactive =
    invocation.interactive ??
    (invocation.command === null &&
      invocation.script === null &&
      (stdinIsTty || baseName(argv[0] ?? "") === "jsh"));
  const process: ProcessState = {
    foreground: new Set(),
    exits: new Map(),
    pendingSignal: null,
    abort: new AbortController(),
    jobs: [],
    nextJobId: 1,
    interactive: interactive && stdinIsTty,
    history: [],
  };
  const cwd = rt.cwd || "/";
  const shell = new Shell({
    arg0: invocation.arg0,
    positional: invocation.positional,
    env: initialEnvironment(rt.env, cwd),
    cwd,
    process,
  });
  for (const flag of invocation.flags) {
    const error = applySetFlag(shell, flag);
    if (error) {
      writeFd(2, `sh: ${error}\n`);
      return 2;
    }
  }
  for (const option of invocation.options) {
    shell.options[option.slice(1) as keyof Shell["options"]] = option[0] === "-";
  }
  rt.processes.onSignal((signal) => {
    if (signal === "SIGWINCH" || signal === "SIGCHLD") {
      return true;
    }
    const short = signal.replace(/^SIG/, "");
    const trap = shell.traps.get(short);
    if (trap === "") {
      return true;
    }
    const known =
      signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGHUP" || signal === "SIGQUIT";
    if (!known && trap === undefined) {
      return false;
    }
    // A Ctrl+C typed in a terminal reaches the whole foreground group from
    // the kernel, the children included; forwarding it would deliver it twice.
    const fromTerminal = signal === "SIGINT" && rt.tty.isatty(0);
    if (!fromTerminal) {
      for (const pid of process.foreground) {
        try {
          rt.processes.kill(pid, signal);
        } catch {
          // Already gone.
        }
      }
    }
    process.abort.abort();
    process.abort = new AbortController();
    process.pendingSignal = signal;
    if (process.interactive && trap === undefined) {
      process.pendingSignal = null;
    }
    return true;
  });
  declareHandledSignals(shell.traps.keys());
  let status = 0;
  try {
    if (invocation.command !== null) {
      status = await shell.runSource(invocation.command);
    } else if (invocation.script !== null) {
      const path = shell.resolve(invocation.script);
      let text: string;
      try {
        text = decode(rt.fs.readFile(path));
      } catch (error) {
        writeFd(2, `sh: ${invocation.script}: ${errorText(error)}\n`);
        return 127;
      }
      status = await shell.runSource(text.replace(/^#![^\n]*/, ""));
    } else if (process.interactive) {
      status = await runInteractive(shell);
    } else {
      const text = decode(await readAllAsync(0));
      status = await shell.runSource(text);
    }
  } catch (error) {
    if (error instanceof ExitSignal) {
      status = error.status;
    } else {
      writeFd(2, `sh: internal error: ${error instanceof Error ? error.message : String(error)}\n`);
      status = 70;
    }
  }
  try {
    shell.status = status;
    await shell.runExitTrap();
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      throw error;
    }
  }
  return status;
}
