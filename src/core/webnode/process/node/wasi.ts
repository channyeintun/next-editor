// The `wasi` builtin. Node's WASI binds to libuv's uvwasi, which webnode does
// not have; the class exists so imports succeed and throws when constructed.
import { makeNodeError } from "./internalErrors";

/** `wasi.WASI`: constructing one throws. */
export class WASI {
  constructor(_options?: unknown) {
    throw makeNodeError(
      "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
      "wasi.WASI is not available in webnode",
    );
  }
}

const wasi = { WASI };

export default wasi;
