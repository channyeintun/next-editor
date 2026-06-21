import type { eventWithTime } from "rrweb";
// The rrweb record-capable UMD bundle, imported as raw text so it can be inlined
// verbatim into the WebContainer-served page (it must run inside the preview
// realm, not the host). Sets `window.rrweb` when executed as a classic script.
// Vendored because rrweb's `exports` field does not expose the UMD subpath; see
// ./vendor/README.md.
import rrwebRecorderBundle from "./vendor/rrweb.umd.min.cjs?raw";
import type {
  PreviewDomPatchBatch,
  PreviewInitialDocument,
  PreviewRecordedEvent,
} from "../../types/slides";

// Host<->preview channel names. Kept identical to the legacy runtime channel so
// the message bridge wiring does not have to change, only the payload shape.
export const RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_INITIAL_DOCUMENT";
export const RUNTIME_PATCH_BATCH_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_PATCH_BATCH";

// Format version carried on every rrweb-format preview record. Bumped from the
// legacy custom-op format (1) so records are unambiguously rrweb (2).
export const PREVIEW_RRWEB_FORMAT_VERSION = 2;

// rrweb EventType numeric values we branch on while recording. Hardcoded so the
// injected script does not need to import rrweb's enum.
const RRWEB_EVENT_TYPE_FULL_SNAPSHOT = 2;
const RRWEB_EVENT_TYPE_INCREMENTAL_SNAPSHOT = 3;
const RRWEB_EVENT_TYPE_META = 4;
// IncrementalSource.Mutation — a DOM add/remove/attribute/text change.
const RRWEB_INCREMENTAL_SOURCE_MUTATION = 0;

// Corrective-checkpoint timing. rrweb's incremental mutation capture is lossy in
// real browsers for some swap patterns (notably htmx innerHTML swaps, where a
// removed node is occasionally never emitted), so replay accumulates stale nodes
// — e.g. each "get server time" click stacks another line instead of replacing.
// To self-heal, the recorder takes a fresh FullSnapshot once mutations settle:
// replay treats it as a checkpoint and rebuilds from it, discarding any drift
// from dropped incremental events. QUIET_MS waits for a burst (a swap) to finish;
// MAX_MS bounds drift during sustained, never-quiet activity.
const RRWEB_CHECKPOINT_QUIET_MS = 600;
const RRWEB_CHECKPOINT_MAX_MS = 4000;

interface CreateRrwebPreviewRecorderScriptOptions {
  setupMarker: string;
}

