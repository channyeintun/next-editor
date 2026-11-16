// `cat [-n] [files…]`: standard input streams through chunk by chunk.
import type { Command } from "../context";
import { encode } from "../io";
import { inputs, options } from "./util";

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
    if (file === "-") {
      for (;;) {
        const chunk = await ctx.io.readChunk();
        if (chunk.length === 0 || ctx.io.broken) {
          break;
        }
        emit(chunk);
      }
      continue;
    }
    for await (const input of inputs(ctx, [file])) {
      if ("error" in input) {
        ctx.io.err(`cat: ${input.error}\n`);
        status = 1;
      } else {
        emit(input.data);
      }
    }
    if (ctx.io.broken) {
      break;
    }
  }
  return status;
};
