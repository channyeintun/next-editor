// The coded errors the stream builtin raises, shaped as Node's. readable-stream
// builds each `ERR_*` error as an instance of a class of its own (`NodeError`,
// with `code` on the prototype), so a program saw `NodeError: write after end`
// where Node prints `Error [ERR_STREAM_WRITE_AFTER_END]: write after end`.
// Node's error has an own `code` and `message`, a stack whose first line names
// the code, and a prototype of its code's own (`toString()` giving
// `Name [CODE]: message`, and `constructor` the Error, TypeError or RangeError
// it extends).
//
// The library's modules took their classes out of `codes` as they loaded, so
// the classes stay and what they build changes: each class's prototype
// becomes that code's prototype, and its `super()` call, which goes to the
// function its constructor inherits from as it runs, goes to one that builds
// the error as Node does.
import errors from "readable-stream/lib/ours/errors.js";
import { nameCodeInStack } from "../internalErrors";

type ErrorClass = new (...args: unknown[]) => Error;

/**
 * The message as Node words it. A stream's byte chunk may be any view
 * (stream/view_chunks.ts), which Node's refusal names; the library names the
 * two it takes itself. The library raises ERR_MISSING_ARGS only for the
 * "streams" of `pipeline` and `compose`, and its wording function loses the
 * argument's name, so the message is Node's for that one argument.
 */
function nodeMessage(code: string, message: string): string {
  switch (code) {
    case "ERR_INVALID_ARG_TYPE":
      return message.replace(
        "an instance of Buffer or Uint8Array.",
        "an instance of Buffer, TypedArray, or DataView.",
      );
    case "ERR_MISSING_ARGS":
      return 'The "streams" argument must be specified';
    default:
      return message;
  }
}

/** Gives every class in readable-stream's `codes` Node's error shape. Runs once. */
export function installNodeErrors(): void {
  for (const [code, Class] of Object.entries(errors.codes)) {
    const Base = Object.getPrototypeOf(Class) as ErrorClass;
    if (Base !== Error && !Object.prototype.isPrototypeOf.call(Error, Base)) {
      continue;
    }
    Object.defineProperty(Class.prototype, "constructor", {
      value: Base,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    function NodeShaped(message: string): Error {
      // Built for `new.target`, so the stack starts where the library raised
      // the error, below its class's constructor, as Node's does.
      const error = Reflect.construct(Base, [nodeMessage(code, message)], new.target) as Error & {
        code: string;
      };
      error.code = code;
      nameCodeInStack(error, code);
      return error;
    }
    Object.setPrototypeOf(Class, NodeShaped);
  }
}
