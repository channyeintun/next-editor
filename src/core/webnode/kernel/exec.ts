// What a command line runs: the lookup `execvp` does. A command name is found
// on PATH, its `#!` line names an interpreter, and the result is one of the
// built-in programs with the argv it should see. The built-in commands exist as
// small marker files in /bin so `which node` and PATH lookups find them.
import { createSystemError, errnoCodeOf, type ErrnoCode } from "../errors";
import { DEFAULT_PATH } from "../process/platform";
import { initialEnvironment } from "../process/programs/shell/environment";
import { plainWords } from "../process/programs/shell/plainWords";
import { tsxArguments } from "../process/programs/watchOptions";
import type { ProgramName } from "../protocol";
import type { PermissionedVfs, VfsApi } from "./vfs/types";
import { O_CREAT, O_TRUNC, O_WRONLY, S_IFDIR, S_IFMT, S_IFREG, X_OK } from "./vfs/types";

export interface ResolvedExec {
  program: ProgramName;
  argv: string[];
  execArgv: string[];
  /**
   * The environment the program starts with, where it is not the one the
   * command was given: a program started in the place of the shell that
   * would only have started it (`programOfShell`) gets that shell's.
   */
  env?: Record<string, string>;
}

const MARKER = "#!webnode ";

const SHELL_NAMES = ["sh", "bash", "zsh", "jsh", "dash"];
const PACKAGE_MANAGER_NAMES = ["npm", "npx", "pnpm", "pnpx", "yarn"];
/**
 * The commands that are the runtime's own programs. None is a word the shell
 * runs itself (a builtin, a command of its own, a reserved word), which
 * `programOfShell` relies on and exec.test.ts holds.
 */
export const PROGRAM_NAMES: readonly string[] = ["node", "tsx", ...PACKAGE_MANAGER_NAMES];

/** Commands the shell implements itself, reachable from `child_process` too. */
const SHELL_COMMAND_NAMES = [
  "ls",
  "cat",
  "mkdir",
  "rm",
  "rmdir",
  "cp",
  "mv",
  "touch",
  "ln",
  "chmod",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "find",
  "sort",
  "uniq",
  "tr",
  "cut",
  "sed",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "sleep",
  "date",
  "whoami",
  "hostname",
  "uname",
  "xargs",
  "tee",
  "seq",
  "yes",
  "curl",
  "echo",
  "printf",
  "pwd",
  "env",
  "which",
  "true",
  "false",
  "test",
  "clear",
  "kill",
];

/**
 * Packages whose command cannot run here as published and that a built-in
 * stands in for, keyed by the end of the script's real path. `tsx` drives
 * esbuild through loader hooks; the `node` program runs TypeScript itself.
 */
const SCRIPT_STAND_INS: { suffix: string; argv0: string }[] = [
  { suffix: "/node_modules/tsx/dist/cli.mjs", argv0: "tsx" },
  { suffix: "/node_modules/tsx/dist/cli.cjs", argv0: "tsx" },
];

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Writes the marker files for the built-in commands into /bin. */
export function installBuiltinCommands(vfs: VfsApi): void {
  vfs.mkdir("/bin", true, 0o755);
  vfs.mkdir("/usr/bin", true, 0o755);
  vfs.mkdir("/usr/local/bin", true, 0o755);

  const write = (name: string, kind: string) => {
    vfs.writeFile(
      `/bin/${name}`,
      encoder.encode(`${MARKER}${kind}\n`),
      O_WRONLY | O_CREAT | O_TRUNC,
      0o755,
    );
    vfs.chmod(`/bin/${name}`, 0o755, true);
  };

  write("node", "node");
  write("tsx", "tsx");
  for (const name of SHELL_NAMES) {
    write(name, "shell");
  }
  for (const name of PACKAGE_MANAGER_NAMES) {
    write(name, "npm");
  }
  for (const name of SHELL_COMMAND_NAMES) {
    write(name, "shell-command");
  }
  // `#!/usr/bin/env node` is the usual first line of a package's command.
  vfs.writeFile(
    "/usr/bin/env",
    encoder.encode(`${MARKER}shell-command\n`),
    O_WRONLY | O_CREAT | O_TRUNC,
    0o755,
  );
  vfs.chmod("/usr/bin/env", 0o755, true);
}

