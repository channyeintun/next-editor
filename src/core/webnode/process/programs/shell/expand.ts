// Word expansion: brace expansion, tilde, parameters, command substitution,
// arithmetic, field splitting on IFS, pathname globbing and quote removal, in
// POSIX order. The interpreter supplies variables and runs substitutions
// through `ExpandContext`.
import type { ParamPart, Program, Word, WordPart } from "./ast";
import { ArithError, evaluateArithmetic } from "./arith";
import type { ArithScope } from "./arith";
import { hasGlobChars, patternToRegExp, removeAffix, replacePattern } from "./pattern";
import type { Seg } from "./pattern";

/** What expansion needs from the shell. */
export interface ExpandContext {
  /** A variable or special parameter (`?`, `$`, `#`, `0`, `1`, …); undefined when unset. */
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  /** `$1 …`. */
  positional(): string[];
  /** Runs a command substitution and returns its standard output. */
  substitute(program: Program): Promise<string>;
  nounset: boolean;
  noglob: boolean;
  cwd: string;
  /** Directory entries for globbing; null when `path` is not a readable directory. */
  readdir(path: string): { name: string; isDir: boolean }[] | null;
}

/** A failed expansion (`${x:?}`, `set -u`, bad arithmetic). The shell prints `message` and fails the command. */
export class ExpansionError extends Error {
  /** A non-interactive shell exits on this error. */
  readonly fatal: boolean;
  constructor(message: string, fatal = true) {
    super(message);
    this.name = "ExpansionError";
    this.fatal = fatal;
  }
}

interface Field {
  segs: Seg[];
  keep: boolean;
}

class FieldBuilder {
  readonly fields: Field[] = [{ segs: [], keep: false }];
  private readonly ifs: string;

  constructor(ifs: string) {
    this.ifs = ifs;
  }

  private get current(): Field {
    return this.fields[this.fields.length - 1];
  }

  add(text: string, quoted: boolean): void {
    if (text !== "") {
      this.current.segs.push({ text, quoted });
    }
    if (quoted) {
      this.current.keep = true;
    }
  }

  /** Starts a new field. Without `force`, an empty current field is reused. */
  breakField(force: boolean): void {
    const current = this.current;
    if (!force && current.segs.length === 0 && !current.keep) {
      return;
    }
    if (force) {
      current.keep = true;
    }
    this.fields.push({ segs: [], keep: false });
  }

  /** Adds the unquoted result of an expansion, splitting it on IFS. */
  addSplit(text: string): void {
    if (this.ifs === "") {
      this.add(text, false);
      return;
    }
    const white = Array.from(this.ifs)
      .filter((c) => c === " " || c === "\t" || c === "\n")
      .map(escapeClass)
      .join("");
    const other = Array.from(this.ifs)
      .filter((c) => c !== " " && c !== "\t" && c !== "\n")
      .map(escapeClass)
      .join("");
    const parts: string[] = [];
    if (white && other) {
      parts.push(`[${white}]*[${other}][${white}]*`, `[${white}]+`);
    } else if (other) {
      parts.push(`[${other}]`);
    } else {
      parts.push(`[${white}]+`);
    }
    const delimiter = new RegExp(parts.join("|"), "g");
    let last = 0;
    for (const match of text.matchAll(delimiter)) {
      const index = match.index;
      this.add(text.slice(last, index), false);
      const nonWhite = other !== "" && new RegExp(`[${other}]`).test(match[0]);
      if (nonWhite) {
        this.current.keep = true;
        this.fields.push({ segs: [], keep: false });
      } else {
        this.breakField(false);
      }
      last = index + match[0].length;
    }
    this.add(text.slice(last), false);
  }

  result(): Field[] {
    return this.fields.filter((field) => field.segs.length > 0 || field.keep);
  }
}

function escapeClass(c: string): string {
  return c.replace(/[\\\]^-]/g, "\\$&");
}

