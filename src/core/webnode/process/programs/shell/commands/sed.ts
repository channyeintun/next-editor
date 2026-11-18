// `sed [-n] [-E|-r] [-u] [-i[suffix]] [-e script]… [-f file] [script] [files…]`.
// Commands: s y p d q Q = a i c n, with line, `$` and /regex/ addresses,
// ranges and `!`. Blocks (`{…}`) and hold space are not supported.
import { errnoCodeOf } from "../../../../errors";
import { O_CREAT, O_EXCL, O_WRONLY, R_OK } from "../../../../kernel/vfs/types";
import type { Command } from "../context";
import { decodeText, encodeText, inputLines, writeText } from "./lines";
import { posixToJs } from "./regex";
import { absolutePath, errorText, isFile } from "./util";

type Address = { type: "line"; n: number } | { type: "last" } | { type: "regex"; re: RegExp };

interface SedCommand {
  addr1?: Address;
  addr2?: Address;
  negate: boolean;
  name: string;
  active: boolean;
  /** `s`: the pattern, the replacement and its flags. */
  re?: RegExp;
  replace?: (match: RegExpExecArray) => string;
  global?: boolean;
  occurrence?: number;
  print?: boolean;
  /** `y`: the character map. */
  map?: Map<string, string>;
  /** `a`, `i`, `c`: the text. */
  text?: string;
}

class SedSyntaxError extends Error {}

class ScriptParser {
  private pos = 0;
  private readonly script: string;
  private readonly extended: boolean;
  /** The last regex source read, which an empty regex (`s//x/`, `//`) stands for. */
  private lastSource: string | null = null;

  constructor(script: string, extended: boolean) {
    this.script = script;
    this.extended = extended;
  }

  private peek(): string {
    return this.script[this.pos] ?? "";
  }

  private skipSpace(): void {
    while (/[ \t]/.test(this.peek())) {
      this.pos++;
    }
  }

  private regex(source: string, flags: string): RegExp {
    if (source === "") {
      if (this.lastSource === null) {
        throw new SedSyntaxError("no previous regular expression");
      }
      source = this.lastSource;
    }
    this.lastSource = source;
    try {
      return new RegExp(posixToJs(source, this.extended ? "extended" : "basic"), flags);
    } catch {
      throw new SedSyntaxError(`-e expression #1, char ${this.pos}: invalid regular expression`);
    }
  }

  /** Reads up to an unescaped `delim`; `\delim` becomes `delim`. */
  private delimited(delim: string, keepEscapes: boolean): string {
    let out = "";
    for (;;) {
      const c = this.peek();
      if (c === "") {
        throw new SedSyntaxError(`-e expression #1, char ${this.pos}: unterminated \`s' command`);
      }
      this.pos++;
      if (c === delim) {
        return out;
      }
      if (c === "\\") {
        const n = this.peek();
        this.pos++;
        if (n === delim) {
          out += delim;
        } else if (n === "n" && !keepEscapes) {
          out += "\n";
        } else {
          out += `\\${n}`;
        }
        continue;
      }
      out += c;
    }
  }

  private address(): Address | undefined {
    const c = this.peek();
    if (/\d/.test(c)) {
      let digits = "";
      while (/\d/.test(this.peek())) {
        digits += this.peek();
        this.pos++;
      }
      return { type: "line", n: Number(digits) };
    }
    if (c === "$") {
      this.pos++;
      return { type: "last" };
    }
    if (c === "/" || c === "\\") {
      let delim = "/";
      if (c === "\\") {
        this.pos++;
        delim = this.peek();
      }
      this.pos++;
      const source = this.delimited(delim, true);
      let flags = "";
      if (this.peek() === "I") {
        flags = "i";
        this.pos++;
      }
      return { type: "regex", re: this.regex(source, flags) };
    }
    return undefined;
  }

  private restOfLine(): string {
    let end = this.script.indexOf("\n", this.pos);
    if (end < 0) {
      end = this.script.length;
    }
    const text = this.script.slice(this.pos, end);
    this.pos = end;
    return text;
  }

