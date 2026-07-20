/** Content hashing for build provenance — SHA-256 via WebCrypto, hex encoded. */

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  // Copy into a fresh ArrayBuffer so SharedArrayBuffer-backed views (possible
  // under cross-origin isolation) satisfy WebCrypto's BufferSource contract.
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256HexOfText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

/**
 * Stable JSON stringification: object keys sorted at every level so logically
 * identical values always hash identically. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, sortValue(entryValue)]));
  }
  return value;
}

export async function sha256HexOfJson(value: unknown): Promise<string> {
  return sha256HexOfText(canonicalJson(value));
}

/** Hash a workspace's files as `path\n<sha256(content)>\n` lines over sorted paths. */
export async function hashWorkspaceFiles(files: Record<string, string>): Promise<string> {
  const lines: string[] = [];
  for (const path of Object.keys(files).sort()) {
    lines.push(`${path}\n${await sha256HexOfText(files[path])}`);
  }
  return sha256HexOfText(lines.join("\n"));
}
