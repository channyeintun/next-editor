// Owns the `assert/strict` builtin module: `require("assert/strict")` is
// `require("assert").strict`.
import assert from "./assert";

/** `assert.strict`. */
const strict = assert.strict;

export default strict;
