// `sed [-n] [-E|-r] [-i[suffix]] [-e script]… [-f file] [script] [files…]`.
// Commands: s y p d q Q = a i c n, with line, `$` and /regex/ addresses,
// ranges and `!`. Blocks (`{…}`) and hold space are not supported.
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../../kernel/vfs/types";
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { decode, encode } from "../io";
import { posixToJs } from "./regex";
import { errorText } from "./util";

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
  for (;;) {
    const match = re.exec(line);
    if (!match) {
      break;
    }
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

/** Runs a sed program over text; returns the output and whether `q` stopped it. */
export function runSed(commands: SedCommand[], text: string, quiet: boolean): string {
  const endsWithNewline = text.endsWith("\n");
  const lines = text === "" ? [] : (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  let out = "";
  for (let index = 0; index < lines.length; index++) {
    let space = lines[index];
    let lineNo = index + 1;
    let deleted = false;
    let quit: "q" | "Q" | null = null;
    const appended: string[] = [];
    for (let c = 0; c < commands.length; c++) {
      const command = commands[c];
      const isLast = index === lines.length - 1;
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
          if (!quiet) {
            out += `${space}\n`;
          }
          if (index + 1 < lines.length) {
            index++;
            lineNo = index + 1;
            space = lines[index];
          } else {
            quit = "Q";
          }
          break;
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
    if (!deleted && !quiet && quit !== "Q") {
      out += `${space}\n`;
    }
    for (const line of appended) {
      out += `${line}\n`;
    }
    if (quit) {
      return out;
    }
  }
  if (!endsWithNewline && out.endsWith("\n") && lines.length > 0) {
    out = out.slice(0, -1);
  }
  return out;
}

/** `sed`. */
export const sed: Command = async (ctx, args) => {
  let quiet = false;
  let extended = false;
  let inPlace: string | null = null;
  const scripts: string[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-n" || arg === "--quiet" || arg === "--silent") {
      quiet = true;
    } else if (arg === "-E" || arg === "-r" || arg === "--regexp-extended") {
      extended = true;
    } else if (arg === "-e" || arg === "--expression") {
      const script = args[++i];
      if (script === undefined) {
        ctx.io.err("sed: option requires an argument -- 'e'\n");
        return 1;
      }
      scripts.push(script);
    } else if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice(13));
    } else if (arg === "-f") {
      const file = args[++i] ?? "";
      try {
        scripts.push(decode(runtime().fs.readFile(ctx.resolve(file))));
      } catch (error) {
        ctx.io.err(`sed: couldn't open file ${file}: ${errorText(error)}\n`);
        return 1;
      }
    } else if (arg.startsWith("-i") || arg.startsWith("--in-place")) {
      inPlace = arg.startsWith("-i")
        ? arg.slice(2)
        : arg.includes("=")
          ? arg.slice(arg.indexOf("=") + 1)
          : "";
    } else if (/^-[nEr]+$/.test(arg)) {
      quiet ||= arg.includes("n");
      extended ||= arg.includes("E") || arg.includes("r");
    } else if (arg.startsWith("-") && arg.length > 1) {
      ctx.io.err(`sed: invalid option -- '${arg.slice(1)}'\n`);
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
  const fs = runtime().fs;
  if (inPlace !== null) {
    if (operands.length === 0) {
      ctx.io.err("sed: no input files\n");
      return 1;
    }
    let status = 0;
    for (const file of operands) {
      const path = ctx.resolve(file);
      try {
        const text = decode(fs.readFile(path));
        if (inPlace !== "") {
          fs.writeFile(`${path}${inPlace}`, encode(text), O_WRONLY | O_CREAT | O_TRUNC, 0o666);
        }
        const output = runSed(parse(), text, quiet);
        fs.writeFile(path, encode(output), O_WRONLY | O_CREAT | O_TRUNC, 0o666);
      } catch (error) {
        ctx.io.err(`sed: can't read ${file}: ${errorText(error)}\n`);
        status = 2;
      }
    }
    return status;
  }
  let text = "";
  let status = 0;
  if (operands.length === 0) {
    text = decode(await ctx.io.readAll());
  } else {
    for (const file of operands) {
      try {
        const content =
          file === "-" ? decode(await ctx.io.readAll()) : decode(fs.readFile(ctx.resolve(file)));
        text += text !== "" && !text.endsWith("\n") ? `\n${content}` : content;
      } catch (error) {
        ctx.io.err(`sed: can't read ${file}: ${errorText(error)}\n`);
        status = 2;
      }
    }
  }
  ctx.io.out(encode(runSed(commands, text, quiet)));
  return status;
};
