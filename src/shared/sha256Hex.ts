/**
 * Lowercase hex SHA-256, the content address the client and the Worker must
 * compute identically (workspace and collaboration asset ids, slide-image and
 * playground cache keys). A string is hashed as UTF-8; a view hashes only its
 * own window. WebCrypto rejects views on a SharedArrayBuffer (the app is
 * cross-origin isolated), so only such a view is copied into a fresh buffer;
 * every other view and buffer is digested in place.
 */
export async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  const input =
    bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
