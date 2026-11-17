// `printf FORMAT [args…]`: %s %b %c %d %i %u %o %x %X %e %f %g %q %%, flags,
// width and precision (`*` too); the format is reused until the arguments run out.
import type { Command } from "../context";
import { shellQuote } from "../quote";
import { echoEscapes } from "./echo";
import { byteEscape, encodeText } from "./lines";

function numberArg(value: string | undefined, onError: (message: string) => void): number {
  if (value === undefined || value === "") {
    return 0;
  }
  if (/^['"]/.test(value)) {
    return value.codePointAt(1) ?? 0;
  }
  const trimmed = value.trim();
  const n = /^[+-]?0[xX][0-9a-fA-F]+$/.test(trimmed)
    ? parseInt(trimmed, 16)
    : /^[+-]?0[0-7]+$/.test(trimmed)
      ? parseInt(trimmed, 8)
      : Number(trimmed);
  if (Number.isNaN(n)) {
    onError(`${value}: invalid number`);
    return 0;
  }
  return n;
}

function pad(text: string, width: number, left: boolean, zero: boolean): string {
  if (text.length >= width) {
    return text;
  }
  if (left) {
    return text.padEnd(width);
  }
  if (zero) {
    const sign = /^[+-]/.test(text) ? text[0] : "";
    return sign + text.slice(sign.length).padStart(width - sign.length, "0");
  }
  return text.padStart(width);
}

/** Formats like printf(1); returns the text, whether `\c` stopped it, and any errors. */
export function formatPrintf(format: string, args: string[]): { text: string; errors: string[] } {
  let out = "";
  const errors: string[] = [];
  let argIndex = 0;
  const next = (): string | undefined => args[argIndex++];
  for (;;) {
    const startIndex = argIndex;
    for (let i = 0; i < format.length; i++) {
      const c = format[i];
      if (c === "\\") {
        const e = format[++i] ?? "";
        if (e === "c") {
          return { text: out, errors };
        }
        out += byteEscape(
          e,
          () => format[i + 1] ?? "",
          () => {
            i++;
          },
        );
        continue;
      }
      if (c !== "%") {
        out += c;
        continue;
      }
      const match = /^([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([a-zA-Z%])/.exec(format.slice(i + 1));
      if (!match) {
        errors.push(`%${format.slice(i + 1, i + 2)}: invalid conversion specification`);
        out += c;
        continue;
      }
      i += match[0].length;
      const flags = match[1];
      let width =
        match[2] === "*" ? numberArg(next(), (m) => errors.push(m)) : Number(match[2] ?? 0);
      let left = flags.includes("-");
      if (width < 0) {
        left = true;
        width = -width;
      }
      const precision =
        match[3] === undefined
          ? undefined
          : match[3] === "*"
            ? numberArg(next(), (m) => errors.push(m))
            : Number(match[3] || 0);
      const zero = flags.includes("0") && !left;
      const conversion = match[4];
      let text: string;
      switch (conversion) {
        case "%":
          out += "%";
          continue;
        case "s":
          text = next() ?? "";
          if (precision !== undefined) {
            text = text.slice(0, precision);
          }
          out += pad(text, width, left, false);
          continue;
        case "b": {
          const result = echoEscapes(next() ?? "");
          out += pad(result.text, width, left, false);
          if (result.stop) {
            return { text: out, errors };
          }
          continue;
        }
        case "q":
          out += pad(shellQuote(next() ?? ""), width, left, false);
          continue;
        case "c":
          out += pad((next() ?? "").slice(0, 1), width, left, false);
          continue;
        case "d":
        case "i":
        case "u": {
          const n = Math.trunc(numberArg(next(), (m) => errors.push(m)));
          text = String(Math.abs(n));
          if (precision !== undefined) {
            text = text.padStart(precision, "0");
          }
          text = (n < 0 ? "-" : flags.includes("+") ? "+" : flags.includes(" ") ? " " : "") + text;
          out += pad(text, width, left, zero && precision === undefined);
          continue;
        }
        case "o":
        case "x":
        case "X": {
          const n = Math.trunc(numberArg(next(), (m) => errors.push(m)));
          const unsigned = n < 0 ? BigInt.asUintN(64, BigInt(n)) : BigInt(n);
          text = unsigned.toString(conversion === "o" ? 8 : 16);
          if (conversion === "X") {
            text = text.toUpperCase();
          }
          if (precision !== undefined) {
            text = text.padStart(precision, "0");
          }
          if (flags.includes("#") && n !== 0) {
            text = (conversion === "o" ? "0" : conversion === "x" ? "0x" : "0X") + text;
          }
          out += pad(text, width, left, zero);
          continue;
        }
        case "f":
        case "F":
        case "e":
        case "E":
        case "g":
        case "G": {
          const n = numberArg(next(), (m) => errors.push(m));
          const p = precision ?? 6;
          if (conversion === "f" || conversion === "F") {
            text = n.toFixed(p);
          } else if (conversion === "e" || conversion === "E") {
            text = n.toExponential(p).replace(/e([+-])(\d)$/, "e$10$2");
          } else {
            text = String(Number(n.toPrecision(p || 1)));
          }
          if (conversion === "E" || conversion === "G") {
            text = text.toUpperCase();
          }
          if (n >= 0 && flags.includes("+")) {
            text = `+${text}`;
          }
          out += pad(text, width, left, zero);
          continue;
        }
        default:
          errors.push(`%${conversion}: invalid directive`);
      }
    }
    if (argIndex >= args.length || argIndex === startIndex) {
      break;
    }
  }
  return { text: out, errors };
}

/** `printf FORMAT [args…]`. */
export const printf: Command = (ctx, args) => {
  if (args[0] === "--") {
    args = args.slice(1);
  }
  if (args[0] === "-v") {
    ctx.io.err("printf: -v: not supported\n");
    return 2;
  }
  if (args.length === 0) {
    ctx.io.err("printf: usage: printf format [arguments]\n");
    return 2;
  }
  const { text, errors } = formatPrintf(args[0], args.slice(1));
  ctx.io.out(encodeText(text));
  for (const error of errors) {
    ctx.io.err(`printf: ${error}\n`);
  }
  return errors.length > 0 ? 1 : 0;
};
