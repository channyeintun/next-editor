// `tr [-d] [-s] [-c] set1 [set2]`: ranges, escapes and `[:class:]` sets.
import type { Command } from "../context";
import { decode, encode } from "../io";
import { decodeEscape } from "../lexer";

const CLASSES: Record<string, () => string[]> = {
  upper: () => range("A", "Z"),
  lower: () => range("a", "z"),
  digit: () => range("0", "9"),
  alpha: () => [...range("A", "Z"), ...range("a", "z")],
  alnum: () => [...range("0", "9"), ...range("A", "Z"), ...range("a", "z")],
  space: () => [" ", "\t", "\n", "\r", "\f", "\v"],
  blank: () => [" ", "\t"],
  punct: () => Array.from("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"),
  xdigit: () => [...range("0", "9"), ...range("A", "F"), ...range("a", "f")],
};

function range(from: string, to: string): string[] {
  const out: string[] = [];
  for (let c = from.codePointAt(0) as number; c <= (to.codePointAt(0) as number); c++) {
    out.push(String.fromCodePoint(c));
  }
  return out;
}

/** Expands a `tr` set into its characters. */
export function expandSet(spec: string): string[] {
  const chars: string[] = [];
  const raw = Array.from(spec);
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\" && i + 1 < raw.length) {
      const e = raw[++i];
      tokens.push(
        decodeEscape(
          e,
          () => raw[i + 1] ?? "",
          () => {
            i++;
          },
        ).replace(/^\\(.)$/, "$1"),
      );
      continue;
    }
    if (raw[i] === "[" && raw[i + 1] === ":") {
      const close = spec.indexOf(":]", i);
      const name =
        close < 0
          ? ""
          : raw
              .slice(i + 2)
              .join("")
              .split(":]")[0];
      if (CLASSES[name]) {
        tokens.push(`\0class:${name}`);
        i += name.length + 3;
        continue;
      }
    }
    tokens.push(raw[i]);
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("\0class:")) {
      chars.push(...CLASSES[token.slice(7)]());
      continue;
    }
    if (
      tokens[i + 1] === "-" &&
      tokens[i + 2] !== undefined &&
      !tokens[i + 2].startsWith("\0class:")
    ) {
      chars.push(...range(token, tokens[i + 2]));
      i += 2;
      continue;
    }
    chars.push(token);
  }
  return chars;
}

/** `tr`. */
export const tr: Command = async (ctx, args) => {
  let del = false;
  let squeeze = false;
  let complement = false;
  const sets: string[] = [];
  for (const arg of args) {
    if (/^-[dscC]+$/.test(arg) && sets.length === 0) {
      del ||= arg.includes("d");
      squeeze ||= arg.includes("s");
      complement ||= arg.includes("c") || arg.includes("C");
    } else {
      sets.push(arg);
    }
  }
  if (sets.length === 0 || (!del && !squeeze && sets.length < 2)) {
    ctx.io.err(
      sets.length === 0 ? "tr: missing operand\n" : `tr: missing operand after '${sets[0]}'\n`,
    );
    return 1;
  }
  const set1 = new Set(expandSet(sets[0]));
  const inSet1 = (c: string): boolean => (complement ? !set1.has(c) : set1.has(c));
  const list1 = expandSet(sets[0]);
  const list2 = sets[1] !== undefined ? expandSet(sets[1]) : [];
  const squeezeSet = new Set(del ? list2 : list2.length > 0 ? list2 : list1);
  const text = decode(await ctx.io.readAll());
  let out = "";
  let last = "";
  for (const c of text) {
    let mapped: string | null = c;
    if (del) {
      if (inSet1(c)) {
        mapped = null;
      }
    } else if (list2.length > 0 && inSet1(c)) {
      if (complement) {
        mapped = list2[list2.length - 1];
      } else {
        const index = list1.lastIndexOf(c);
        mapped = list2[Math.min(index, list2.length - 1)];
      }
    }
    if (mapped === null) {
      continue;
    }
    if (
      squeeze &&
      mapped === last &&
      (squeezeSet.has(mapped) || (complement && !del && list2.length === 0 && inSet1(mapped)))
    ) {
      continue;
    }
    out += mapped;
    last = mapped;
  }
  ctx.io.out(encode(out));
  return 0;
};