  parse(): SedCommand[] {
    const commands: SedCommand[] = [];
    for (;;) {
      while (/[\s;]/.test(this.peek())) {
        this.pos++;
      }
      if (this.pos >= this.script.length) {
        return commands;
      }
      if (this.peek() === "#") {
        this.restOfLine();
        continue;
      }
      const command: SedCommand = { negate: false, name: "", active: false };
      command.addr1 = this.address();
      if (command.addr1 && this.peek() === ",") {
        this.pos++;
        command.addr2 = this.address();
        if (!command.addr2) {
          throw new SedSyntaxError("unexpected `,'");
        }
      }
      this.skipSpace();
      if (this.peek() === "!") {
        command.negate = true;
        this.pos++;
        this.skipSpace();
      }
      const name = this.peek();
      this.pos++;
      command.name = name;
      switch (name) {
        case "s": {
          const delim = this.peek();
          this.pos++;
          const pattern = this.delimited(delim, true);
          const replacement = this.delimited(delim, false);
          let flags = "";
          let occurrence = 1;
          for (;;) {
            const f = this.peek();
            if (f === "g") {
              command.global = true;
            } else if (f === "p") {
              command.print = true;
            } else if (f === "i" || f === "I") {
              flags += "i";
            } else if (/\d/.test(f)) {
              let digits = "";
              while (/\d/.test(this.peek())) {
                digits += this.peek();
                this.pos++;
              }
              occurrence = Number(digits);
              continue;
            } else if (f === "w" || f === "e" || f === "m" || f === "M") {
              throw new SedSyntaxError(`s///${f}: not supported`);
            } else {
              break;
            }
            this.pos++;
          }
          command.re = this.regex(pattern, `${flags}g`);
          command.occurrence = occurrence;
          command.replace = compileReplacement(replacement);
          break;
        }
        case "y": {
          const delim = this.peek();
          this.pos++;
          const from = Array.from(this.delimited(delim, false));
          const to = Array.from(this.delimited(delim, false));
          if (from.length !== to.length) {
            throw new SedSyntaxError("strings for `y' command are different lengths");
          }
          command.map = new Map(from.map((c, i) => [c, to[i]]));
          break;
        }
        case "a":
        case "i":
        case "c": {
          if (this.peek() === "\\") {
            this.pos++;
            if (this.peek() === "\n") {
              this.pos++;
            }
          }
          this.skipSpace();
          command.text = this.restOfLine().replace(/\\(.)/g, "$1");
          break;
        }
        case "p":
        case "d":
        case "q":
        case "Q":
        case "=":
        case "n":
          break;
        case "{":
        case "}":
        case "h":
        case "H":
        case "g":
        case "G":
        case "x":
        case "N":
        case "D":
        case "P":
        case "b":
        case "t":
        case "T":
        case ":":
        case "r":
        case "w":
        case "l":
          throw new SedSyntaxError(`command \`${name}': not supported`);
        default:
          throw new SedSyntaxError(
            `-e expression #1, char ${this.pos}: unknown command: \`${name}'`,
          );
      }
      commands.push(command);
    }
  }
}

function compileReplacement(text: string): (match: RegExpExecArray) => string {
  const pieces: (string | number)[] = [];
  let literal = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "&") {
      pieces.push(literal, 0);
      literal = "";
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      const n = text[++i];
      if (/\d/.test(n)) {
        pieces.push(literal, Number(n));
        literal = "";
      } else if (n === "n") {
        literal += "\n";
      } else if (n === "t") {
        literal += "\t";
      } else {
        literal += n;
      }
      continue;
    }
    literal += c;
  }
  pieces.push(literal);
  return (match) =>
    pieces.map((piece) => (typeof piece === "number" ? (match[piece] ?? "") : piece)).join("");
}

function substitute(command: SedCommand, line: string): { text: string; changed: boolean } {
  const re = command.re as RegExp;
  re.lastIndex = 0;
  let out = "";
  let last = 0;
  let count = 0;
  let changed = false;
  let previousEnd = -1;
  for (;;) {
    const match = re.exec(line);
    if (!match) {
      break;
    }
    // An empty match right where the previous match ended is not a match
    // (POSIX): `echo baaac | sed 's/a*/x/g'` is xbxcx.
    if (match[0] === "" && match.index === previousEnd) {
      re.lastIndex++;
      continue;
    }
    previousEnd = match.index + match[0].length;
    count++;
    if (count >= (command.occurrence ?? 1)) {
      out +=
        line.slice(last, match.index) + (command.replace as (m: RegExpExecArray) => string)(match);
      last = match.index + match[0].length;
      changed = true;
      if (!command.global) {
        break;
      }
    }
    if (match[0] === "") {
      re.lastIndex++;
    }
  }
  return { text: changed ? out + line.slice(last) : line, changed };
}

