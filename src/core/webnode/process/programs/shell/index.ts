// The shell program's entry point: `sh`, `bash`, `zsh` and `jsh` are all this
// program. Parses the command line (`-c`, `-s`, `-i`, `-l`, `-e`, `-x`, …),
// sets up the environment and signal handling, then runs a command string, a
// script file, standard input or the interactive loop.
import { errnoCodeOf } from "../../../errors";
import { signalExitStatus } from "../../../signals";
import { runtime } from "../../runtime";
import { applySetFlag } from "./builtins";
import { baseName, errorText } from "./commands/util";
import { ExitSignal } from "./context";
import { initialEnvironment } from "./environment";
import { runInteractive } from "./interactive";
import { newProcessState, receiveSignal, settleSignal, Shell } from "./interpreter";
import { outliveShell } from "./jobs";
import {
  ReadInterrupted,
  decode,
  giveBackAllInput,
  inheritedFdTable,
  readAllAsync,
  writeFd,
} from "./io";
import { declareHandledSignals, runsExitTrap } from "./signals";

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
  const process = newProcessState(interactive && stdinIsTty);
  const cwd = rt.cwd || "/";
  const shell = new Shell({
    arg0: invocation.arg0,
    positional: invocation.positional,
    env: initialEnvironment(rt.env, cwd),
    cwd,
    umask: rt.umask,
    process,
  });
  shell.fds = inheritedFdTable();
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
  rt.processes.onSignal((signal, fromTerminal) => receiveSignal(shell, signal, fromTerminal));
  declareHandledSignals(shell.traps.keys());
  let status = 0;
  /** The signal the shell ends of, as a process a signal ends (see `ExitSignal`). */
  let signal: string | null = null;
  try {
    if (invocation.command !== null) {
      status = await shell.runCommandString(invocation.command);
    } else if (invocation.script !== null) {
      const path = shell.resolve(invocation.script);
      let text: string;
      try {
        text = decode(rt.fs.readFile(path));
      } catch (error) {
        writeFd(2, `sh: ${invocation.script}: ${errorText(error)}\n`);
        // As bash: 127 for a script that is not there, 126 for one it may not
        // read (or a directory).
        const code = errnoCodeOf(error);
        return code === "ENOENT" || code === "ENOTDIR" ? 127 : 126;
      }
      status = await shell.runSource(text.replace(/^#![^\n]*/, ""));
    } else if (process.interactive) {
      status = await runInteractive(shell);
    } else {
      let script: Uint8Array | null = null;
      try {
        script = await readAllAsync(0, { signal: shell.stopSignal() });
      } catch (error) {
        if (!(error instanceof ReadInterrupted)) {
          throw error;
        }
        // The signal ends the shell, unless it is trapped: either way the
        // script was not read whole, and none of it runs.
        await shell.checkSignals();
        status = signalExitStatus("SIGINT");
      }
      if (script !== null) {
        status = await shell.runSource(decode(script));
      }
    }
  } catch (error) {
    if (error instanceof ExitSignal) {
      status = error.status;
      signal = error.signal;
    } else {
      writeFd(2, `sh: internal error: ${error instanceof Error ? error.message : String(error)}\n`);
      status = 70;
    }
  }
  // The signal that ends the shell has been acted on: the commands of its
  // EXIT trap run to their end, as any others. Some signals end bash
  // without running it (SIGQUIT).
  settleSignal(process);
  const exited = signal === null || runsExitTrap(signal) ? await shell.runExitTrap(status) : null;
  if (exited !== null) {
    // An `exit` in the trap names the status. A shell that a signal was
    // ending still dies of that signal, as bash does once the trap has run.
    status = exited.status;
    signal = exited.signal ?? signal;
  }
  // What the shell read and did not use is the next reader's, as bash,
  // which reads a pipe a byte at a time, leaves it.
  giveBackAllInput();
  // The jobs it runs in its own process go on without it, as forked
  // subshells do: the shell has ended for its parent all the same.
  if (await outliveShell(process, { code: signal === null ? status : null, signal })) {
    return 0;
  }
  if (signal !== null) {
    // bash re-raises a signal that ended it once its EXIT trap has run, so
    // its parent sees the signal (npm, a node parent's `signal`).
    rt.processes.die(signal);
  }
  return status;
}
