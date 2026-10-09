// The one rule for what upstream text may reach the browser and the logs. A
// provider's error message or field (Modal in routes/studio.ts, AthanLab in
// athanlab/client.ts) is quoted back only after passing through here, so a
// hardening made once covers every provider.

export interface SanitizeUpstreamTextOptions {
  /** Exact strings to redact wherever they appear; empty ones are skipped. */
  secrets: readonly string[];
  /** Anything shaped like a credential, redacted too. Must carry the `g` flag. */
  secretPattern: RegExp;
  /** The longest result, ellipsis included. */
  maxChars: number;
}

/**
 * Make upstream text safe to hand back to the browser: the given secrets and
 * anything matching the secret pattern are redacted, control characters are
 * flattened, whitespace is collapsed, and the result is length-bounded. Null
 * when nothing is left.
 */
export function sanitizeUpstreamText(
  text: string,
  { secrets, secretPattern, maxChars }: SanitizeUpstreamTextOptions,
): string | null {
  let cleaned = text;
  for (const secret of secrets) {
    if (secret) cleaned = cleaned.split(secret).join("[redacted]");
  }
  cleaned = cleaned
    .replace(secretPattern, "[redacted]")
    // eslint-disable-next-line no-control-regex -- intentionally flattens control characters (newlines, ANSI escapes) out of quoted upstream text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}
