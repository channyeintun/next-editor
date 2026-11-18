// What the callbacks of `write()` and `end()` are called with, as Node 22 and
// later call them: `null` when the write went through or the stream finished.
// readable-stream 4.8 is Node 18's stream code, which calls them with no
// argument, so a callback that tests `error !== null` would take success for
// a failure. An error is passed on as it is.
import type { StreamModule } from "./types";

type Callback = (error?: Error | null) => void;
type Method = (this: unknown, chunk?: unknown, encoding?: unknown, callback?: unknown) => unknown;

/** `callback`, told `null` where the library tells it nothing. */
function nullForNoError(callback: Callback): Callback {
  return (error) => callback(error ?? null);
}

/** `method` (`write` or `end`) with its callback, wherever it was passed, told as Node tells it. */
function withNodeCallback(method: Method): Method {
  return function (this: unknown, chunk?: unknown, encoding?: unknown, callback?: unknown) {
    if (typeof chunk === "function") {
      return method.call(this, nullForNoError(chunk as Callback));
    }
    if (typeof encoding === "function") {
      return method.call(this, chunk, nullForNoError(encoding as Callback));
    }
    return method.call(
      this,
      chunk,
      encoding,
      typeof callback === "function" ? nullForNoError(callback as Callback) : callback,
    );
  };
}

/**
 * Gives `write` and `end` of every Writable Node's callback arguments. A
 * Duplex holds the Writable's own two functions, which Transform and
 * PassThrough inherit, so both prototypes get the same new function, as in
 * Node, where `Duplex.prototype.write === Writable.prototype.write`.
 */
export function installWriteCallbacks(stream: StreamModule): void {
  const writable = stream.Writable.prototype as unknown as { write: Method; end: Method };
  const duplex = stream.Duplex.prototype as unknown as { write: Method; end: Method };
  for (const name of ["write", "end"] as const) {
    const method = withNodeCallback(writable[name]);
    writable[name] = method;
    duplex[name] = method;
  }
}