function ifsOf(ctx: ExpandContext): string {
  const ifs = ctx.get("IFS");
  return ifs === undefined ? " \t\n" : ifs;
}

function arithScope(ctx: ExpandContext): ArithScope {
  return {
    get: (name) => ctx.get(name),
    set: (name, value) => ctx.set(name, value),
  };
}

/** Evaluates arithmetic text, turning errors into `ExpansionError`. */
export function arithmetic(ctx: ExpandContext, text: string): number {
  try {
    return evaluateArithmetic(text, arithScope(ctx));
  } catch (error) {
    if (error instanceof ArithError) {
      throw new ExpansionError(`${text.trim()}: ${error.message}`);
    }
    throw error;
  }
}

// ---- brace expansion ----

type Item = { ch: string } | { part: WordPart };

function flatten(parts: WordPart[]): Item[] {
  const items: Item[] = [];
  for (const part of parts) {
    if (part.type === "lit") {
      for (const ch of part.value) {
        items.push({ ch });
      }
    } else {
      items.push({ part });
    }
  }
  return items;
}

function regroup(items: Item[]): WordPart[] {
  const parts: WordPart[] = [];
  let lit = "";
  for (const item of items) {
    if ("ch" in item) {
      lit += item.ch;
    } else {
      if (lit) {
        parts.push({ type: "lit", value: lit });
        lit = "";
      }
      parts.push(item.part);
    }
  }
  if (lit) {
    parts.push({ type: "lit", value: lit });
  }
  return parts;
}

function isCh(item: Item | undefined, ch: string): boolean {
  return item !== undefined && "ch" in item && item.ch === ch;
}

function sequence(text: string): string[] | null {
  const numeric = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(text);
  if (numeric) {
    const start = Number(numeric[1]);
    const end = Number(numeric[2]);
    let step = Math.abs(Number(numeric[3] ?? "1")) || 1;
    if (start > end) {
      step = -step;
    }
    const width =
      /^-?0\d/.test(numeric[1]) || /^-?0\d/.test(numeric[2])
        ? Math.max(numeric[1].length, numeric[2].length)
        : 0;
    const out: string[] = [];
    for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
      const s = String(Math.abs(n)).padStart(width - (n < 0 ? 1 : 0), "0");
      out.push(n < 0 ? `-${s}` : s);
      if (out.length > 100000) {
        break;
      }
    }
    return out;
  }
  const alpha = /^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/.exec(text);
  if (alpha) {
    const start = alpha[1].charCodeAt(0);
    const end = alpha[2].charCodeAt(0);
    let step = Math.abs(Number(alpha[3] ?? "1")) || 1;
    if (start > end) {
      step = -step;
    }
    const out: string[] = [];
    for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
      out.push(String.fromCharCode(n));
    }
    return out;
  }
  return null;
}

function braceItems(items: Item[]): Item[][] {
  for (let i = 0; i < items.length; i++) {
    if (!isCh(items[i], "{")) {
      continue;
    }
    let depth = 1;
    const commas: number[] = [];
    let close = -1;
    for (let j = i + 1; j < items.length; j++) {
      if (isCh(items[j], "{")) {
        depth++;
      } else if (isCh(items[j], "}")) {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      } else if (depth === 1 && isCh(items[j], ",")) {
        commas.push(j);
      }
    }
    if (close < 0) {
      return [items];
    }
    const prefix = items.slice(0, i);
    const suffix = items.slice(close + 1);
    if (commas.length > 0) {
      const alternatives: Item[][] = [];
      let start = i + 1;
      for (const comma of [...commas, close]) {
        alternatives.push(items.slice(start, comma));
        start = comma + 1;
      }
      const out: Item[][] = [];
      for (const alternative of alternatives) {
        out.push(...braceItems([...prefix, ...alternative, ...suffix]));
      }
      return out;
    }
    const inner = items.slice(i + 1, close);
    if (inner.every((item) => "ch" in item)) {
      const values = sequence(inner.map((item) => (item as { ch: string }).ch).join(""));
      if (values) {
        const out: Item[][] = [];
        for (const value of values) {
          out.push(...braceItems([...prefix, ...Array.from(value, (ch) => ({ ch })), ...suffix]));
        }
        return out;
      }
    }
  }
  return [items];
}

