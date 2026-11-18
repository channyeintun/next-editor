// `tee [-a] files…`: copies standard input to standard output and each file as it arrives.
import { O_APPEND, O_CREAT, O_TRUNC, O_WRONLY } from "../../../../kernel/vfs/types";
import type { Command } from "../context";
import { closeFd, descriptorOf, writeFd } from "../io";
import { absolutePath, errorText, quoteName } from "./util";

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
  const fs = ctx.fs;
  /** The files it opened, and the fds of its own that operands name (/dev/stderr). */
  const opened: number[] = [];
  const fds: number[] = [];
  let status = 0;
  for (const file of files) {
    const named = descriptorOf(file);
    const own = named === null ? null : ctx.io.fd(named);
    if (own !== null) {
      fds.push(own);
      continue;
    }
    try {
      const fd = fs.open(
        absolutePath(ctx.cwd, file),
        O_WRONLY | O_CREAT | (append ? O_APPEND : O_TRUNC),
        0o666,
      );
      opened.push(fd);
      fds.push(fd);
    } catch (error) {
      ctx.io.err(`tee: ${quoteName(file)}: ${errorText(error)}\n`);
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
    opened.forEach(closeFd);
  }
  return status;
};
