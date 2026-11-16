// The `stream/promises` builtin: promise forms of `pipeline` and `finished`,
// the same functions as `require("stream").promises`.
import stream from "./stream";

/** `stream.promises.pipeline`. */
export const pipeline = stream.promises.pipeline;
/** `stream.promises.finished`. */
export const finished = stream.promises.finished;

/** What `require("stream/promises")` returns. */
const streamPromises = stream.promises;

export default streamPromises;
