import type { SessionEvent } from "../model/events";

// Seek index (plan §9.6): regular time buckets mapping to the applicable
// event position, the nearest checkpoint per document, and the applicable
// topology snapshot. One-second buckets until measurements justify change.
export type SeekBucket = {
  tUs: number;
  /** Last event seq with tUs <= bucket start (-1 before the first event). */
  upToSeq: number;
  /** Byte offset of the next event line in events.ndjson. */
  nextByteOffset: number | null;
  /** Nearest checkpoint at or before this bucket, per document. */
  checkpoints: Record<string, string>;
  /** Seq of the applicable topology snapshot (-1 if none yet). */
  topologySeq: number;
};

export type SeekIndexV1 = {
  version: 1;
  bucketUs: number;
  durationUs: number;
  eventCount: number;
  buckets: SeekBucket[];
};

export const DEFAULT_SEEK_BUCKET_US = 1_000_000;

export function buildSeekIndex(
  events: readonly SessionEvent[],
  byteOffsets: readonly number[] | null,
  bucketUs: number = DEFAULT_SEEK_BUCKET_US,
): SeekIndexV1 {
  const durationUs = events.length > 0 ? (events[events.length - 1]?.tUs ?? 0) : 0;
  const buckets: SeekBucket[] = [];
  const checkpoints: Record<string, string> = {};
  let topologySeq = -1;
  let eventIndex = 0;

  const bucketCount = Math.floor(durationUs / bucketUs) + 1;
  for (let b = 0; b < bucketCount; b++) {
    const bucketStart = b * bucketUs;
    while (eventIndex < events.length && (events[eventIndex]?.tUs ?? 0) <= bucketStart) {
      const event = events[eventIndex] as SessionEvent;
      if (event.type === "document.enrolled") {
        checkpoints[event.payload.descriptor.documentId] =
          event.payload.descriptor.initialCheckpointId;
      } else if (event.type === "document.checkpoint") {
        checkpoints[event.payload.documentId] = event.payload.checkpointId;
      } else if (event.type === "topology.snapshot") {
        topologySeq = event.seq;
      }
      eventIndex += 1;
    }
    buckets.push({
      tUs: bucketStart,
      upToSeq: eventIndex - 1,
      nextByteOffset:
        byteOffsets && eventIndex < byteOffsets.length ? (byteOffsets[eventIndex] ?? null) : null,
      checkpoints: { ...checkpoints },
      topologySeq,
    });
  }

  return {
    version: 1,
    bucketUs,
    durationUs,
    eventCount: events.length,
    buckets,
  };
}

/** Bucket lookup for a target session time. */
export function bucketForTime(index: SeekIndexV1, tUs: number): SeekBucket | null {
  if (index.buckets.length === 0) {
    return null;
  }
  const clamped = Math.max(0, Math.min(index.durationUs, tUs));
  const b = Math.min(index.buckets.length - 1, Math.floor(clamped / index.bucketUs));
  return index.buckets[b] ?? null;
}
