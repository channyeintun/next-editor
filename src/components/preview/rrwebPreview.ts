import type { eventWithTime } from "@rrweb/types";
import { getRrwebReplayLead } from "../../core/src/utils/previewReplayLead";
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
// from the recorded segments, every event rebased from the preview iframe's raw
// clock onto the recording clock by the preview clock's lead (see
// getRrwebReplayLead, which explains the rule).
//
// `lead` overrides that rebase, so events streamed in after a build can be
// rebased exactly as the build's were.
export function buildRrwebReplayEvents(
  initialDocuments: PreviewInitialDocument[],
  patchBatches: PreviewDomPatchBatch[],
  lead = getRrwebReplayLead(initialDocuments, patchBatches),
): eventWithTime[] {
  const segments = [...initialDocuments, ...patchBatches].filter(
    (segment) => segment.events?.length,
  );
  if (segments.length === 0) {
    return [];
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
