// The `punycode` builtin: the npm `punycode` package (the same code Node
// bundles), imported with a trailing slash so a Node test run does not pick
// Node's own builtin.
import punycode from "punycode/";

/** `require("punycode")`. */
export default punycode;

export const { decode, encode, toASCII, toUnicode, ucs2, version } = punycode;