/** Brace expansion of one word into one or more words. */
export function braceExpand(word: Word): Word[] {
  if (!word.parts.some((part) => part.type === "lit" && part.value.includes("{"))) {
    return [word];
  }
  return braceItems(flatten(word.parts)).map((items) => ({ parts: regroup(items) }));
}

// ---- tilde ----

function tildeExpand(word: Word, ctx: ExpandContext): Word {
  const first = word.parts[0];
  if (!first || first.type !== "lit" || !first.value.startsWith("~")) {
    return word;
  }
  const slash = first.value.indexOf("/");
  const prefix = slash < 0 ? first.value.slice(1) : first.value.slice(1, slash);
  if (slash < 0 && word.parts.length > 1) {
    // `~"x"` is not a tilde prefix.
    return word;
  }
  let replacement: string | undefined;
  if (prefix === "") {
    replacement = ctx.get("HOME");
  } else if (prefix === "+") {
    replacement = ctx.get("PWD");
  } else if (prefix === "-") {
    replacement = ctx.get("OLDPWD");
  } else if (prefix === ctx.get("USER")) {
    replacement = ctx.get("HOME");
  }
  if (replacement === undefined) {
    return word;
  }
  const rest = slash < 0 ? "" : first.value.slice(slash);
  const parts: WordPart[] = [{ type: "sq", value: replacement }];
  if (rest) {
    parts.push({ type: "lit", value: rest });
  }
  return { parts: [...parts, ...word.parts.slice(1)] };
}

// ---- parameters ----

function paramValue(ctx: ExpandContext, name: string): string | undefined {
  if (name === "@" || name === "*") {
    const ifs = ifsOf(ctx);
    const args = ctx.positional();
    return args.join(name === "*" ? ifs.slice(0, 1) : " ");
  }
  return ctx.get(name);
}

function isSet(ctx: ExpandContext, name: string): boolean {
  if (name === "@" || name === "*") {
    return ctx.positional().length > 0;
  }
  return ctx.get(name) !== undefined;
}

async function wordToString(word: Word | undefined, ctx: ExpandContext): Promise<string> {
  if (!word) {
    return "";
  }
  return expandString(word, ctx);
}

/** `name` when `${name=word}` may assign to it; throws otherwise. */
function assignableName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new ExpansionError(`$${name}: cannot assign in this way`);
  }
  return name;
}

/** Whether the test of `${x-w}`, `${x:+w}`, `${x:=w}`, … picks the word. */
function wordChosen(part: ParamPart, ctx: ExpandContext): boolean {
  const set = isSet(ctx, part.name);
  const nullOrUnset = !set || paramValue(ctx, part.name) === "";
  switch (part.op) {
    case ":-":
    case ":=":
      return nullOrUnset;
    case "-":
    case "=":
      return !set;
    case ":+":
      return !nullOrUnset;
    case "+":
      return set;
  }
  return false;
}

/** The word of `${x-w}` / `${x+w}` (with or without `:`) when it is the result. */
function chosenWord(part: ParamPart, ctx: ExpandContext): Word | null {
  if (part.indirect || part.length || !part.word) {
    return null;
  }
  const op = part.op;
  if (op !== ":-" && op !== "-" && op !== ":+" && op !== "+") {
    return null;
  }
  return wordChosen(part, ctx) ? part.word : null;
}

/** True when `${x=w}` / `${x:=w}` will assign its word. */
function isAssignChosen(part: ParamPart, ctx: ExpandContext): boolean {
  return (
    !part.indirect && !part.length && (part.op === ":=" || part.op === "=") && wordChosen(part, ctx)
  );
}

