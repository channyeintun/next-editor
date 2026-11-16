// The package manager's own failures. Each carries a tool-neutral code; the
// reporter (output.ts) prints it in the voice of the tool that was invoked
// (`ERR_PNPM_FETCH_404`, `npm error code E404`, `error …`).

/** Why an install or a command failed, independent of which tool was invoked. */
export type PmErrorCode =
  /** A package or version is not in the registry. */
  | "E404"
  /** No version satisfies the requested range or tag. */
  | "ETARGET"
  /** A tarball does not match its recorded integrity. */
  | "EINTEGRITY"
  /** A registry request failed after its retries. */
  | "EFETCH"
  /** A dependency spec this installer cannot install (`workspace:`, git, …). */
  | "EUNSUPPORTED"
  /** A package name that is not valid (it would leave node_modules or break a URL). */
  | "EINVALIDPACKAGENAME"
  /** No package.json in the project directory. */
  | "ENOPKG"
  /** package.json (or a packument) is not valid JSON. */
  | "EJSONPARSE"
  /** A tarball could not be read. */
  | "ETAR"
  /** `run` of a script the manifest does not have. */
  | "ENOSCRIPT"
  /** `exec` of a command that is neither installed nor installable. */
  | "ENOCMD"
  /** Anything else, with its message. */
  | "EOTHER";

/** An error the package manager reports and exits 1 on. */
export class PmError extends Error {
  readonly code: PmErrorCode;
  /** Extra lines printed after the message. */
  readonly detail: string[];

  constructor(code: PmErrorCode, message: string, detail: string[] = []) {
    super(message);
    this.name = "PmError";
    this.code = code;
    this.detail = detail;
  }
}

/** True for a `PmError`. */
export function isPmError(error: unknown): error is PmError {
  return error instanceof PmError;
}
