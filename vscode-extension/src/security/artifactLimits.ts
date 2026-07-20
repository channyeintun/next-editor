import { LIMITS } from "../model/limits";

// Reader-side artifact limits (plan §13.1/§13.2), centralized so tests and
// documentation reference one source.
export const ARTIFACT_LIMITS = {
  maxEntries: LIMITS.maxArtifactEntries,
  maxManifestBytes: LIMITS.maxManifestBytes,
  maxIntegrityBytes: LIMITS.maxIntegrityBytes,
  maxEventJournalBytes: LIMITS.maxEventJournalBytes,
  maxCheckpointBytes: LIMITS.maxCheckpointBytes,
  maxTotalExtractedBytes: LIMITS.maxTotalExtractedBytes,
  maxDecompressionRatio: LIMITS.maxDecompressionRatio,
  // index.json and events.ndjson share the total-extraction budget; the
  // seek index alone must stay small.
  maxIndexBytes: 64 * 1024 * 1024,
} as const;

export type EntrySizeVerdict = { ok: true } | { ok: false; reason: string };

export function validateEntrySizes(
  entryName: string,
  compressedSize: number,
  uncompressedSize: number,
): EntrySizeVerdict {
  if (uncompressedSize < 0 || compressedSize < 0) {
    return { ok: false, reason: `${entryName}: negative size` };
  }
  if (uncompressedSize > 0 && compressedSize === 0) {
    return {
      ok: false,
      reason: `${entryName}: non-empty entry has zero compressed size`,
    };
  }
  if (
    compressedSize > 0 &&
    uncompressedSize / compressedSize > ARTIFACT_LIMITS.maxDecompressionRatio
  ) {
    return {
      ok: false,
      reason: `${entryName}: decompression ratio ${Math.round(uncompressedSize / compressedSize)} exceeds ${ARTIFACT_LIMITS.maxDecompressionRatio}`,
    };
  }
  return { ok: true };
}