/** The value of a parameter expansion, or a list of values for `"$@"`-like forms. */
async function expandParam(part: ParamPart, ctx: ExpandContext): Promise<string> {
  if (part.indirect) {
    const target = ctx.get(part.name) ?? "";
    if (!/^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])$/.test(target)) {
      throw new ExpansionError(`${target}: invalid variable name`);
    }
    return paramValue(ctx, target) ?? "";
  }
  const { name } = part;
  if (part.length) {
    if (name === "@" || name === "*" || name === "#") {
      return String(name === "#" ? (ctx.get("#") ?? "0").length : ctx.positional().length);
    }
    const value = ctx.get(name);
    if (value === undefined && ctx.nounset) {
      throw new ExpansionError(`${name}: unbound variable`);
    }
    return String(Array.from(value ?? "").length);
  }
  const op = part.op;
  const set = isSet(ctx, name);
  const value = paramValue(ctx, name);
  const nullOrUnset = !set || value === "";
  switch (op) {
    case undefined:
      break;
    case ":-":
    case "-":
      if (op === ":-" ? nullOrUnset : !set) {
        return wordToString(part.word, ctx);
      }
      return value ?? "";
    case ":=":
    case "=":
      if (op === ":=" ? nullOrUnset : !set) {
        const target = assignableName(name);
        const assigned = await wordToString(part.word, ctx);
        ctx.set(target, assigned);
        return assigned;
      }
      return value ?? "";
    case ":+":
    case "+":
      if (op === ":+" ? nullOrUnset : !set) {
        return "";
      }
      return wordToString(part.word, ctx);
    case ":?":
    case "?":
      if (op === ":?" ? nullOrUnset : !set) {
        const message = await wordToString(part.word, ctx);
        throw new ExpansionError(`${name}: ${message || "parameter null or not set"}`);
      }
      return value ?? "";
  }
  if (value === undefined && ctx.nounset && name !== "@" && name !== "*") {
    throw new ExpansionError(`${name}: unbound variable`);
  }
  const text = value ?? "";
  switch (op) {
    case undefined:
      return text;
    case "#":
    case "##":
    case "%":
    case "%%": {
      const segs = await expandPattern(part.word as Word, ctx);
      return removeAffix(text, segs, op[0] === "%", op.length === 2);
    }
    case "/":
    case "//": {
      const segs = await expandPattern(part.word as Word, ctx);
      const replacement = await wordToString(part.word2, ctx);
      return replacePattern(text, segs, replacement, op === "//");
    }
    case ":": {
      const chars = Array.from(text);
      let offset = arithmetic(ctx, await wordToString(part.word, ctx));
      if (offset < 0) {
        offset = Math.max(0, chars.length + offset);
      }
      if (part.word2 === undefined) {
        return chars.slice(offset).join("");
      }
      let length = arithmetic(ctx, await wordToString(part.word2, ctx));
      if (length < 0) {
        length = chars.length + length - offset;
        if (length < 0) {
          throw new ExpansionError(`${length}: substring expression < 0`);
        }
      }
      return chars.slice(offset, offset + length).join("");
    }
    case "^^":
      return text.toUpperCase();
    case ",,":
      return text.toLowerCase();
    case "^":
      return text.slice(0, 1).toUpperCase() + text.slice(1);
    case ",":
      return text.slice(0, 1).toLowerCase() + text.slice(1);
  }
  throw new ExpansionError(`\${${name}${op}}: bad substitution`);
}

function isAtParam(part: ParamPart): boolean {
  return (
    part.name === "@" &&
    !part.length &&
    (part.op === undefined ||
      part.op === "#" ||
      part.op === "##" ||
      part.op === "%" ||
      part.op === "%%" ||
      part.op === "/" ||
      part.op === "//")
  );
}

/** Strips trailing newlines from command-substitution output. */
function trimSubstitution(text: string): string {
  return text.replace(/\n+$/, "");
}

