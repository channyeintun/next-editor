import type { ErrorCode } from "./types";

export class RcpError extends Error {
  readonly code: ErrorCode;
  readonly fatal: boolean;

  constructor(code: ErrorCode, message: string) {
    const normalized = message.startsWith(`${code}:`) ? message : `${code}: ${message}`;
    super(normalized);
    this.name = "RcpError";
    this.code = code;
    this.fatal = code === "EGONE" || code === "EPROTO";
  }
}

export function fromWireError(error: { code: ErrorCode; message: string }): RcpError {
  return new RcpError(error.code, error.message);
}

export function isFatalRcpError(error: unknown): error is RcpError {
  return error instanceof RcpError && error.fatal;
}
