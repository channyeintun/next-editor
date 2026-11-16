// `tee [-a] files…`: copies standard input to standard output and each file as it arrives.
import { O_APPEND, O_CREAT, O_TRUNC, O_WRONLY } from "../../../../kernel/vfs/types";
import { runtime } from "../../../runtime";
import type { Command } from "../context";
import { closeFd, writeFd } from "../io";
import { errorText } from "./util";

/** `tee`. */
export const tee: Command = async (ctx, args) => {
  let append = false;
  const files: string[] = [];
  for (const arg of args) {
    if (arg === "-a" || arg === "--append") {
      append = true;
    } else if (arg === "-i" || arg === "-p") {
      continue;
    } else {
      files.push(arg);
    }
  }
  const fs = runtime().fs;
  const fds: number[] = [];
  let status = 0;
  for (const file of files) {
    try {
      fds.push(
        fs.open(ctx.resolve(file), O_WRONLY | O_CREAT | (append ? O_APPEND : O_TRUNC), 0o666),
      );
    } catch (error) {
      ctx.io.err(`tee: ${file}: ${errorText(error)}\n`);
      status = 1;
    }
  }
  try {
    for (;;) {
      const chunk = await ctx.io.readChunk();
      if (chunk.length === 0) {
        break;
      }
      ctx.io.out(chunk);
      for (const fd of fds) {
        writeFd(fd, chunk);
      }
    }
  } finally {
    fds.forEach(closeFd);
  }
  return status;
};