// Builds the JS injected into the runtime preview page: the rrweb UMD bundle
// followed by a wiring IIFE that records the live DOM (+ inner scroll/input/mouse)
// and posts events to the host. The first Meta+FullSnapshot pair is posted as the
// initial document; every later event is batched per animation frame and posted
// as a patch batch. Replay reassembles the full ordered event stream from both.
export function createRrwebPreviewRecorderScript({
  setupMarker,
}: CreateRrwebPreviewRecorderScriptOptions): string {
  const wiring = `
    (function() {
      var marker = ${JSON.stringify(setupMarker)};
      if (window[marker]) return;
      if (!window.rrweb || typeof window.rrweb.record !== 'function') return;
      window[marker] = true;

      var initialDocumentMessageType = ${JSON.stringify(RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE)};
      var patchBatchMessageType = ${JSON.stringify(RUNTIME_PATCH_BATCH_MESSAGE_TYPE)};
      var version = ${JSON.stringify(PREVIEW_RRWEB_FORMAT_VERSION)};
      var fullSnapshotType = ${JSON.stringify(RRWEB_EVENT_TYPE_FULL_SNAPSHOT)};
      var incrementalType = ${JSON.stringify(RRWEB_EVENT_TYPE_INCREMENTAL_SNAPSHOT)};
      var mutationSource = ${JSON.stringify(RRWEB_INCREMENTAL_SOURCE_MUTATION)};
      var metaType = ${JSON.stringify(RRWEB_EVENT_TYPE_META)};
      var checkpointQuietMs = ${JSON.stringify(RRWEB_CHECKPOINT_QUIET_MS)};
      var checkpointMaxMs = ${JSON.stringify(RRWEB_CHECKPOINT_MAX_MS)};
      var source = 'runtime-preview';
      var documentId = 'rrweb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

      var pendingEvents = [];
      var frame = 0;
      var sentInitial = false;
      var pendingMeta = null;
      var checkpointTimer = 0;
      var lastCheckpointAt = 0;

      function getRoute() {
        return (window.location.pathname || '/') + (window.location.search || '') + (window.location.hash || '');
      }

      function getMessageTime() {
        try { return Math.max(0, Math.round(performance.now())); } catch (e) { return Date.now(); }
      }

      function post(type, payload) {
        try { window.parent.postMessage({ type: type, payload: payload }, '*'); } catch (e) {}
      }

      function flush() {
        frame = 0;
        if (!pendingEvents.length) return;
        var events = pendingEvents;
        pendingEvents = [];
        post(patchBatchMessageType, {
          version: version,
          time: getMessageTime(),
          source: source,
          documentId: documentId,
          route: getRoute(),
          events: events,
        });
      }

      function schedule() {
        if (frame) return;
        frame = window.requestAnimationFrame(flush);
      }

      function takeCheckpoint() {
        checkpointTimer = 0;
        lastCheckpointAt = getMessageTime();
        // Emits a fresh Meta + FullSnapshot, which flow through emit() (below) into
        // the patch stream; replay rebuilds from it, healing any dropped mutations.
        try { window.rrweb.takeFullSnapshot(); } catch (e) {}
      }

      // Arm a corrective checkpoint after a DOM mutation. Coalesces a burst (one
      // swap) into a single snapshot once it goes quiet, but never lets drift live
      // longer than checkpointMaxMs during sustained, never-quiet activity.
      function scheduleCheckpoint() {
        if (!sentInitial) return;
        if (lastCheckpointAt && getMessageTime() - lastCheckpointAt >= checkpointMaxMs) {
          if (checkpointTimer) { window.clearTimeout(checkpointTimer); }
          takeCheckpoint();
          return;
        }
        if (checkpointTimer) { window.clearTimeout(checkpointTimer); }
        checkpointTimer = window.setTimeout(takeCheckpoint, checkpointQuietMs);
      }

      function emit(event) {
        // Hold the Meta event so it can be bundled with the first FullSnapshot as
        // the initial document.
        if (event.type === metaType && !sentInitial) {
          pendingMeta = event;
          return;
        }

        if (event.type === fullSnapshotType && !sentInitial) {
          sentInitial = true;
          lastCheckpointAt = getMessageTime();
          var seedEvents = pendingMeta ? [pendingMeta, event] : [event];
          pendingMeta = null;
          post(initialDocumentMessageType, {
            version: version,
            time: getMessageTime(),
            documentId: documentId,
            route: getRoute(),
            events: seedEvents,
          });
          return;
        }

        pendingEvents.push(event);
        schedule();

        // DOM mutations are the lossy ones; a settled checkpoint after them lets
        // replay self-correct. Checkpoint snapshots themselves are Meta/FullSnapshot
        // events, so they never re-arm this.
        if (event.type === incrementalType && event.data && event.data.source === mutationSource) {
          scheduleCheckpoint();
        }
      }

      function startRecording() {
        try {
          window.rrweb.record({
            emit: emit,
            recordCanvas: false,
            collectFonts: false,
            inlineStylesheet: true,
            // Replay is visual-only; do not capture input values that may be secret.
            maskAllInputs: false,
            // Scripts never execute in replay and our own injected scripts must not
            // bloat the snapshot; comments are noise. Drop both.
            slimDOMOptions: { script: true, comment: true },
          });
        } catch (e) {}
      }

      // Snapshot a fully-parsed document so the FullSnapshot is complete; later
      // mutations stream as incremental events.
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startRecording, { once: true });
      } else {
        startRecording();
      }
    })();
  `;

  return `${rrwebRecorderBundle}\n${wiring}`;
}

// Reassembles the full, time-ordered rrweb event stream the `Replayer` consumes
// from the recorded segments.
//
// Each rrweb event carries the preview iframe's raw `Date.now()` timestamp, but
// the playback timeline runs on the recording clock (`Date.now() - startedAt`,
// where `startedAt` is the audio-anchored origin — typically ~seconds after the
// preview snapshot, due to mic warmup). Replaying on the raw clock makes preview
// content lag the audio/editor by that fixed offset. So we rebase every event
// onto the recording clock using its segment's recording-relative `time` as the
// anchor, keeping only the sub-frame offset within a segment. The replay offset
// (`currentTime - initialDocuments[0].time`) is then on the same clock, so preview
// content lands at the recording time it actually occurred.
export function buildRrwebReplayEvents(
  initialDocuments: PreviewInitialDocument[],
  patchBatches: PreviewDomPatchBatch[],
): eventWithTime[] {
  const events: PreviewRecordedEvent[] = [];

  const collect = (segments: { time: number; events?: PreviewRecordedEvent[] }[]) => {
    for (const segment of segments) {
      const segmentEvents = segment.events;
      if (!segmentEvents || segmentEvents.length === 0) {
        continue;
      }

      // Anchor the segment's first event at its recorded time; events within a
      // segment span one animation frame, so their relative order is preserved.
      const origin = segmentEvents[0].timestamp;
      for (const event of segmentEvents) {
        events.push({ ...event, timestamp: segment.time + (event.timestamp - origin) });
      }
    }
  };

  collect(initialDocuments);
  collect(patchBatches);

  events.sort((left, right) => left.timestamp - right.timestamp);

  return events as unknown as eventWithTime[];
}

// True when a recording's preview segments carry the rrweb format (vs the legacy
// custom-op format, which has no `events`).
export function hasRrwebPreviewEvents(
  initialDocuments: PreviewInitialDocument[] | undefined,
  patchBatches: PreviewDomPatchBatch[] | undefined,
): boolean {
  return Boolean(
    initialDocuments?.some((document) => document.events?.length) ||
    patchBatches?.some((batch) => batch.events?.length),
  );
}
