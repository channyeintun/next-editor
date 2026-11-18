// The shell's file mode creation mask: what the `umask` builtin takes and
// prints, as bash does, and the filesystem a shell's commands and
// redirections create through. A subshell runs in its shell's process, where
// bash's runs in a fork with a mask of its own, so each shell keeps its mask
// (`Shell.umask`) and what it creates is made under that one.
import { runtime } from "../../runtime";
import type { FsBackend } from "../../runtime";

/** The largest mask: every permission bit. */
const ALL_BITS = 0o777;
const READ_BITS = 0o444;
const WRITE_BITS = 0o222;
const SEARCH_BITS = 0o111;
const WHO_BITS: Readonly<Record<string, number>> = {
  u: 0o700,
  g: 0o070,
  o: 0o007,
  a: ALL_BITS,
};

/** What `umask` was given: the mask it names, or why it names none (bash's words). */
export type ParsedUmask = { mask: number } | { error: string };

/**
 * The mask an octal operand names, as bash's `read_octal`: digits 0 to 7,
 * any number of them, and no more than 0777.
 */
function octalUmask(text: string): ParsedUmask {
  let mask = 0;
  for (const digit of text) {
    if (digit < "0" || digit > "7") {
      return { error: `${text}: octal number out of range` };
    }
    mask = mask * 8 + Number(digit);
    if (mask > ALL_BITS) {
      return { error: `${text}: octal number out of range` };
    }
  }
  return { mask };
}

/**
 * The mask a symbolic operand makes of `current`, as bash's
 * `symbolic_umask`: clauses `[ugoa…](+|-|=)[rwx…]` separated by commas, each
 * applied to the permissions the mask allows. With no `who`, `+` and `-`
 * act on every class and `=` sets every class. bash names the character it
 * could not take: the end of the text is shown as a NUL, as bash prints it.
 */
function symbolicUmask(text: string, current: number): ParsedUmask {
  let allowed = ~current & ALL_BITS;
  let at = 0;
  for (;;) {
    let who = 0;
    while (at < text.length && Object.hasOwn(WHO_BITS, text[at])) {
      who |= WHO_BITS[text[at]];
      at += 1;
    }
    const operator = at < text.length ? text[at] : "\0";
    at += 1;
    if (operator !== "+" && operator !== "-" && operator !== "=") {
      return { error: `\`${operator}': invalid symbolic mode operator` };
    }
    let permissions = 0;
    for (; at < text.length; at += 1) {
      if (text[at] === "r") {
        permissions |= READ_BITS;
      } else if (text[at] === "w") {
        permissions |= WRITE_BITS;
      } else if (text[at] === "x") {
        permissions |= SEARCH_BITS;
      } else {
        break;
      }
    }
    if (at < text.length && text[at] !== ",") {
      return { error: `\`${text[at]}': invalid symbolic mode character` };
    }
    if (who !== 0) {
      permissions &= who;
    }
    if (operator === "+") {
      allowed |= permissions;
    } else if (operator === "-") {
      allowed &= ~permissions;
    } else {
      allowed = (allowed & ~(who === 0 ? ALL_BITS : who)) | permissions;
    }
    if (at >= text.length) {
      return { mask: ~allowed & ALL_BITS };
    }
    at += 1;
  }
}

/**
 * The mask the operand of `umask` names, given the shell's `current` one: an
 * octal number when it starts with a digit, a symbolic mode otherwise.
 */
export function parseUmask(text: string, current: number): ParsedUmask {
  return /^[0-9]/.test(text) ? octalUmask(text) : symbolicUmask(text, current);
}

/** `mask` as `umask` prints it: four octal digits. */
export function formatUmask(mask: number): string {
  return mask.toString(8).padStart(4, "0");
}

/** `mask` as `umask -S` prints it: the permissions it allows (`u=rwx,g=rx,o=rx`). */
export function formatSymbolicUmask(mask: number): string {
  const allowed = ~mask & ALL_BITS;
  const letters = (bits: number) =>
    `${(bits & 4) !== 0 ? "r" : ""}${(bits & 2) !== 0 ? "w" : ""}${(bits & 1) !== 0 ? "x" : ""}`;
  return `u=${letters(allowed >> 6)},g=${letters(allowed >> 3)},o=${letters(allowed)}`;
}

/**
 * The process's filesystem for a shell whose mask is `umask()`: a call that
 * may make a file or a directory is made with that mask as the process's,
 * which is put back before the call returns, so nothing else the process
 * runs meanwhile (another subshell, the main shell) is ever under it. The
 * main shell's mask is the process's own, and its calls go straight through.
 */
export function filesystemUnder(umask: () => number): FsBackend {
  const rt = runtime();
  const fs = rt.fs;
  const creating = <T>(create: () => T): T => {
    const own = rt.umask;
    const mask = umask();
    if (mask === own) {
      return create();
    }
    rt.umask = mask;
    try {
      return create();
    } finally {
      rt.umask = own;
    }
  };
  return {
    ...fs,
    mkdir: (path, recursive, mode) => creating(() => fs.mkdir(path, recursive, mode)),
    mkdtemp: (prefix) => creating(() => fs.mkdtemp(prefix)),
    writeFile: (path, data, flags, mode) => creating(() => fs.writeFile(path, data, flags, mode)),
    open: (path, flags, mode) => creating(() => fs.open(path, flags, mode)),
  };
}
