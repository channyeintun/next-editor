// Shell pattern matching: turns glob patterns (`*`, `?`, `[…]`) with their
// quoted spans into regular expressions, for pathname expansion, `case`,
// `[[ == ]]` and the `${x%pat}` family.

/** A piece of expanded text; quoted text never acts as a pattern. */
export interface Seg {
  text: string;
  quoted: boolean;
}

/** True when the unquoted parts of `segs` contain a pattern character. */
export function hasGlobChars(segs: Seg[]): boolean {
  return segs.some((seg) => !seg.quoted && /[*?[]/.test(seg.text));
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

const CLASSES: Record<string, string> = {
  alpha: "a-zA-Z",
  digit: "0-9",
  alnum: "a-zA-Z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\r\\f\\v",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  xdigit: "0-9a-fA-F",
  word: "a-zA-Z0-9_",
  cntrl: "\\x00-\\x1f\\x7f",
  print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e",
};

/**
 * The regular-expression source for a pattern. `pathname` keeps `*`, `?` and
 * brackets from matching `/`.
 */
export function patternSource(segs: Seg[], pathname: boolean): string {
  // Flatten to characters tagged quoted/unquoted.
  const chars: { c: string; q: boolean }[] = [];
  for (const seg of segs) {
    for (const c of seg.text) {
      chars.push({ c, q: seg.quoted });
    }
  }
  const any = pathname ? "[^/]" : "[\\s\\S]";
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const { c, q } = chars[i];
    if (q) {
      out += escapeRegExp(c);
      continue;
    }
    if (c === "\\" && i + 1 < chars.length) {
      i++;
      out += escapeRegExp(chars[i].c);
      continue;
    }
    if (c === "*") {
      out += `${any}*`;
      continue;
    }
    if (c === "?") {
      out += any;
      continue;
    }
    if (c === "[") {
      const parsed = parseBracket(chars, i);
      if (parsed) {
        out += parsed.source;
        i = parsed.end;
        continue;
      }
    }
    out += escapeRegExp(c);
  }
  return out;
}

function parseBracket(
  chars: { c: string; q: boolean }[],
  start: number,
): { source: string; end: number } | null {
  let i = start + 1;
  let negate = false;
  if (i < chars.length && !chars[i].q && (chars[i].c === "!" || chars[i].c === "^")) {
    negate = true;
    i++;
  }
  let body = "";
  let first = true;
  while (i < chars.length) {
    const { c, q } = chars[i];
    if (c === "]" && !q && !first) {
      return { source: `[${negate ? "^" : ""}${body}]`, end: i };
    }
    first = false;
    if (c === "[" && !q && chars[i + 1]?.c === ":") {
      let j = i + 2;
      let name = "";
      while (j < chars.length && chars[j].c !== ":") {
        name += chars[j].c;
        j++;
      }
      if (chars[j + 1]?.c === "]" && CLASSES[name]) {
        body += CLASSES[name];
        i = j + 2;
        continue;
      }
    }
    if (c === "-" && !q && body !== "" && chars[i + 1] && chars[i + 1].c !== "]") {
      body += "-";
      i++;
      continue;
    }
    body += c === "\\" || c === "]" || c === "[" || c === "^" || c === "-" ? `\\${c}` : c;
    i++;
  }
  return null;
}

/** A regular expression matching the whole of a string against the pattern. */
export function patternToRegExp(segs: Seg[], pathname = false, flags = ""): RegExp {
  return new RegExp(`^${patternSource(segs, pathname)}$`, flags);
}

/** Matches `text` against an unquoted pattern string. */
export function matchPattern(pattern: string, text: string): boolean {
  return patternToRegExp([{ text: pattern, quoted: false }]).test(text);
}

/**
 * Removes the shortest (or longest) prefix or suffix of `value` matching the
 * pattern: `${x#p}`, `${x##p}`, `${x%p}`, `${x%%p}`.
 */
export function removeAffix(value: string, segs: Seg[], suffix: boolean, longest: boolean): string {
  const regex = patternToRegExp(segs);
  const chars = Array.from(value);
  const n = chars.length;
  if (!suffix) {
    for (let k = 0; k <= n; k++) {
      const len = longest ? n - k : k;
      if (regex.test(chars.slice(0, len).join(""))) {
        return chars.slice(len).join("");
      }
    }
  } else {
    for (let k = 0; k <= n; k++) {
      const start = longest ? k : n - k;
      if (regex.test(chars.slice(start).join(""))) {
        return chars.slice(0, start).join("");
      }
    }
  }
  return value;
}

/** `${x/pat/rep}` and `${x//pat/rep}`; `#`/`%` at the start of the pattern anchor it. */
export function replacePattern(
  value: string,
  segs: Seg[],
  replacement: string,
  all: boolean,
): string {
  let anchor: "" | "#" | "%" = "";
  const first = segs[0];
  if (first && !first.quoted && (first.text.startsWith("#") || first.text.startsWith("%"))) {
    anchor = first.text[0] as "#" | "%";
    segs = [{ text: first.text.slice(1), quoted: false }, ...segs.slice(1)];
  }
  const source = patternSource(segs, false);
  if (source === "") {
    return value;
  }
  // Shell patterns match longest-first; make `*` greedy (the default).
  if (anchor === "#") {
    return value.replace(new RegExp(`^(?:${source})`), () => replacement);
  }
  if (anchor === "%") {
    return value.replace(new RegExp(`(?:${source})$`), () => replacement);
  }
  return value.replace(new RegExp(source, all ? "g" : ""), () => replacement);
}