function matchAddress(address: Address, line: string, lineNo: number, isLast: boolean): boolean {
  switch (address.type) {
    case "line":
      return lineNo === address.n;
    case "last":
      return isLast;
    case "regex":
      address.re.lastIndex = 0;
      return address.re.test(line);
  }
}

function selected(command: SedCommand, line: string, lineNo: number, isLast: boolean): boolean {
  let result: boolean;
  if (!command.addr1) {
    result = true;
  } else if (!command.addr2) {
    result = matchAddress(command.addr1, line, lineNo, isLast);
  } else if (command.active) {
    const end = command.addr2;
    if (end.type === "line" ? lineNo >= end.n : matchAddress(end, line, lineNo, isLast)) {
      command.active = false;
    }
    result = true;
  } else if (matchAddress(command.addr1, line, lineNo, isLast)) {
    const end = command.addr2;
    command.active = !(end.type === "line" && end.n <= lineNo) && !(end.type === "last" && isLast);
    result = true;
  } else {
    result = false;
  }
  return command.negate ? !result : result;
}

/**
 * A sed program running over lines as they arrive. `n` waits for the next
 * line: the commands after it run when line() is called again.
 */
class SedRun {
  private readonly commands: SedCommand[];
  private readonly quiet: boolean;
  private lineNo = 0;
  /** Where `n` stopped: the pattern space waits for the next line there. */
  private resumeAt: number | null = null;
  /** `q` or `Q` ran: no more input is wanted. */
  quit = false;

  constructor(commands: SedCommand[], quiet: boolean) {
    this.commands = commands;
    this.quiet = quiet;
  }

  /** Runs the program on one input line (`isLast`: the `$` address) and returns its output. */
  line(input: string, isLast: boolean): string {
    let space = input;
    this.lineNo++;
    const lineNo = this.lineNo;
    let out = "";
    let deleted = false;
    let quit: "q" | "Q" | null = null;
    const appended: string[] = [];
    const first = this.resumeAt ?? 0;
    this.resumeAt = null;
    for (let c = first; c < this.commands.length; c++) {
      const command = this.commands[c];
      if (!selected(command, space, lineNo, isLast)) {
        continue;
      }
      switch (command.name) {
        case "s": {
          const result = substitute(command, space);
          space = result.text;
          if (result.changed && command.print) {
            out += `${space}\n`;
          }
          break;
        }
        case "y":
          space = Array.from(space, (ch) => command.map?.get(ch) ?? ch).join("");
          break;
        case "p":
          out += `${space}\n`;
          break;
        case "=":
          out += `${lineNo}\n`;
          break;
        case "a":
          appended.push(command.text ?? "");
          break;
        case "i":
          out += `${command.text ?? ""}\n`;
          break;
        case "c":
          if (!command.addr2 || !command.active) {
            out += `${command.text ?? ""}\n`;
          }
          deleted = true;
          break;
        case "d":
          deleted = true;
          break;
        case "n":
          // Print the pattern space and go on with the next line, if any.
          if (!this.quiet) {
            out += `${space}\n`;
          }
          for (const text of appended) {
            out += `${text}\n`;
          }
          if (isLast) {
            this.quit = true;
          } else {
            this.resumeAt = c + 1;
          }
          return out;
        case "q":
          quit = "q";
          break;
        case "Q":
          quit = "Q";
          break;
      }
      if (deleted || quit) {
        break;
      }
    }
    if (!deleted && !this.quiet && quit !== "Q") {
      out += `${space}\n`;
    }
    for (const text of appended) {
      out += `${text}\n`;
    }
    if (quit) {
      this.quit = true;
    }
    return out;
  }
}

