import { RcpError } from "./errors";
import { RCP_LIMITS, type ControlFrame, type ErrorCode } from "./types";

export const BINARY_FIN = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const controlTypes = new Set(["req", "ok", "err", "evt"]);
const errorCodes = new Set<ErrorCode>([
  "ENOENT",
  "EEXIST",
  "ENOTDIR",
  "EISDIR",
  "ENOTEMPTY",
  "EACCES",
  "EPROTO",
  "ELIMIT",
  "EGONE",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeControlFrame(frame: ControlFrame): string {
  const encoded = JSON.stringify(frame);
  if (encoder.encode(encoded).byteLength > RCP_LIMITS.maxControlFrameBytes) {
    throw new RcpError("ELIMIT", "control frame exceeds 1 MiB");
  }
  return encoded;
}

export function parseControlFrame(input: string | Uint8Array): ControlFrame {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  if (bytes.byteLength > RCP_LIMITS.maxControlFrameBytes) {
    throw new RcpError("ELIMIT", "control frame exceeds 1 MiB");
  }

  let value: unknown;
  try {
    value = JSON.parse(typeof input === "string" ? input : decoder.decode(input));
  } catch {
    throw new RcpError("EPROTO", "invalid control frame JSON");
  }
  if (!isRecord(value) || typeof value.t !== "string" || !controlTypes.has(value.t)) {
    throw new RcpError("EPROTO", "unknown control frame type");
  }
  if (value.t === "req") {
    if (!Number.isSafeInteger(value.id) || typeof value.m !== "string" || !isRecord(value.p)) {
      throw new RcpError("EPROTO", "malformed request frame");
    }
  } else if (value.t === "ok") {
    if (!Number.isSafeInteger(value.id) || !("r" in value)) {
      throw new RcpError("EPROTO", "malformed success frame");
    }
  } else if (value.t === "err") {
    if (!Number.isSafeInteger(value.id) || !isRecord(value.e) ||
        typeof value.e.code !== "string" || !errorCodes.has(value.e.code as ErrorCode) ||
        typeof value.e.message !== "string") {
      throw new RcpError("EPROTO", "malformed error frame");
    }
  } else if (typeof value.m !== "string" || !isRecord(value.p)) {
    throw new RcpError("EPROTO", "malformed event frame");
  }
  return value as ControlFrame;
}

export interface BinaryFrame {
  channelId: number;
  fin: boolean;
  payload: Uint8Array;
}

export function encodeBinaryFrame(
  channelId: number,
  payload: Uint8Array = new Uint8Array(),
  fin = false,
): Uint8Array {
  if (!Number.isInteger(channelId) || channelId <= 0 || channelId > 0xffffffff) {
    throw new RcpError("EPROTO", "invalid channel id");
  }
  if (payload.byteLength > RCP_LIMITS.maxBinaryFrameBytes) {
    throw new RcpError("ELIMIT", "binary frame exceeds 256 KiB");
  }
  const frame = new Uint8Array(5 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, channelId, true);
  frame[4] = fin ? BINARY_FIN : 0;
  frame.set(payload, 5);
  return frame;
}

export function parseBinaryFrame(frame: ArrayBuffer | Uint8Array): BinaryFrame {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < 5) throw new RcpError("EPROTO", "truncated binary frame");
  if (bytes.byteLength - 5 > RCP_LIMITS.maxBinaryFrameBytes) {
    throw new RcpError("ELIMIT", "binary frame exceeds 256 KiB");
  }
  const channelId = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (channelId === 0 || (bytes[4]! & ~BINARY_FIN) !== 0) {
    throw new RcpError("EPROTO", "invalid binary frame header");
  }
  return { channelId, fin: (bytes[4]! & BINARY_FIN) !== 0, payload: bytes.slice(5) };
}
