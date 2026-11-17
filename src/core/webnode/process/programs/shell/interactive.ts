// The interactive shell (`jsh`, `sh -i`): the prompt, the read–run loop over
// the line editor in raw mode, continuation lines for unfinished input,
// `~/.jsh_history`, and Tab completion of commands and paths.
import { O_APPEND, O_CREAT, O_WRONLY, X_OK } from "../../../kernel/vfs/types";
import { HOME_DIR } from "../../platform";
import { runtime } from "../../runtime";
import { BUILTINS } from "./builtins";
import { COMMANDS } from "./commands/index";
import { isDir, resolvePath, tryStat } from "./commands/util";
import { ExitSignal, InterruptSignal } from "./context";
import { decode, encode, takeBuffered, writeFd } from "./io";
import type { Shell } from "./interpreter";
import { ShellSyntaxError } from "./lexer";
import { History, LineEditor } from "./lineEditor";
import type { EditorHost } from "./lineEditor";
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

function withoutLines(_key: string, value: unknown): unknown {
  return _key === "line" ? undefined : value;
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
  let endOfInput = false;
  const onChunk = (chunk: Uint8Array | null): void => {
    if (chunk === null) {
      endOfInput = true;
      if (editor.active) {
        editor.feedText("\x04");
      }
      return;
    }
    editor.feed(chunk);
  };
  const isTty = rt.tty.isatty(0);
  const rc = `${(shell.get("HOME") ?? HOME_DIR).replace(/\/$/, "")}/.jshrc`;
  if (tryStat(rc)) {
    try {
      await shell.runSource(decode(rt.fs.readFile(rc)));
    } catch (error) {
      if (error instanceof ExitSignal) {
        stopResize();
        return error.status;
      }
      if (!(error instanceof InterruptSignal)) {
        throw error;
      }
      shell.status = 130;
    } finally {
      shell.process.pendingSignal = null;
    }
  }
  let status = 0;
  try {
    for (;;) {
      let source = "";
      let prompt = makePrompt(shell.cwd, shell.get("HOME"), shell.status);
      let interrupted = false;
      let eof = false;
      for (;;) {
        if (isTty) {
          rt.tty.setRawMode(0, true);
        }
        const typeAhead = takeBuffered(0);
        const reading = editor.readLine(prompt);
        if (typeAhead.length > 0) {
          editor.feed(typeAhead);
        }
        if (endOfInput) {
          editor.feedText("\x04");
        } else {
          rt.fdStream.readStart(0, onChunk);
        }
        const result = await reading;
        rt.fdStream.readStop(0);
        if (isTty) {
          rt.tty.setRawMode(0, false);
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
        shell.status = 130;
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
        await shell.runSource(source);
      } catch (error) {
        if (error instanceof ExitSignal) {
          status = error.status;
          return status;
        }
        if (!(error instanceof InterruptSignal)) {
          throw error;
        }
        // Ctrl+C stopped commands the shell ran itself: back to the prompt.
        shell.status = 130;
      } finally {
        shell.process.pendingSignal = null;
      }
      // Report background jobs that finished.
      for (const job of shell.process.jobs) {
        if (job.status !== null) {
          host.write(
            `[${job.id}]+  Done${job.status === 0 ? "" : `(${job.status})`}  ${job.command}\n`,
          );
        }
      }
      shell.process.jobs = shell.process.jobs.filter((job) => job.status === null);
    }
    status = shell.status;
    return status;
  } finally {
    stopResize();
    try {
      rt.fdStream.readStop(0);
    } catch {
      // Already closed.
    }
  }
}