/**
 * Why `execve(path)` would fail, or null when it would run: the path must lead
 * to a regular file (any other kind is EACCES), through directories the
 * process may search, and the file must be executable by its owner.
 */
function execError(vfs: VfsApi, path: string): ErrnoCode | null {
  let mode: number;
  try {
    mode = vfs.stat(path, true).mode;
  } catch (error) {
    return errnoCodeOf(error) ?? "ENOENT";
  }
  if ((mode & S_IFMT) !== S_IFREG) {
    return "EACCES";
  }
  try {
    vfs.access(path, X_OK);
  } catch (error) {
    return errnoCodeOf(error) ?? "ENOENT";
  }
  return null;
}

function joinPath(directory: string, name: string): string {
  if (name.startsWith("/")) {
    return name;
  }
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/** A command's file: its absolute `path`, and the `filename` execve was given. */
interface FoundCommand {
  path: string;
  filename: string;
}

/**
 * The file `command` names: a path as given, or the first match on PATH that
 * can run. As `execvp` does, a match that cannot (EACCES) is passed over, and
 * the search fails with EACCES rather than ENOENT when one was found.
 */
function findCommand(
  vfs: VfsApi,
  command: string,
  env: Record<string, string>,
  cwd: string,
): FoundCommand {
  if (command.includes("/")) {
    const path = joinPath(cwd, command);
    const error = execError(vfs, path);
    if (error !== null) {
      throw createSystemError(error, "spawn", command);
    }
    return { path, filename: command };
  }

  // No PATH at all: libuv searches its default path, so must we.
  let refused = false;
  for (const directory of (env.PATH ?? DEFAULT_PATH).split(":")) {
    if (!directory) {
      continue;
    }
    const filename = joinPath(directory, command);
    const candidate = joinPath(cwd, filename);
    const error = execError(vfs, candidate);
    if (error === null) {
      return { path: candidate, filename };
    }
    if (error === "EACCES") {
      refused = true;
    } else if (error !== "ENOENT" && error !== "ENOTDIR") {
      throw createSystemError(error, "spawn", command);
    }
  }
  throw createSystemError(refused ? "EACCES" : "ENOENT", "spawn", command);
}

/**
 * Fails with EACCES, as a child's `chdir` does, when `cwd` is a directory the
 * process may not enter: it, or one on the way to it, cannot be searched.
 */
function checkWorkingDirectory(vfs: VfsApi, cwd: string, command: string): void {
  let mode: number;
  try {
    mode = vfs.stat(cwd, true).mode;
  } catch (error) {
    if (errnoCodeOf(error) === "EACCES") {
      throw createSystemError("EACCES", "spawn", command);
    }
    return;
  }
  if ((mode & S_IFMT) !== S_IFDIR) {
    return;
  }
  try {
    vfs.access(cwd, X_OK);
  } catch {
    throw createSystemError("EACCES", "spawn", command);
  }
}

function fromMarker(kind: string, name: string, args: string[]): ResolvedExec {
  switch (kind) {
    case "node":
      return { program: "node", argv: ["node", ...args], execArgv: [] };
    case "tsx":
      return { program: "node", argv: ["node", ...tsxArguments(args)], execArgv: [] };
    case "shell":
      return { program: "shell", argv: [name, ...args], execArgv: [] };
    case "npm":
      return { program: "npm", argv: [name, ...args], execArgv: [] };
    default:
      // A shell built-in run as a program: `sh -c 'ls "$@"' ls <args>`.
      return {
        program: "shell",
        argv: ["sh", "-c", `${name} "$@"`, name, ...args],
        execArgv: [],
      };
  }
}

/**
 * Resolves `command` with `args` to the program a new process runs, with the
 * permissions of the user every process runs as (`vfs` is checked). Throws
 * `ENOENT` when the command does not exist and `EACCES` when it is not a file
 * the user may run, or `cwd` one the user may not enter. `cwd` is checked
 * only when the child changes into it (`changesDirectory`, a `cwd` the caller
 * chose); a child that stays in its parent's directory, as after a fork, is
 * not checked there.
 */
export function resolveExec(
  vfs: PermissionedVfs,
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  changesDirectory = true,
): ResolvedExec {
  const resolved = resolveCommand(vfs, command, args, env, cwd, changesDirectory);
  return (resolved.program === "shell" && programOfShell(vfs, resolved.argv, env, cwd)) || resolved;
}

/**
 * The program a shell started as `argv` would only start, in that shell's
 * place: `sh -c 'pnpm dev'` is `pnpm dev`, as bash makes it by exec'ing the
 * lone command of `-c`. The shell would stand for the program and end as it
 * ends (process/programs/shell/plainWords.ts), in a process of its own for as
 * long as the program runs; the editor starts every command of a lesson this
 * way. Only for a line of plain words whose first is one of the runtime's
 * own programs: the kernel has no shell to ask what any other word is to it.
 * The program gets the environment the shell would have started with, and is
 * found on that environment's PATH, as the shell would find it. Null for any
 * other shell, and where the program cannot be started: the shell then runs,
 * and reports it.
 */
function programOfShell(
  vfs: PermissionedVfs,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
): ResolvedExec | null {
  if (argv.length !== 3 || (argv[1] !== "-c" && argv[1] !== "-lc")) {
    return null;
  }
  const words = plainWords(argv[2]);
  if (words === null || !PROGRAM_NAMES.includes(words[0])) {
    return null;
  }
  const started = initialEnvironment(env, cwd);
  try {
    // The shell's child stays in the shell's directory: nothing to check there.
    const program = resolveCommand(vfs, words[0], words.slice(1), started, cwd, false);
    return program.program === "shell" ? null : { ...program, env: started };
  } catch {
    return null;
  }
}

function resolveCommand(
  vfs: PermissionedVfs,
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  changesDirectory: boolean,
): ResolvedExec {
  if (changesDirectory) {
    checkWorkingDirectory(vfs, cwd, command);
  }
  // The interpreter of a script gets `filename`, the path as execve was given
  // it (`./x.sh`, `bin/tool`), as Linux's binfmt_script passes it on: it is
  // the script's `$0`, and what the interpreter names when it cannot open it.
  const { path, filename } = findCommand(vfs, command, env, cwd);
  const name = path.slice(path.lastIndexOf("/") + 1);

  let realPath = path;
  try {
    realPath = vfs.realpath(path);
  } catch {
    // A dangling link fails the read below.
  }
  const stand = SCRIPT_STAND_INS.find(({ suffix }) => realPath.endsWith(suffix));
  if (stand) {
    return fromMarker(stand.argv0, stand.argv0, args);
  }

  // The kernel reads the `#!` line itself, as Linux's exec does: a script
  // needs execute, not read (its interpreter then needs read to run it).
  const head = decoder.decode(vfs.privileged.readFile(path).subarray(0, 256));
  const firstLine = head.split("\n", 1)[0];

  if (firstLine.startsWith(MARKER)) {
    return fromMarker(firstLine.slice(MARKER.length).trim(), name, args);
  }

  if (firstLine.startsWith("#!")) {
    const words = firstLine.slice(2).trim().split(/\s+/);
    let interpreter = words.shift() ?? "";
    if (interpreter.endsWith("/env")) {
      if (words[0] === "-S") {
        words.shift();
      }
      interpreter = words.shift() ?? "";
    }
    const interpreterName = interpreter.slice(interpreter.lastIndexOf("/") + 1);
    if (interpreterName === "node" || interpreterName === "nodejs") {
      return { program: "node", argv: ["node", filename, ...args], execArgv: words };
    }
    if (interpreterName === "tsx" || interpreterName === "ts-node") {
      return { program: "node", argv: ["node", filename, ...args], execArgv: [] };
    }
    if (SHELL_NAMES.includes(interpreterName)) {
      return {
        program: "shell",
        argv: [interpreterName, ...words, filename, ...args],
        execArgv: [],
      };
    }
    throw createSystemError("ENOENT", "spawn", command);
  }

  if (/\.(?:[cm]?js|[cm]?ts)$/.test(name)) {
    return { program: "node", argv: ["node", filename, ...args], execArgv: [] };
  }
  // No `#!` line: a shell script, as `execvp` falls back to.
  return { program: "shell", argv: ["sh", filename, ...args], execArgv: [] };
}
