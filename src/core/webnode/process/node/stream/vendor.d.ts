// The readable-stream entry webnode imports. `lib/stream.js` is Node's own
// stream module extracted (readable-stream@4.8.0); stream.ts casts it to the
// shape in stream/types.ts. Importing it (not the package main) skips the
// main's `require("stream")`.
declare module "readable-stream/lib/stream.js" {
  const Stream: unknown;
  export default Stream;
}

// readable-stream's destroy helpers, which stream/paused_read.ts shares with
// the library's own `read`.
declare module "readable-stream/lib/internal/streams/destroy.js" {
  const destroyImpl: {
    /** Destroys `stream` with `error`, or only reports it on a stream that does not destroy itself. */
    errorOrDestroy(stream: unknown, error: unknown, sync?: boolean): void;
  };
  export default destroyImpl;
}

// readable-stream's error factory: `codes` holds a class for each `ERR_*`
// code the library raises (stream/node_errors.ts gives them Node's shape).
declare module "readable-stream/lib/ours/errors.js" {
  const errors: {
    codes: Record<string, new (...args: unknown[]) => Error>;
  };
  export default errors;
}
