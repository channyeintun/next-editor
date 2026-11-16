// Tarball integrity: Subresource Integrity strings (`sha512-<base64>`, the
// strongest listed algorithm wins) through `crypto.subtle`, falling back to the
// packument's hex `shasum` (sha1) when there is no integrity string.

/** The outcome of checking bytes against a packument's `dist` fields. */
export type IntegrityResult =
  | { ok: true; algorithm: string }
  | { ok: false; algorithm: string; expected: string; actual: string }
  | { ok: true; algorithm: null };

const ALGORITHMS: Record<string, string> = {
  sha512: "SHA-512",
  sha384: "SHA-384",
  sha256: "SHA-256",
  sha1: "SHA-1",
};
const STRENGTH = ["sha512", "sha384", "sha256", "sha1"];

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function digest(algorithm: string, bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest(ALGORITHMS[algorithm], bytes as Uint8Array<ArrayBuffer>),
  );
}

/**
 * Checks `bytes` against `integrity` (an SRI string, possibly several
 * space-separated hashes) or else `shasum`. With neither, the result is
 * `{ ok: true, algorithm: null }`: nothing to verify against.
 */
export async function verifyIntegrity(
  bytes: Uint8Array,
  integrity: string | undefined,
  shasum: string | undefined,
): Promise<IntegrityResult> {
  if (integrity) {
    const hashes = new Map<string, string[]>();
    for (const token of integrity.trim().split(/\s+/)) {
      const dash = token.indexOf("-");
      if (dash === -1) {
        continue;
      }
      const algorithm = token.slice(0, dash).toLowerCase();
      const value = token.slice(dash + 1).split("?")[0];
      if (algorithm in ALGORITHMS) {
        hashes.set(algorithm, [...(hashes.get(algorithm) ?? []), value]);
      }
    }
    const algorithm = STRENGTH.find((name) => hashes.has(name));
    if (algorithm) {
      const actual = toBase64(await digest(algorithm, bytes));
      const expected = hashes.get(algorithm)!;
      return expected.includes(actual)
        ? { ok: true, algorithm }
        : { ok: false, algorithm, expected: expected[0], actual };
    }
  }
  if (shasum) {
    const actual = toHex(await digest("sha1", bytes));
    return actual === shasum.toLowerCase()
      ? { ok: true, algorithm: "sha1" }
      : { ok: false, algorithm: "sha1", expected: shasum, actual };
  }
  return { ok: true, algorithm: null };
}

/** The SRI string for `bytes` (sha512), as npm records it. */
export async function integrityOf(bytes: Uint8Array): Promise<string> {
  return `sha512-${toBase64(await digest("sha512", bytes))}`;
}

/** Hex SHA-256 of a string (manifest fingerprints). */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(await digest("sha256", new TextEncoder().encode(text)));
}
