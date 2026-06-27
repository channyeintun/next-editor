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
// Host → preview: force a fresh rrweb FullSnapshot now. Used when a frame becomes
// the active one again (e.g. switching back from the API client) so replay rebuilds
// this surface at that point in the timeline rather than keeping the other frame's
// last snapshot on screen.
export const RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_TAKE_SNAPSHOT";

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

// Corrective-checkpoint throttle. rrweb's incremental mutation capture is lossy in
// real browsers for some swap patterns (notably htmx innerHTML swaps, where a
// removed node is occasionally never emitted), so replay accumulates stale nodes
// — e.g. each "get server time" click stacks another line instead of replacing.
//
// A FullSnapshot heals this (replay rebuilds from it, discarding drift), but a
// snapshot re-serializes the WHOLE DOM (inlined stylesheets included). Taking one
// after every mutation — as an earlier version did — balloons recordings to
// hundreds of MB on continuously-mutating pages, where the snapshots are also
// near-identical and almost always redundant.
//
// Instead we snapshot only when drift is actually present. rrweb keeps a mirror
// (`record.mirror`) of the DOM it has captured; when it drops a `remove`, the
// mirror retains a node that is no longer connected to the live document. After a
// mutation we cheaply scan the mirror for such detached nodes and take a
// FullSnapshot only if any exist (resetting the mirror first, so the snapshot
// re-establishes it from the live DOM and the dropped node does not linger and
// retrigger snapshots forever). On a well-behaved page this never fires, so the
// recording carries zero redundant full frames; on the buggy htmx case it fires
// exactly when (and only when) a remove was dropped. The throttle caps how often
// the scan/snapshot runs on continuously-mutating pages, bounding worst-case drift
// to one interval. The scan runs on a microtask so a corrective snapshot lands in
// the SAME animation-frame batch as the swap that drifted (no visible stale frame).
const RRWEB_CHECKPOINT_THROTTLE_MS = 200;

// A minimal structural view of rrweb's recording mirror. `record.mirror` (a
// public rrweb API) implements this; we only need to walk its id↔node map.
export interface RrwebRecordingMirror {
  getIds(): number[];
  getNode(id: number): Node | null;
}

// Finds the mirror ids whose nodes are no longer connected to the recorded
// document — nodes rrweb still believes are present but that have actually been
// removed from the live DOM. A non-empty result means rrweb dropped a `remove`
// mutation (its lossy real-browser capture bug); replay would otherwise
// accumulate these stale nodes (the htmx "stacking" bug), so a corrective
// FullSnapshot is warranted. An empty result means the mirror matches the live
// DOM, so no checkpoint — and no redundant full frame — needs to be recorded.
//
// Written in plain ES5 (var / function / for) with no module-scope references so
// it can be inlined verbatim, via .toString(), into the injected recorder script
// that runs inside the preview realm. Keep it self-contained.
export function collectStaleMirrorNodeIds(mirror: RrwebRecordingMirror, doc: Document): number[] {
  var stale: number[] = [];
  var ids = mirror.getIds();
  for (var index = 0; index < ids.length; index += 1) {
    var id = ids[index];
    var node = mirror.getNode(id);
    // Skip the document node itself (nodeType 9, always "connected"); any other
    // tracked node detached from the document tree is drift from a dropped remove.
    if (node && node.nodeType !== 9 && node !== doc && !node.isConnected) {
      stale.push(id);
    }
  }
  return stale;
}

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
      var takeSnapshotMessageType = ${JSON.stringify(RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE)};
      var version = ${JSON.stringify(PREVIEW_RRWEB_FORMAT_VERSION)};
      var fullSnapshotType = ${JSON.stringify(RRWEB_EVENT_TYPE_FULL_SNAPSHOT)};
      var incrementalType = ${JSON.stringify(RRWEB_EVENT_TYPE_INCREMENTAL_SNAPSHOT)};
      var mutationSource = ${JSON.stringify(RRWEB_INCREMENTAL_SOURCE_MUTATION)};
      var metaType = ${JSON.stringify(RRWEB_EVENT_TYPE_META)};
      var checkpointThrottleMs = ${JSON.stringify(RRWEB_CHECKPOINT_THROTTLE_MS)};
      var source = 'runtime-preview';
      var documentId = 'rrweb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

      var pendingEvents = [];
      var frame = 0;
      var sentInitial = false;
      var pendingMeta = null;
      var checkpointScheduled = false;
      var lastCheckpointAt = 0;

      // Inlined from collectStaleMirrorNodeIds() in rrwebPreview.ts (single source
      // of truth). Detects nodes rrweb's mirror still tracks but that have been
      // removed from the live DOM — the signal that a corrective snapshot is needed.
      var collectStaleMirrorNodeIds = ${collectStaleMirrorNodeIds.toString()};

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

      function maybeCheckpoint() {
        checkpointScheduled = false;
        lastCheckpointAt = getMessageTime();
        try {
          var mirror = window.rrweb.record && window.rrweb.record.mirror;
          if (!mirror) return;
          // Only escalate to a full snapshot when rrweb's mirror has actually
          // drifted from the live DOM (a dropped remove). On well-behaved pages
          // this is empty every time, so no redundant full frame is recorded.
          if (collectStaleMirrorNodeIds(mirror, document).length === 0) return;
          // Reset the mirror first so the snapshot fully re-establishes it from the
          // live DOM. takeFullSnapshot reuses existing ids and never prunes the
          // dropped node, so without this the drift lingers in the mirror and would
          // retrigger a snapshot on every later mutation (a snapshot storm).
          if (typeof mirror.reset === 'function') mirror.reset();
          // Emits a fresh Meta + FullSnapshot, which flow through emit() (below)
          // into the patch stream; replay rebuilds from it, healing the drift.
          window.rrweb.takeFullSnapshot();
        } catch (e) {}
      }

      // Arm a drift check after a DOM mutation. Fired on a microtask so that, if a
      // corrective snapshot is needed, it lands in the SAME animation-frame batch as
      // the mutation that triggered it: on replay the stale add and the corrective
      // rebuild share a timestamp, so a dropped remove is overwritten in the same
      // frame (no visible flash). The throttle caps how often the scan/snapshot runs
      // on continuously-mutating pages (falling back to a trailing run), which also
      // bounds worst-case drift to one interval.
      function scheduleCheckpoint() {
        if (!sentInitial || checkpointScheduled) return;
        checkpointScheduled = true;
        var sinceLast = getMessageTime() - lastCheckpointAt;
        if (sinceLast < checkpointThrottleMs) {
          window.setTimeout(maybeCheckpoint, checkpointThrottleMs - sinceLast);
          return;
        }
        var microtask = typeof queueMicrotask === 'function'
          ? queueMicrotask
          : function (cb) { Promise.resolve().then(cb); };
        microtask(maybeCheckpoint);
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

        // DOM mutations are the lossy ones; a drift check after them lets replay
        // self-correct when rrweb dropped a remove. Checkpoint snapshots themselves
        // are Meta/FullSnapshot events, so they never re-arm this.
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

      // Host can force a fresh FullSnapshot (e.g. when this frame becomes active
      // again), which flows through emit() into the patch stream so replay rebuilds
      // this surface at that timeline point.
      window.addEventListener('message', function(event) {
        if (!event.data || event.data.type !== takeSnapshotMessageType) return;
        try {
          if (sentInitial && window.rrweb && typeof window.rrweb.takeFullSnapshot === 'function') {
            window.rrweb.takeFullSnapshot();
          }
        } catch (e) {}
      });

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
