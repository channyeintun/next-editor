// The registry of built-in file and text commands: name → implementation.
// Each command lives in its own file beside this one.
import type { Command } from "../context";
import { basename } from "./basename";
import { cat } from "./cat";
import { chmod } from "./chmod";
import { cp } from "./cp";
import { curl } from "./curl";
import { cut } from "./cut";
import { date } from "./date";
import { dirname } from "./dirname";
import { echo } from "./echo";
import { env } from "./env";
import { find } from "./find";
import { grep } from "./grep";
import { head } from "./head";
import { ln } from "./ln";
import { ls } from "./ls";
import { mkdir } from "./mkdir";
import { mv } from "./mv";
import { printf } from "./printf";
import { readlink } from "./readlink";
import { realpath } from "./realpath";
import { rm } from "./rm";
import { rmdir } from "./rmdir";
import { sed } from "./sed";
import { seq } from "./seq";
import { sleep } from "./sleep";
import { sort } from "./sort";
import { hostname, uname, whoami } from "./system";
import { tail } from "./tail";
import { tee } from "./tee";
import { touch } from "./touch";
import { tr } from "./tr";
import { uniq } from "./uniq";
import { wc } from "./wc";
import { xargs } from "./xargs";
import { yes } from "./yes";

/**
 * The commands here that a shell runs itself, as its builtins, where the
 * others are programs with a process of their own: what a signal does to
 * one of these it does to the shell that runs it (SIGPIPE at a write of
 * `echo` ends the shell, as in bash).
 */
export const SHELL_BUILTIN_COMMANDS: ReadonlySet<string> = new Set(["echo", "printf"]);

/** Built-in commands by name. They run inside the shell process. */
export const COMMANDS: Record<string, Command> = {
  basename,
  cat,
  chmod,
  cp,
  curl,
  cut,
  date,
  dirname,
  echo,
  egrep: (ctx, args) => grep(ctx, ["-E", ...args]),
  env,
  fgrep: (ctx, args) => grep(ctx, ["-F", ...args]),
  find,
  grep,
  head,
  hostname,
  ln,
  ls,
  mkdir,
  mv,
  printf,
  readlink,
  realpath,
  rm,
  rmdir,
  sed,
  seq,
  sleep,
  sort,
  tail,
  tee,
  touch,
  tr,
  uname,
  uniq,
  wc,
  whoami,
  xargs,
  yes,
};
