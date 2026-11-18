// Writing bytes to a file descriptor whatever it is, past any Node stream:
// a pipe or a terminal through the runtime's stream write (in order with
// every other write of this process to it), nothing at all for /dev/null,
// and anything else (a file) through `fs.write` at the file's own offset.
// The `node` program's fatal report, the package managers' output and the
// process worker's report of a program that failed to start all write so.
import { runtime } from "../../runtime";

/**
 * Writes `bytes` to `fd`.
 *
 * Without `done` the write blocks until the bytes are in, as write(2) does,
 * and throws its error (EPIPE when a pipe's reader has gone, EBADF for a
 * closed fd).
 *
 * With `done`, a write to a pipe or a terminal is handed to the runtime and
 * `done` runs once it is in, or with its error; for /dev/null and a file the
 * write is complete when this returns and `done` has run with null. A file's
 * error is thrown, as without `done`.
 *
 * An fd whose kind cannot be told (closed, or never opened) is written as a
 * file, so the write fails as that fd's write fails.
 */
export function writeFd(fd: number, bytes: Uint8Array, done?: (error: Error | null) => void): void {
  const rt = runtime();
  let kind: string;
  try {
    kind = rt.fdStream.kind(fd);
  } catch {
    kind = "file";
  }
  if (kind === "pipe" || kind === "tty") {
    rt.fdStream.write(fd, bytes, done);
    return;
  }
  if (kind !== "null") {
    rt.fs.write(fd, bytes, null);
  }
  done?.(null);
}
