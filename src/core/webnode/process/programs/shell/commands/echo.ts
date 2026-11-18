// `echo` with `-n`, `-e` and `-E`.
import type { Command } from "../context";
import { byteChar, byteEscape, encodeText } from "./lines";

/** Expands `echo -e` / `printf %b` escapes; `\c` stops output (reported as `stop`). */
export function echoEscapes(text: string): { text: string; stop: boolean } {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "\\" || i + 1 >= text.length) {
      out += c;
      continue;
    }
    const e = text[++i];
    if (e === "c") {
      return { text: out, stop: true };
    }
    if (e === "0") {
      // `\0nnn`: up to three octal digits after the zero.
      let digits = "";
      while (digits.length < 3 && /[0-7]/.test(text[i + 1] ?? "")) {
        digits += text[++i];
      }
      out += byteChar(parseInt(digits || "0", 8) & 0xff);
      continue;
    }
    out += byteEscape(
      e,
      () => text[i + 1] ?? "",
      () => {
        i++;
      },
    );
  }
  return { text: out, stop: false };
}

/** `echo [-neE] [args…]`. */
export const echo: Command = (ctx, args) => {
  let newline = true;
  let escapes = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (!/^-[neE]+$/.test(arg)) {
      break;
    }
    for (const flag of arg.slice(1)) {
      if (flag === "n") {
        newline = false;
      } else if (flag === "e") {
        escapes = true;
      } else {
        escapes = false;
      }
    }
  }
  let text = args.slice(i).join(" ");
  if (escapes) {
    const result = echoEscapes(text);
    text = result.text;
    if (result.stop) {
      ctx.io.out(encodeText(text));
      return 0;
    }
  }
  // The shell says why a write failed, as it does for every command.
  return ctx.io.out(encodeText(newline ? `${text}\n` : text)) ? 0 : 1;
};
