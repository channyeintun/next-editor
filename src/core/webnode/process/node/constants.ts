// The deprecated `constants` builtin: one flat table merging `os.constants`
// (dlopen, errno, priority, signals), the filesystem constants and
// `crypto.constants`, in that order, as Node's lib/constants.js builds it.
// `fsConstants` re-exports the Linux `fs.constants` table that fs/constants.ts owns.
import { constants as cryptoConstants } from "./crypto/constants";
import { constants as fsTable } from "./fs/constants";
import { dlopen, errno, priority, signals } from "./os";

/** `fs.constants` with Linux values, in the order Node lists them on Linux (owned by fs/constants.ts). */
export const fsConstants: Readonly<Record<string, number>> = fsTable;

/** `require("constants")`. */
const constants: Readonly<Record<string, number | string>> = Object.freeze({
  ...dlopen,
  ...errno,
  ...priority,
  ...signals,
  ...fsConstants,
  ...cryptoConstants,
});

export default constants;
