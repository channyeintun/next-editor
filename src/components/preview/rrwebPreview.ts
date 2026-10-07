import type { eventWithTime } from "@rrweb/types";
import type {
  PreviewDomPatchBatch,
  PreviewInitialDocument,
  PreviewRecordedEvent,
} from "../../types/slides";

// Host<->preview channel names. Kept identical to the legacy runtime channel so
// the message bridge wiring does not have to change, only the payload shape.
export const RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_INITIAL_DOCUMENT";
export const RUNTIME_PATCH_BATCH_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_PATCH_BATCH";
// Host -> preview: request a fresh FullSnapshot of the CURRENT document. Sent
// when a recording starts. The recorder answers by re-serializing the live DOM
// and posting the Meta+FullSnapshot pair back as an initial document flagged
// `refresh: true` — that response (not the stale page-load snapshot the host
// once cached) is what seeds the recording, so replay opens from the true
// recording-start state without storing a superseded full snapshot. If nothing
// answers (preview hidden, runtime rebooting, recorder absent), nothing is
// recorded up front: the live iframe's own initial document seeds replay when
// it (re)loads.
export const RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_TAKE_SNAPSHOT";

// Format version carried on every rrweb-format preview record. Bumped from the
// legacy custom-op format (1) so records are unambiguously rrweb (2).
export const PREVIEW_RRWEB_FORMAT_VERSION = 2;

// Reassembles the full, time-ordered rrweb event stream the `Replayer` consumes
// from the recorded segments.
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
export function buildRrwebReplayEvents(
  initialDocuments: PreviewInitialDocument[],
  patchBatches: PreviewDomPatchBatch[],
): eventWithTime[] {
  const segments = [...initialDocuments, ...patchBatches].filter(
    (segment) => segment.events?.length,
  );
  if (segments.length === 0) {
    return [];
  }

  let lead = -Infinity;
  for (const segment of segments) {
    lead = Math.max(lead, segment.events![0].timestamp - segment.time);
  }

  // Copies: rrweb's Replayer writes `delay` onto the events it is given, and
  // these belong to the loaded recording.
  const events: PreviewRecordedEvent[] = segments.flatMap((segment) =>
    segment.events!.map((event) => ({
      ...event,
      timestamp: Math.max(0, event.timestamp - lead),
    })),
  );
  events.sort((left, right) => left.timestamp - right.timestamp);

  return events as unknown as eventWithTime[];
}

// True when a recording's preview can be replayed by rrweb: it has a seed (an
// initial document carrying Meta + FullSnapshot events). A seed alone is a
// complete stream; patch batches without one are not replayable, which is also
// the machine's rule for calling the replay applier. Legacy custom-op records
// have no `events`.
export function hasRrwebPreviewSeed(
  initialDocuments: PreviewInitialDocument[] | undefined,
): boolean {
  return Boolean(initialDocuments?.some((document) => document.events?.length));
}