/** True when the program uses the `$` address, so each line must wait for the next. */
function usesLast(commands: SedCommand[]): boolean {
  return commands.some(
    (command) => command.addr1?.type === "last" || command.addr2?.type === "last",
  );
}

/**
 * Feeds lines to a SedRun, holding back the one line that might be the last
 * (for `$`, and for a line without a newline, which keeps lacking one).
 */
class SedFeeder {
  private readonly run: SedRun;
  private readonly holdAll: boolean;
  private held: { line: string; noNewline: boolean } | null = null;

  constructor(commands: SedCommand[], quiet: boolean) {
    this.run = new SedRun(commands, quiet);
    this.holdAll = usesLast(commands);
  }

  get quit(): boolean {
    return this.run.quit;
  }

  /** Adds a line; returns the output that is now final. */
  push(line: string, noNewline: boolean): string {
    let out = "";
    if (this.held) {
      out += this.run.line(this.held.line, false);
      this.held = null;
    }
    if (this.run.quit) {
      return out;
    }
    if (this.holdAll || noNewline) {
      this.held = { line, noNewline };
    } else {
      out += this.run.line(line, false);
    }
    return out;
  }

  /** Ends the input: runs the held line as the last one. */
  end(): string {
    if (!this.held || this.run.quit) {
      return "";
    }
    const { line, noNewline } = this.held;
    this.held = null;
    const out = this.run.line(line, true);
    return noNewline && out.endsWith("\n") ? out.slice(0, -1) : out;
  }
}

/** Runs a sed program over a whole text. */
export function runSed(commands: SedCommand[], text: string, quiet: boolean): string {
  const feeder = new SedFeeder(commands, quiet);
  const endsWithNewline = text.endsWith("\n");
  const lines = text === "" ? [] : (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  let out = "";
  for (let i = 0; i < lines.length && !feeder.quit; i++) {
    out += feeder.push(lines[i], !endsWithNewline && i === lines.length - 1);
  }
  return out + feeder.end();
}

/** What mkstemp puts in place of `XXXXXX`, as in GNU sed's `sedXXXXXX`. */
function tempLetters(): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 6; i++) {
    text += letters[Math.floor(Math.random() * letters.length)];
  }
  return text;
}

