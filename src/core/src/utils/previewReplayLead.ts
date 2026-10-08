import type { PreviewDomPatchBatch, PreviewInitialDocument } from "../preview";

// ============================================================================
// The preview clock's lead over the recording clock.
//
// Each rrweb event carries the preview iframe's raw `Date.now()` timestamp, but
// the playback timeline runs on the recording clock (`performance.now() -
// startedAtPerf`, whose origin is anchored to the audio start — typically
// seconds after the preview snapshot, due to mic warmup). Replaying on the raw
// clock makes preview content lag the audio/editor by that fixed offset.
//
// A segment's `time` is when the host received it, on the recording clock, so
// `events[0].timestamp - time` is the preview clock's lead over the recording
// clock minus that segment's delivery delay. The largest lead belongs to the
// segment that reached the host fastest; rebasing every event by it keeps each
// one at (never after) its true recording time and preserves the raw rrweb
// deltas between events, so replay follows when the preview actually changed.
//
// Replay (buildRrwebReplayEvents) and cutting a recording (applyRecordingEdit)
// both rebase by this one rule, so an edited preview stays in step with the
// audio.
// ============================================================================

/**
 * The lead every rrweb event is rebased by: the largest over the segments that
 * carry events, or -Infinity when none does.
 */
export function getRrwebReplayLead(
  initialDocuments: readonly PreviewInitialDocument[],
  patchBatches: readonly PreviewDomPatchBatch[],
): number {
  let lead = -Infinity;
  for (const segment of [...initialDocuments, ...patchBatches]) {
    if (segment.events?.length) {
      lead = Math.max(lead, segment.events[0].timestamp - segment.time);
    }
  }
  return lead;
}
