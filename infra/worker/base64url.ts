import { bytesToBase64 } from "../../src/shared/base64";

// Unpadded base64url (RFC 4648 §5), the URL-safe form of the standard base64
// in src/shared/base64.ts: OAuth state and PKCE values, JWT segments, and the
// collaboration invitation and voice capability tokens.

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  return bytesToBase64(new Uint8Array(bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// Returns a view over a plain ArrayBuffer, not the default ArrayBufferLike:
// crypto.subtle.verify takes a BufferSource, which excludes SharedArrayBuffer
// views. Uint8Array.from always allocates a fresh non-shared buffer, so the
// narrower type is exact rather than an assertion.
export function base64UrlDecodeToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLength));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** `byteLength` random bytes, base64url-encoded. */
export function randomBase64Url(byteLength: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}
