// The interactive shell (`jsh`, `sh -i`): the prompt, the read–run loop over
// the line editor in raw mode, continuation lines for unfinished input,
// `~/.jsh_history`, and Tab completion of commands and paths.
import { O_APPEND, O_CREAT, O_WRONLY, X_OK } from "../../../kernel/vfs/types";
import { HOME_DIR } from "../../platform";
import { signalExitStatus } from "../../../signals";
import { runtime } from "../../runtime";
import { BUILTINS } from "./builtins";
import { COMMANDS } from "./commands/index";
import { isDir, resolvePath, tryStat } from "./commands/util";
import { InterruptSignal } from "./context";
import {
  CHUNK_READ,
  ReadInterrupted,
  decode,
  encode,
  readAsync,
  unreadTerminal,
  writeFd,
} from "./io";
import { fatalExit, settleSignal } from "./interpreter";
import type { Shell } from "./interpreter";
import { announceEndedJobs } from "./jobs";
import { ShellSyntaxError } from "./lexer";
import { History, LineEditor } from "./lineEditor";
import type { EditResult, EditorHost } from "./lineEditor";
import { parse } from "./parser";

/** The prompt: the working directory (home as `~`) in bold blue, then a green or red `❯`. */
export function makePrompt(cwd: string, home: string | undefined, status: number): string {
  let shown = cwd;
  if (home && home !== "/" && (cwd === home || cwd.startsWith(`${home}/`))) {
    shown = `~${cwd.slice(home.length)}`;
  }
  const arrow = status === 0 ? "\x1b[32m❯\x1b[0m" : "\x1b[31m❯\x1b[0m";
  return `\x1b[1;34m${shown}\x1b[0m ${arrow} `;
}

/** True when `source` parses only with more input (an open quote, a trailing `&&`). */
export function isIncomplete(source: string): boolean {
  try {
    parse(source);
    return false;
  } catch (error) {
    return error instanceof ShellSyntaxError && error.incomplete;
  }
}

