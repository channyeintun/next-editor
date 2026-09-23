import type { RecordingClusterMeta } from "../types";
import { isKeyframe, type DeltaFrame } from "./deltaTypes";

// ============================================================================
// Recording clusters: the keyframe-led slices of a take's timeline.
//
// Capture builds a take's clusters from its frames, and the SCR3 codec derives the
// same clusters for a recording that arrives without them and writes one frame
// segment per slice, so both use these definitions.
// ============================================================================

/** Splits frames into runs that each start at a keyframe (the first run starts at frame 0). */
export function splitFramesAtKeyframes(frames: DeltaFrame[]): DeltaFrame[][] {
  const runs: DeltaFrame[][] = [];
  let index = 0;
  while (index < frames.length) {
    const start = index;
    index += 1;
    while (index < frames.length && !isKeyframe(frames[index])) {
      index += 1;
    }
    runs.push(frames.slice(start, index));
  }
  return runs;
}

/**
 * One cluster per keyframe-led run of frames. A cluster ends where the next begins, and
 * the last one at the take's duration; a take without frames is one cluster spanning its
 * duration, or none when that is 0.
 */
export function buildRecordingClusters(
  frames: DeltaFrame[],
  durationMs: number,
): RecordingClusterMeta[] {
  if (frames.length === 0) {
    return durationMs > 0
      ? [{ index: 0, startTimeMs: 0, endTimeMs: durationMs, containsKeyframe: false }]
      : [];
  }

  const runs = splitFramesAtKeyframes(frames);
  const clusters = runs.map((run, index): RecordingClusterMeta => {
    const startTimeMs = run[0].timestamp;
    const nextStartTimeMs = index + 1 < runs.length ? runs[index + 1][0].timestamp : durationMs;
    const lastFrameTimeMs = run[run.length - 1].timestamp;
    return {
      index,
      startTimeMs,
      endTimeMs: Math.max(startTimeMs, nextStartTimeMs, lastFrameTimeMs),
      containsKeyframe: isKeyframe(run[0]),
    };
  });

  const lastCluster = clusters[clusters.length - 1];
  lastCluster.endTimeMs = Math.max(lastCluster.startTimeMs, lastCluster.endTimeMs, durationMs);
  return clusters;
}

/**
 * The index of the cluster `timeMs` falls in: the last one starting at or before it
 * (clusters ordered by start time), or the first cluster for a time before them all.
 */
export function resolveClusterIndexForTime(
  clusters: ReadonlyArray<RecordingClusterMeta>,
  timeMs: number,
): number {
  if (clusters.length === 0) {
    return 0;
  }

  for (let index = clusters.length - 1; index >= 0; index -= 1) {
    if (timeMs >= clusters[index].startTimeMs) {
      return clusters[index].index;
    }
  }

  return clusters[0].index;
}
