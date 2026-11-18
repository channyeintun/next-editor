// What a `node` process does with a rejected promise nobody handled: Node's
// `--unhandled-rejections` modes, and the warnings that go with them.
import type { NodeProcess } from "../node/process";

/** The values `--unhandled-rejections` takes; `throw` is Node's default. */
const REJECTION_MODES = ["throw", "strict", "warn", "none", "warn-with-error-code"] as const;

export type RejectionMode = (typeof REJECTION_MODES)[number];

export function isRejectionMode(value: string): value is RejectionMode {
  return (REJECTION_MODES as readonly string[]).includes(value);
}

/** How V8 names a value without running its code: Node's text for a rejection reason. */
function describeReason(reason: unknown): string {
  if (typeof reason === "symbol") {
    return reason.toString();
  }
  if (reason === null || (typeof reason !== "object" && typeof reason !== "function")) {
    return String(reason);
  }
  if (Array.isArray(reason)) {
    return reason
      .map((item) => (item === null || item === undefined ? "" : describeReason(item)))
      .join(",");
  }
  const constructor = (reason as { constructor?: { name?: unknown } }).constructor;
  return `#<${typeof constructor?.name === "string" && constructor.name !== "" ? constructor.name : "Object"}>`;
}

/** An error, as far as a rejection's report goes: an object with its own `stack`. */
function isErrorLike(reason: unknown): reason is { stack: unknown } {
  return typeof reason === "object" && reason !== null && Object.hasOwn(reason, "stack");
}

/**
 * What Node raises for a rejected promise nobody handled: the reason itself
 * when it is an error (an object with its own `stack`), otherwise an
 * `UnhandledPromiseRejection` with code ERR_UNHANDLED_REJECTION that quotes it.
 */
export function unhandledRejectionError(reason: unknown): unknown {
  if (isErrorLike(reason)) {
    return reason;
  }
  const error = new Error(
    `This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${describeReason(reason)}".`,
  );
  Object.assign(error, { code: "ERR_UNHANDLED_REJECTION", name: "UnhandledPromiseRejection" });
  error.stack = error.stack?.replace(/^Error/, "UnhandledPromiseRejection");
  return error;
}

export interface RejectionReporter {
  /** `promise` rejected with `reason` and nobody handled it. */
  unhandled(reason: unknown, promise: Promise<unknown>): void;
  /** `promise`, reported as unhandled before, has a handler now. */
  handled(promise: Promise<unknown>): void;
}

/**
 * The reporter for `mode`. `raise` reports an error as an uncaught exception
 * that came from a rejection: it returns when an 'uncaughtException' listener
 * took it, and ends the process otherwise.
 */
export function createRejectionReporter(
  process: NodeProcess,
  mode: RejectionMode,
  raise: (error: unknown) => void,
): RejectionReporter {
  /** The id Node numbers each reported rejection with, for its warnings. */
  const ids = new WeakMap<Promise<unknown>, number>();
  let lastId = 0;

  const emit = (reason: unknown, promise: Promise<unknown>): boolean =>
    process.emit("unhandledRejection", reason, promise);

  const warn = (id: number, reason: unknown): void => {
    const warning = Object.assign(
      new Error(
        "Unhandled promise rejection. This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). To terminate the node process on unhandled promise rejection, use the CLI flag `--unhandled-rejections=strict` (see https://nodejs.org/api/cli.html#cli_unhandled_rejections_mode). " +
          `(rejection id: ${id})`,
      ),
      { name: "UnhandledPromiseRejectionWarning" },
    );
    if (isErrorLike(reason)) {
      warning.stack = String(reason.stack);
      process.emitWarning(String(reason.stack), "UnhandledPromiseRejectionWarning");
    } else {
      process.emitWarning(describeReason(reason), "UnhandledPromiseRejectionWarning");
    }
    process.emitWarning(warning);
  };

  return {
    unhandled(reason, promise) {
      lastId += 1;
      const id = lastId;
      ids.set(promise, id);
      switch (mode) {
        case "strict":
          raise(unhandledRejectionError(reason));
          if (!emit(reason, promise)) {
            warn(id, reason);
          }
          break;
        case "none":
          emit(reason, promise);
          break;
        case "warn":
          emit(reason, promise);
          warn(id, reason);
          break;
        case "warn-with-error-code":
          if (!emit(reason, promise)) {
            warn(id, reason);
            process.exitCode = 1;
          }
          break;
        case "throw":
          if (!emit(reason, promise)) {
            raise(unhandledRejectionError(reason));
          }
          break;
      }
    },
    handled(promise) {
      const id = ids.get(promise);
      if (id === undefined) {
        return;
      }
      ids.delete(promise);
      if (!process.emit("rejectionHandled", promise)) {
        process.emitWarning(
          Object.assign(
            new Error(`Promise rejection was handled asynchronously (rejection id: ${id})`),
            { name: "PromiseRejectionHandledWarning", id },
          ),
        );
      }
    },
  };
}