/** After these, a line break joins with a space: a `;` there would not parse. */
const NO_SEMICOLON_AFTER =
  /(^|[\s;&|(){}])(do|then|else|elif|if|while|until|in|!|\{|\(|\|\||&&|\||&|;;|;&|;;&|;)$/;

/** Leaves out what records how the command was laid out, not what it means. */
function withoutLines(_key: string, value: unknown): unknown {
  return _key === "line" || _key === "source" ? undefined : value;
}

/**
 * The one-line form of a command typed on several lines, for history:
 * `for i in 1 2⏎do echo $i⏎done` becomes `for i in 1 2; do echo $i; done`,
 * as bash's cmdhist does. Null when no one-line form means the same (a
 * quoted newline, a here-document).
 */
export function historyLine(source: string): string | null {
  if (!source.includes("\n")) {
    return source;
  }
  let joined = "";
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    if (joined === "") {
      joined = trimmed;
    } else {
      joined += NO_SEMICOLON_AFTER.test(joined) ? ` ${trimmed}` : `; ${trimmed}`;
    }
  }
  try {
    const same =
      JSON.stringify(parse(joined), withoutLines) === JSON.stringify(parse(source), withoutLines);
    return same ? joined : null;
  } catch {
    return null;
  }
}

function escapeForShell(text: string): string {
  return text.replace(/([ \t'"\\$`!&|;()<>*?[\]{}#~])/g, "\\$1");
}

function executablesOnPath(path: string | undefined, cwd: string): string[] {
  const fs = runtime().fs;
  const names = new Set<string>();
  for (const dir of (path ?? "").split(":")) {
    if (!dir) {
      continue;
    }
    const absolute = resolvePath(cwd, dir);
    let entries;
    try {
      entries = fs.readdir(absolute);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        fs.access(`${absolute}/${entry.name}`, X_OK);
        const stat = tryStat(`${absolute}/${entry.name}`);
        if (stat && !isDir(stat)) {
          names.add(entry.name);
        }
      } catch {
        // Not executable.
      }
    }
  }
  return [...names];
}

/** Completions for the word before `cursor` in `line`. */
export function completeLine(
  shell: Shell,
  line: string,
  cursor: number,
): { start: number; candidates: string[] } {
  let start = cursor;
  while (start > 0 && !/[\s|&;()<>]/.test(line[start - 1])) {
    start--;
  }
  // Keep backslash-escaped spaces inside the word.
  while (start > 1 && /\s/.test(line[start - 1]) && line[start - 2] === "\\") {
    start -= 2;
    while (start > 0 && !/[\s|&;()<>]/.test(line[start - 1])) {
      start--;
    }
  }
  const word = line.slice(start, cursor).replace(/\\(.)/g, "$1");
  const before = line.slice(0, start).trimEnd();
  const commandPosition =
    before === "" ||
    /(\|\||&&|[|;&(])$/.test(before) ||
    /(^|\s)(sudo|time|then|do|else|!)$/.test(before);
  if (commandPosition && !word.includes("/")) {
    const names = new Set<string>([
      ...Object.keys(BUILTINS),
      ...Object.keys(COMMANDS),
      ...shell.functions.keys(),
      ...shell.aliases.keys(),
      ...executablesOnPath(shell.get("PATH"), shell.cwd),
    ]);
    const candidates = [...names].filter((name) => name.startsWith(word)).sort();
    return { start, candidates: candidates.map(escapeForShell) };
  }
  // Paths.
  let typed = word;
  const home = shell.get("HOME") ?? HOME_DIR;
  let display = "";
  if (typed.startsWith("~")) {
    const slash = typed.indexOf("/");
    if (slash < 0) {
      return { start, candidates: [] };
    }
    display = typed.slice(0, slash);
    typed = home + typed.slice(slash);
  }
  const slash = typed.lastIndexOf("/");
  const dirPart = slash < 0 ? "" : typed.slice(0, slash + 1);
  const base = slash < 0 ? typed : typed.slice(slash + 1);
  const dir = resolvePath(shell.cwd, dirPart || ".");
  let entries;
  try {
    entries = runtime().fs.readdir(dir);
  } catch {
    return { start, candidates: [] };
  }
  const shownDir = display ? display + dirPart.slice(home.length) : dirPart;
  const candidates = entries
    .filter(
      (entry) =>
        entry.name.startsWith(base) && (base.startsWith(".") || !entry.name.startsWith(".")),
    )
    .map((entry) => {
      let directory = entry.type === "dir";
      if (entry.type === "symlink") {
        const stat = tryStat(`${dir}/${entry.name}`);
        directory = stat !== null && isDir(stat);
      }
      return escapeForShell(shownDir + entry.name).replace(/^\\~/, "~") + (directory ? "/" : "");
    })
    .sort();
  return { start, candidates };
}

function historyPath(shell: Shell): string {
  return `${(shell.get("HOME") ?? HOME_DIR).replace(/\/$/, "")}/.jsh_history`;
}

function loadHistory(shell: Shell, history: History): void {
  try {
    const text = decode(runtime().fs.readFile(historyPath(shell)));
    for (const line of text.split("\n")) {
      if (line !== "") {
        history.add(line);
      }
    }
  } catch {
    // No history yet.
  }
}

function appendHistory(shell: Shell, line: string): void {
  try {
    runtime().fs.writeFile(
      historyPath(shell),
      encode(`${line}\n`),
      O_WRONLY | O_CREAT | O_APPEND,
      0o600,
    );
  } catch {
    // A read-only home is no reason to fail.
  }
}

/** Runs the interactive read–run loop until `exit` or Ctrl+D; returns the exit status. */
export async function runInteractive(shell: Shell): Promise<number> {
  const rt = runtime();
  const outputFd = rt.tty.isatty(1) ? 1 : 2;
  const host: EditorHost = {
    write: (text) => {
      writeFd(outputFd, text);
    },
    columns: () => {
      try {
        return rt.tty.windowSize(outputFd).columns || 80;
      } catch {
        return 80;
      }
    },
    complete: (line, cursor) => completeLine(shell, line, cursor),
  };
  const history = new History();
  loadHistory(shell, history);
  shell.process.history = history.entries;
  const editor = new LineEditor(host, history);
  const stopResize = rt.tty.onResize(() => editor.resize());
  // One read of the terminal at a time, and only while the line is
  // unfinished, as bash reads: what is typed after it stays in the terminal.
  // A read that returns no bytes is an end of file typed at the terminal:
  // it ended that one read, and is the Ctrl+D key it was typed as (on an
  // empty line it ends the shell; with text on the line the reading goes
  // on). A second one in a row is the end of the terminal's input, after
  // which every read returns at once: the line is given up, as readline
  // gives one up at its second end of file in a row.
  const readUntilLineEnds = async (): Promise<void> => {
    let ended = false;
    while (editor.active) {
      // A signal that ends the shell (a hangup) ends its wait for a key.
      const chunk = await readAsync(0, CHUNK_READ, { signal: shell.process.ending.signal });
      if (chunk.length > 0) {
        ended = false;
        editor.feed(chunk);
      } else if (ended) {
        editor.endInput();
      } else {
        ended = true;
        editor.feedText("\x04");
      }
    }
  };
  const isTty = rt.tty.isatty(0);
  const rc = `${(shell.get("HOME") ?? HOME_DIR).replace(/\/$/, "")}/.jshrc`;
  if (tryStat(rc)) {
    try {
      await shell.runSource(decode(rt.fs.readFile(rc)));
    } catch (error) {
      // `exit`, or a signal that ends the shell: the caller ends it.
      if (!(error instanceof InterruptSignal)) {
        stopResize();
        throw error;
      }
      shell.status = signalExitStatus("SIGINT");
    } finally {
      settleSignal(shell.process);
    }
  }
  let status = 0;
  try {
    for (;;) {
      // A job a Ctrl+C cut short has ended too.
      shell.takeTerminalBack();
      let source = "";
      let prompt = makePrompt(shell.cwd, shell.get("HOME"), shell.status);
      let interrupted = false;
      let eof = false;
      for (;;) {
        if (isTty) {
          rt.tty.setRawMode(0, true);
        }
        const reading = editor.readLine(prompt);
        let result: EditResult;
        try {
          await readUntilLineEnds();
          result = await reading;
        } catch (error) {
          if (!(error instanceof ReadInterrupted)) {
            throw error;
          }
          // The line is given up with the shell, which ends of the signal.
          throw fatalExit(shell.process);
        } finally {
          if (isTty) {
            rt.tty.setRawMode(0, false);
          }
        }
        if (result.type === "eof") {
          eof = true;
          break;
        }
        if (result.type === "interrupt") {
          interrupted = true;
          break;
        }
        source = source === "" ? result.text : `${source}\n${result.text}`;
        if (!isIncomplete(source)) {
          const typedAhead = editor.takeTypeAhead();
          const interrupt = typedAhead.lastIndexOf("\x03");
          if (interrupt >= 0) {
            // A Ctrl+C that came with the line, before its command could
            // start: the terminal's interrupt key discards what was typed
            // before it, so the line does not run (bash's prompt shows ^C
            // and starts over). What was typed after it is kept.
            host.write("^C\n");
            unreadTerminal(0, encode(typedAhead.slice(interrupt + 1)));
            interrupted = true;
          } else {
            // Keys typed after the command line are the command's to read,
            // as bash leaves them in the terminal; the next prompt reads
            // back whatever it leaves.
            unreadTerminal(0, encode(typedAhead));
          }
          break;
        }
        prompt = "> ";
      }
      if (eof) {
        if (source === "") {
          break;
        }
        continue;
      }
      if (interrupted) {
        shell.status = signalExitStatus("SIGINT");
        continue;
      }
      if (source.trim() === "") {
        continue;
      }
      // A command that has no one-line form stays in this session's history
      // as typed; the history file holds one command per line.
      const entry = historyLine(source);
      if (history.add(entry ?? source) && entry !== null) {
        appendHistory(shell, entry);
      }
      try {
        // A signal that came while no command ran (a Ctrl+C in the moment
        // before the prompt took the keys) has none to stop: its trap runs,
        // and nothing of the line typed since is abandoned for it.
        await shell.checkSignals().catch((error: unknown) => {
          if (!(error instanceof InterruptSignal)) {
            throw error;
          }
        });
        settleSignal(shell.process);
        await shell.runSource(source);
      } catch (error) {
        // `exit`, or a signal that ends the shell: the caller ends it.
        if (!(error instanceof InterruptSignal)) {
          throw error;
        }
        // Ctrl+C stopped commands the shell ran itself: back to the prompt.
        shell.status = signalExitStatus("SIGINT");
      } finally {
        settleSignal(shell.process);
      }
      // Report background jobs that finished.
      announceEndedJobs(shell.jobList, host.write);
    }
    status = shell.status;
    return status;
  } finally {
    stopResize();
  }
}