/** `sed`. */
export const sed: Command = async (ctx, args) => {
  let quiet = false;
  let extended = false;
  let inPlace: string | null = null;
  const scripts: string[] = [];
  const operands: string[] = [];
  const readScriptFile = (file: string): boolean => {
    try {
      scripts.push(decodeText(ctx.fs.readFile(absolutePath(ctx.cwd, file))));
      return true;
    } catch (error) {
      ctx.io.err(`sed: couldn't open file ${file}: ${errorText(error)}\n`);
      return false;
    }
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--quiet" || arg === "--silent") {
      quiet = true;
    } else if (arg === "--regexp-extended") {
      extended = true;
    } else if (arg === "--expression" || arg === "--file") {
      const value = args[++i];
      if (value === undefined) {
        ctx.io.err(`sed: option '${arg}' requires an argument\n`);
        return 1;
      }
      if (arg === "--expression") {
        scripts.push(value);
      } else if (!readScriptFile(value)) {
        return 1;
      }
    } else if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice(13));
    } else if (arg.startsWith("--file=")) {
      if (!readScriptFile(arg.slice(7))) {
        return 1;
      }
    } else if (arg.startsWith("--in-place")) {
      inPlace = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "";
    } else if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
      // Short options letter by letter, as in GNU and BSD sed: `-ne`, `-Ei`,
      // `-nf script`. e and f take the rest of the word or the next argument;
      // i takes the rest of the word as the backup suffix.
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j];
        if (letter === "n") {
          quiet = true;
        } else if (letter === "E" || letter === "r") {
          extended = true;
        } else if (letter === "u") {
          // Unbuffered: output is written line by line already.
        } else if (letter === "i") {
          inPlace = arg.slice(j + 1);
          break;
        } else if (letter === "e" || letter === "f") {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
          if (value === undefined) {
            ctx.io.err(`sed: option requires an argument -- '${letter}'\n`);
            return 1;
          }
          if (letter === "e") {
            scripts.push(value);
          } else if (!readScriptFile(value)) {
            return 1;
          }
          break;
        } else {
          ctx.io.err(`sed: invalid option -- '${letter}'\n`);
          return 1;
        }
      }
    } else if (arg.startsWith("--")) {
      ctx.io.err(`sed: unrecognized option '${arg}'\n`);
      return 1;
    } else {
      operands.push(arg);
    }
  }
  if (scripts.length === 0) {
    const script = operands.shift();
    if (script === undefined) {
      ctx.io.err("Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n");
      return 1;
    }
    scripts.push(script);
  }
  const parse = (): SedCommand[] => new ScriptParser(scripts.join("\n"), extended).parse();
  let commands: SedCommand[];
  try {
    commands = parse();
  } catch (error) {
    ctx.io.err(`sed: ${(error as Error).message}\n`);
    return 1;
  }
  if (inPlace !== null) {
    const fs = ctx.fs;
    if (operands.length === 0) {
      ctx.io.err("sed: no input files\n");
      return 1;
    }
    let status = 0;
    for (const file of operands) {
      const path = absolutePath(ctx.cwd, file);
      let data: Uint8Array;
      let mode: number;
      let regular = true;
      try {
        const stat = fs.stat(path, true);
        mode = stat.mode & 0o7777;
        regular = isFile(stat);
        if (regular) {
          data = fs.readFile(path);
        } else {
          // GNU sed opens the file before it looks at what it is.
          fs.access(path, R_OK);
          data = new Uint8Array(0);
        }
      } catch (error) {
        ctx.io.err(`sed: can't read ${file}: ${errorText(error)}\n`);
        status = 2;
        continue;
      }
      if (!regular) {
        // Only a regular file can be replaced by a new one; GNU sed stops here.
        ctx.io.err(`sed: couldn't edit ${file}: not a regular file\n`);
        return 4;
      }
      const output = encodeText(runSed(parse(), decodeText(data), quiet));
      // As GNU sed: the result goes to a new file beside the original, which
      // takes the original's mode and is renamed over it (the original is
      // renamed to the backup first). So it is the directory that must be
      // writable, not the file. A failure here stops sed (exit 4).
      const slash = file.lastIndexOf("/");
      const shownDir = slash < 0 ? "." : file.slice(0, slash);
      const dir = path.slice(0, path.lastIndexOf("/"));
      let name = "";
      for (let attempt = 0; ; attempt++) {
        name = `sed${tempLetters()}`;
        try {
          fs.writeFile(`${dir}/${name}`, output, O_WRONLY | O_CREAT | O_EXCL, 0o600);
          break;
        } catch (error) {
          if (errnoCodeOf(error) !== "EEXIST" || attempt === 99) {
            ctx.io.err(
              `sed: couldn't open temporary file ${shownDir}/${name}: ${errorText(error)}\n`,
            );
            return 4;
          }
        }
      }
      const temp = `${dir}/${name}`;
      let renaming = inPlace === "" ? `${shownDir}/${name}` : file;
      try {
        fs.chmod(temp, mode, true);
        if (inPlace !== "") {
          fs.rename(path, `${path}${inPlace}`);
          renaming = `${shownDir}/${name}`;
        }
        fs.rename(temp, path);
      } catch (error) {
        try {
          fs.unlink(temp);
        } catch {
          // Already gone.
        }
        ctx.io.err(`sed: cannot rename ${renaming}: ${errorText(error)}\n`);
        return 4;
      }
    }
    return status;
  }
  // Each line is written once it is final, so `server | sed …` prints as the
  // server does; `q` and a closed output stop the reading.
  let status = 0;
  const feeder = new SedFeeder(commands, quiet);
  for await (const batch of inputLines(ctx, operands)) {
    if ("error" in batch) {
      ctx.io.err(`sed: can't read ${batch.name}: ${batch.error}\n`);
      status = 2;
      continue;
    }
    let out = "";
    for (let i = 0; i < batch.lines.length && !feeder.quit; i++) {
      out += feeder.push(batch.lines[i], batch.noNewline && i === batch.lines.length - 1);
    }
    if (!writeText(ctx, out) || feeder.quit) {
      return status;
    }
  }
  writeText(ctx, feeder.end());
  return status;
};
