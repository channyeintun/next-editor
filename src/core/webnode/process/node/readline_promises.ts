// The `readline/promises` builtin: `Interface` (whose `question` returns a
// promise), `Readline` and `createInterface`. The implementation lives in
// ./readline beside the callback API it shares everything with.
import { createPromisesInterface, promises, PromisesInterface, Readline } from "./readline";

/** `readline/promises` `Interface`. */
export { PromisesInterface as Interface, Readline, createPromisesInterface as createInterface };

/** `require("readline/promises")`. */
export default promises;
