// Centralized provisional limits and tuning constants (plan §8.5, §8.8,
// §13.1). Internal only — not exposed as user settings until measurements
// justify them.
export const LIMITS = {
  // Capture policy.
  maxCapturedDocumentBytes: 10 * 1024 * 1024,
  maxEventTextPayloadBytes: 2 * 1024 * 1024,
  maxEventsPerSession: 5_000_000,

  // Checkpoint policy: whichever threshold is crossed first.
  checkpointIntervalUs: 10_000_000,
  checkpointMaxTransactions: 500,
  checkpointMaxChangedBytes: 1024 * 1024,

  // Event-volume policy.
  viewportCoalesceMs: 50,

  // Storage (used from Phase 4 on).
  maxJournalQueueBytes: 32 * 1024 * 1024,
  journalFlushIntervalMs: 100,
  journalFlushBytes: 64 * 1024,
  journalSyncIntervalMs: 1000,

  // Artifact safety (used from Phase 6 on).
  maxArtifactEntries: 100_000,
  maxManifestBytes: 2 * 1024 * 1024,
  maxIntegrityBytes: 32 * 1024 * 1024,
  maxEventJournalBytes: 512 * 1024 * 1024,
  maxCheckpointBytes: 20 * 1024 * 1024,
  maxTotalExtractedBytes: 1024 * 1024 * 1024,
  maxDecompressionRatio: 200,

  // Runtime playback memory. JavaScript strings can use two bytes per
  // UTF-16 code unit, so this bounds cached checkpoint text separately
  // from archive byte limits.
  maxHostCheckpointCacheBytes: 64 * 1024 * 1024,
  maxPlayerCheckpointCodeUnits: 64 * 1024 * 1024,
} as const;
