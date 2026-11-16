// The `string_decoder` builtin: the npm `string_decoder` package (Node's own
// implementation, published), imported with a trailing slash so a Node test
// run does not pick Node's builtin.
import { StringDecoder } from "string_decoder/";

export { StringDecoder };

/** `require("string_decoder")`. */
export default { StringDecoder };
