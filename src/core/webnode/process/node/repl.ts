// The `repl` builtin. A REPL needs an evaluator wired to a terminal the way
// Node's own is; webnode does not provide one, so `start` and `REPLServer`
// throw. The constants and `builtinModules` are real so imports and feature
// checks work.
import { makeNodeError } from "./internalErrors";
import { BUILTIN_MODULE_NAMES } from "./names";
import { inspect } from "./util";

function unavailable(name: string): Error {
  return makeNodeError(
    "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    `repl.${name} is not available in webnode`,
  );
}

/** `repl.REPLServer`: constructing one throws. */
export class REPLServer {
  constructor(..._args: unknown[]) {
    throw unavailable("REPLServer");
  }
}

/** `repl.Recoverable`: the error a REPL evaluator throws for incomplete input. */
export class Recoverable extends SyntaxError {
  err: Error;

  constructor(err: Error) {
    super();
    this.err = err;
  }
}

/** `repl.start([options])`: throws. */
export function start(_options?: unknown): never {
  throw unavailable("start");
}

/** `repl.builtinModules`: builtin names without the `node:`-only and `_`-prefixed ones. */
export const builtinModules: string[] = BUILTIN_MODULE_NAMES.filter(
  (name) => !name.startsWith("_"),
);

/** `repl.REPL_MODE_SLOPPY`. */
export const REPL_MODE_SLOPPY = Symbol("repl-sloppy");
/** `repl.REPL_MODE_STRICT`. */
export const REPL_MODE_STRICT = Symbol("repl-strict");

const repl = {
  start,
  writer: inspect,
  REPLServer,
  REPL_MODE_SLOPPY,
  REPL_MODE_STRICT,
  Recoverable,
  builtinModules,
};

export default repl;
