import { randomBase64Url } from "../base64url";

/** The exact bytes of a view as their own ArrayBuffer (what BLOB and WebSocket APIs take). */
export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 32 random bytes as unpadded base64url: invitation tokens and voice capabilities. */
export function randomToken(): string {
  return randomBase64Url(32);
}
