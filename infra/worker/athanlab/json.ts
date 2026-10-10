// Reading AthanLab's JSON answers: the body caps and the field readers shared
// by the key check, the voice and usage routes, and synthesis.

export const MAX_VOICE_LIST_BYTES = 512 * 1024;
// Jobs, quotes, usage, previews: a few hundred bytes each.
export const MAX_JSON_BYTES = 64 * 1024;

export function nonNegativeIntegerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

export function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
