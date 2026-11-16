// POSIX regular expressions (basic and extended) translated to JavaScript
// RegExp source, for `grep` and `sed`.

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
  cntrl: "\\x00-\\x1f\\x7f",
  print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e",
};

/** Translates a bracket expression starting at `start` (`[`); returns the source and the index of its `]`. */
function bracket(pattern: string, start: number): { source: string; end: number } | null {
  let i = start + 1;
  let out = "[";
  if (pattern[i] === "^") {
    out += "^";
    i++;
  }
  if (pattern[i] === "]") {
    out += "\\]";
    i++;
  }
  for (; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "]") {
      return { source: `${out}]`, end: i };
    }
    if (c === "[" && pattern[i + 1] === ":") {
      const close = pattern.indexOf(":]", i + 2);
      const name = close < 0 ? "" : pattern.slice(i + 2, close);
      if (CLASSES[name]) {
        out += CLASSES[name];
        i = close + 1;
        continue;
      }
    }
    if (c === "\\" || c === "[") {
      out += `\\${c}`;
      continue;
    }
    out += c;
  }
  return null;
}

/** JavaScript RegExp source for a POSIX regex; `fixed` matches the text literally. */
export function posixToJs(pattern: string, mode: "basic" | "extended" | "fixed"): string {
  if (mode === "fixed") {
    return pattern.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  }
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "[") {
      const parsed = bracket(pattern, i);
      if (parsed) {
        out += parsed.source;
        i = parsed.end;
        continue;
      }
      out += "\\[";
      continue;
    }
    if (c === "\\") {
      const n = pattern[i + 1];
      i++;
      if (n === undefined) {
        out += "\\\\";
        continue;
      }
      if (n === "<" || n === ">") {
        out += "\\b";
        continue;
      }
      if (mode === "basic" && "(){}|+?".includes(n)) {
        out += n;
        continue;
      }
      out += `\\${n}`;
      continue;
    }
    if (mode === "basic") {
      if ("(){}|+?".includes(c)) {
        out += `\\${c}`;
        continue;
      }
      if (c === "*" && (out === "" || out.endsWith("(") || out === "^")) {
        out += "\\*";
        continue;
      }
    } else if (c === "*" && (out === "" || out.endsWith("(") || out.endsWith("|") || out === "^")) {
      out += "\\*";
      continue;
    }
    if (c === "/") {
      out += "\\/";
      continue;
    }
    out += c;
  }
  return out;
}