async function expandInto(
  parts: WordPart[],
  ctx: ExpandContext,
  builder: FieldBuilder,
  quoted: boolean,
  split: boolean,
): Promise<void> {
  for (const part of parts) {
    switch (part.type) {
      case "lit":
        builder.add(part.value, quoted);
        break;
      case "sq":
        builder.add(part.value, true);
        break;
      case "dq":
        if (part.parts.length === 0) {
          builder.add("", true);
        }
        await expandInto(part.parts, ctx, builder, true, split);
        break;
      case "param": {
        if (
          isAtParam(part) ||
          (part.name === "*" && !part.length && part.op === undefined && !quoted)
        ) {
          // `$@` / `"$@"`: one field per positional parameter.
          let args = ctx.positional();
          if (part.op) {
            const values: string[] = [];
            for (const arg of args) {
              const scoped = Object.create(ctx) as ExpandContext;
              scoped.get = (n) => (n === "__arg__" ? arg : ctx.get(n));
              values.push(await expandParam({ ...part, name: "__arg__" }, scoped));
            }
            args = values;
          }
          for (let i = 0; i < args.length; i++) {
            if (i > 0) {
              builder.breakField(true);
            }
            if (quoted) {
              builder.add(args[i], true);
            } else if (split) {
              builder.addSplit(args[i]);
            } else {
              builder.add(args[i], false);
            }
          }
          break;
        }
        const chosen = chosenWord(part, ctx);
        if (chosen) {
          // The chosen word keeps its own quoting: `${x:-"a b"}` is one field
          // and `${1+"$@"}` one field per argument, as in bash.
          builder.add("", quoted);
          for (const inner of tildeExpand(chosen, ctx).parts) {
            if (inner.type === "lit" && !quoted && split) {
              // Unquoted text of the word is split too: `${x:-a b}` is two fields.
              builder.addSplit(inner.value);
            } else {
              await expandInto([inner], ctx, builder, quoted, split);
            }
          }
          break;
        }
        if (isAssignChosen(part, ctx)) {
          const target = assignableName(part.name);
          const segs = await expandPattern(part.word ?? { parts: [] }, ctx);
          ctx.set(target, joinSegs(segs));
          builder.add("", quoted);
          for (const seg of segs) {
            if (quoted || seg.quoted) {
              builder.add(seg.text, true);
            } else if (split) {
              builder.addSplit(seg.text);
            } else {
              builder.add(seg.text, false);
            }
          }
          break;
        }
        const value = await expandParam(part, ctx);
        if (quoted) {
          builder.add(value, true);
        } else if (split) {
          builder.addSplit(value);
        } else {
          builder.add(value, false);
        }
        break;
      }
      case "cmdsub": {
        const value = trimSubstitution(await ctx.substitute(part.program));
        if (quoted) {
          builder.add(value, true);
        } else if (split) {
          builder.addSplit(value);
        } else {
          builder.add(value, false);
        }
        break;
      }
      case "arith": {
        const text = await expandString({ parts: part.parts }, ctx);
        const value = String(arithmetic(ctx, text));
        if (quoted) {
          builder.add(value, true);
        } else if (split) {
          builder.addSplit(value);
        } else {
          builder.add(value, false);
        }
        break;
      }
    }
  }
}

function joinSegs(segs: Seg[]): string {
  return segs.map((seg) => seg.text).join("");
}

/** Expands a word without field splitting or globbing (assignments, redirect targets, `case` subjects). */
export async function expandString(word: Word, ctx: ExpandContext): Promise<string> {
  return joinSegs(await expandPattern(word, ctx));
}

/** Expands a word into segments that keep which text was quoted (for patterns). */
export async function expandPattern(word: Word, ctx: ExpandContext): Promise<Seg[]> {
  const builder = new FieldBuilder("");
  await expandInto(tildeExpand(word, ctx).parts, ctx, builder, false, false);
  const segs: Seg[] = [];
  builder.fields.forEach((field, index) => {
    if (index > 0) {
      segs.push({ text: " ", quoted: true });
    }
    segs.push(...field.segs);
  });
  return segs;
}

