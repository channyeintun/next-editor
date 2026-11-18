// `cat [-n] [files…]`: standard input, and a device named as a file, stream
// through chunk by chunk.
import type { Command } from "../context";
import { encode } from "../io";
import { inputChunks, options, quoteName } from "./util";

/** `cat`. */
export const cat: Command = async (ctx, args) => {
  const parsed = options(ctx, args, { flags: "nbsuAEvT", long: { number: "n" } });
  if (!parsed) {
    return 1;
  }
  const number = parsed.flags.has("n");
  let status = 0;
  let line = 1;
  let atLineStart = true;
  const emit = (bytes: Uint8Array): void => {
    if (!number) {
      ctx.io.out(bytes);
      return;
    }
    const text = new TextDecoder().decode(bytes);
    let out = "";
    for (const ch of text) {
      if (atLineStart) {
        out += `${String(line++).padStart(6)}\t`;
        atLineStart = false;
      }
      out += ch;
      if (ch === "\n") {
        atLineStart = true;
      }
    }
    ctx.io.out(encode(out));
  };
  const files = parsed.operands.length > 0 ? parsed.operands : ["-"];
  for (const file of files) {
    for await (const chunk of inputChunks(ctx, file)) {
      if (!(chunk instanceof Uint8Array)) {
        ctx.io.err(`cat: ${quoteName(chunk.name)}: ${chunk.error}\n`);
        status = 1;
      } else if (!ctx.io.broken) {
        emit(chunk);
      }
      // Nobody reads the output any more: no more input is taken.
      if (ctx.io.broken) {
        break;
      }
    }
    if (ctx.io.broken) {
      break;
    }
  }
  return status;
};