/** Expands command words into fields: brace, tilde, parameters, splitting, globbing. */
export async function expandWords(words: Word[], ctx: ExpandContext): Promise<string[]> {
  const out: string[] = [];
  for (const original of words) {
    for (const braced of braceExpand(original)) {
      const word = tildeExpand(braced, ctx);
      const builder = new FieldBuilder(ifsOf(ctx));
      await expandInto(word.parts, ctx, builder, false, true);
      for (const field of builder.result()) {
        if (!ctx.noglob && hasGlobChars(field.segs)) {
          const matches = glob(field.segs, ctx);
          if (matches.length > 0) {
            out.push(...matches);
            continue;
          }
        }
        out.push(joinSegs(field.segs));
      }
    }
  }
  return out;
}

// ---- globbing ----

/** Splits segments on unquoted and quoted `/` into path components. */
function splitComponents(segs: Seg[]): Seg[][] {
  const components: Seg[][] = [[]];
  for (const seg of segs) {
    const pieces = seg.text.split("/");
    pieces.forEach((piece, index) => {
      if (index > 0) {
        components.push([]);
      }
      if (piece) {
        components[components.length - 1].push({ text: piece, quoted: seg.quoted });
      }
    });
  }
  return components;
}

function joinPath(base: string, name: string): string {
  if (base === "") {
    return name;
  }
  return base.endsWith("/") ? base + name : `${base}/${name}`;
}

function resolveFrom(cwd: string, path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return path === "" ? cwd : joinPath(cwd, path);
}

/** Pathname expansion of one field; sorted matches, or none. */
export function glob(segs: Seg[], ctx: ExpandContext): string[] {
  const components = splitComponents(segs);
  const absolute = components[0].length === 0 && components.length > 1;
  let candidates: string[] = [absolute ? "/" : ""];
  const start = absolute ? 1 : 0;
  for (let i = start; i < components.length; i++) {
    const component = components[i];
    const last = i === components.length - 1;
    if (component.length === 0) {
      // A trailing slash (`*/`) keeps directories only.
      if (last) {
        candidates = candidates
          .filter((candidate) => {
            const entries = ctx.readdir(resolveFrom(ctx.cwd, candidate));
            return entries !== null;
          })
          .map((candidate) => `${candidate}/`);
      }
      continue;
    }
    const next: string[] = [];
    if (!hasGlobChars(component)) {
      const name = joinSegs(component);
      for (const candidate of candidates) {
        const path = candidate === "/" ? `/${name}` : joinPath(candidate, name);
        if (last) {
          const parent = ctx.readdir(resolveFrom(ctx.cwd, candidate));
          if (parent?.some((entry) => entry.name === name)) {
            next.push(path);
          }
        } else {
          next.push(path);
        }
      }
    } else {
      const regex = patternToRegExp(component, true);
      const allowDot = component[0].text.startsWith(".");
      for (const candidate of candidates) {
        const entries = ctx.readdir(resolveFrom(ctx.cwd, candidate));
        if (!entries) {
          continue;
        }
        for (const entry of entries) {
          if (entry.name.startsWith(".") && !allowDot) {
            continue;
          }
          if (!last && !entry.isDir) {
            continue;
          }
          if (regex.test(entry.name)) {
            next.push(candidate === "/" ? `/${entry.name}` : joinPath(candidate, entry.name));
          }
        }
      }
    }
    candidates = next;
    if (candidates.length === 0) {
      return [];
    }
  }
  return candidates.sort();
}

/** Expands a pattern word for `case` / `[[ == ]]` and tests `text` against it. */
export async function matchWord(text: string, word: Word, ctx: ExpandContext): Promise<boolean> {
  const segs = await expandPattern(word, ctx);
  return patternToRegExp(segs).test(text);
}
