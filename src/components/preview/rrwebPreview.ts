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
// Instead we snapshot only when drift is actually present. Alongside rrweb's live
// mirror, the recorder maintains a lightweight topology of the structural events
// it actually emitted. A dropped `remove` is then visible whether rrweb retained a
// detached mirror node or already deleted the node internally (the latter is what
// issue.ne demonstrates). A corrective FullSnapshot resets both views to the live
// DOM. On a well-behaved page they stay equal, so no redundant full frame is
// recorded. The throttle caps how often the comparison/snapshot runs on a
// continuously-mutating page, bounding worst-case drift to one interval. The
// comparison runs on a microtask when unthrottled so the corrective snapshot lands
// in the same animation-frame batch as the mutation.
const RRWEB_CHECKPOINT_THROTTLE_MS = 200;

// Scroll events are throttled at the rrweb source (one sample per this many ms,
// applied as a discrete jump on replay — no interpolation). The cursor-overlay
// pipeline (mouseTrackingActor.ts) samples/tweens roughly every animation frame,
// so a coarser scroll cadence leaves a window where the overlay cursor has moved
// on to a new screen position while the replayed DOM is still scrolled to the
// previous sample, making the cursor appear to point at the wrong content. Kept
// close to one frame so the residual gap is imperceptible; scroll events are a
// tiny {id,x,y} payload, so this is cheap relative to mutation/snapshot data.
const RRWEB_SCROLL_SAMPLING_MS = 33;

// A minimal structural view of rrweb's recording mirror. `record.mirror` (a
// public rrweb API) implements this; we only need to walk its id↔node map.
export interface RrwebRecordingMirror {
  getIds(): number[];
  getNode(id: number): Node | null;
}

export interface RrwebCapturedDomModel {
  resetFromSnapshot(node: unknown): void;
  applyMutation(data: unknown): void;
  collectMirrorDriftNodeIds(mirror: RrwebRecordingMirror, doc: Document): number[];
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

// Tracks the topology described by the events that actually leave the recorder.
// rrweb can update its mirror correctly while omitting a remove from the emitted
// Mutation event. In that failure mode a detached-node scan cannot help because
// the stale node is already absent from the mirror, although replay will retain
// it. Comparing this emitted-event model with the mirror catches both forms of
// drift without taking full-document checkpoints after every normal mutation.
//
// This function is self-contained because its source is inlined into the preview
// realm. Keep its implementation compatible with a classic browser script.
export function createRrwebCapturedDomModel(): RrwebCapturedDomModel {
  var capturedIds = new Set<number>();
  var childIdsByParent = new Map<number, Set<number>>();
  var parentIdByNode = new Map<number, number>();

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function getNodeId(value: unknown): number | null {
    if (!isRecord(value) || typeof value.id !== "number" || value.id < 0) {
      return null;
    }
    return value.id;
  }

  function detachFromParent(id: number): void {
    var parentId = parentIdByNode.get(id);
    if (parentId === undefined) return;
    var siblings = childIdsByParent.get(parentId);
    if (siblings) {
      siblings.delete(id);
      if (siblings.size === 0) childIdsByParent.delete(parentId);
    }
    parentIdByNode.delete(id);
  }

  function removeNodeTree(id: number): void {
    var children = childIdsByParent.get(id);
    if (children) {
      Array.from(children).forEach(removeNodeTree);
      childIdsByParent.delete(id);
    }
    detachFromParent(id);
    capturedIds.delete(id);
  }

  function registerNode(node: unknown, parentId?: number): void {
    var id = getNodeId(node);
    if (id === null || !isRecord(node)) return;

    detachFromParent(id);
    capturedIds.add(id);

    if (typeof parentId === "number" && parentId >= 0) {
      var siblings = childIdsByParent.get(parentId);
      if (!siblings) {
        siblings = new Set<number>();
        childIdsByParent.set(parentId, siblings);
      }
      siblings.add(id);
      parentIdByNode.set(id, parentId);
    }

    if (Array.isArray(node.childNodes)) {
      node.childNodes.forEach(function (child) {
        registerNode(child, id);
      });
    }
  }

  return {
    resetFromSnapshot: function (node: unknown): void {
      capturedIds = new Set<number>();
      childIdsByParent = new Map<number, Set<number>>();
      parentIdByNode = new Map<number, number>();
      registerNode(node);
    },
    applyMutation: function (data: unknown): void {
      if (!isRecord(data) || data.source !== 0) return;

      if (Array.isArray(data.removes)) {
        data.removes.forEach(function (remove) {
          var id = getNodeId(remove);
          if (id !== null) removeNodeTree(id);
        });
      }

      if (Array.isArray(data.adds)) {
        data.adds.forEach(function (add) {
          if (!isRecord(add)) return;
          registerNode(add.node, typeof add.parentId === "number" ? add.parentId : undefined);
        });
      }
    },
    collectMirrorDriftNodeIds: function (mirror: RrwebRecordingMirror, doc: Document): number[] {
      var drifted = new Set<number>();
      var mirrorIds = new Set<number>();

      mirror.getIds().forEach(function (id) {
        if (typeof id !== "number" || id < 0) return;
        mirrorIds.add(id);
        if (!capturedIds.has(id)) drifted.add(id);

        var node = mirror.getNode(id);
        if (node && node.nodeType !== 9 && node !== doc && !node.isConnected) {
          drifted.add(id);
        }
      });

      capturedIds.forEach(function (id) {
        if (!mirrorIds.has(id)) drifted.add(id);
      });

      return Array.from(drifted);
    },
  };
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
      // Set while answering a host RUNTIME_TAKE_SNAPSHOT request: diverts the
      // resulting Meta+FullSnapshot pair out of the patch stream and posts it as
      // a refresh:true initial document instead. rrweb emits synchronously inside
      // takeFullSnapshot(), so the flag never leaks onto unrelated events.
      var hostSnapshotRequested = false;
      var pendingRefreshMeta = null;

      // Independently model the topology described by emitted events. This catches
      // a remove omitted from the stream even if rrweb already removed the node
      // from its own mirror (the failure demonstrated by issue.ne).
      var createRrwebCapturedDomModel = ${createRrwebCapturedDomModel.toString()};
      var capturedDomModel = createRrwebCapturedDomModel();

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
          // Only escalate when the topology replay will build differs from rrweb's
          // current mirror/live DOM. On a well-behaved page this remains empty.
          if (capturedDomModel.collectMirrorDriftNodeIds(mirror, document).length === 0) return;
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
        // Maintain the model from exactly the structural data sent to replay.
        // FullSnapshots are authoritative and reset the model after checkpoints.
        if (event.type === fullSnapshotType && event.data && event.data.node) {
          capturedDomModel.resetFromSnapshot(event.data.node);
        } else if (event.type === incrementalType && event.data && event.data.source === mutationSource) {
          capturedDomModel.applyMutation(event.data);
        }

        // Host-requested snapshot (recording start): bundle the Meta+FullSnapshot
        // pair into a refresh:true initial document instead of the patch stream,
        // so the recording seeds replay from the live recording-start state
        // without also storing the stale page-load snapshot.
        if (hostSnapshotRequested) {
          if (event.type === metaType) {
            pendingRefreshMeta = event;
            return;
          }
          if (event.type === fullSnapshotType) {
            var refreshEvents = pendingRefreshMeta ? [pendingRefreshMeta, event] : [event];
            pendingRefreshMeta = null;
            hostSnapshotRequested = false;
            post(initialDocumentMessageType, {
              version: version,
              time: getMessageTime(),
              documentId: documentId,
              route: getRoute(),
              refresh: true,
              events: refreshEvents,
            });
            return;
          }
        }

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

      // Host-requested snapshot (sent when a recording starts): re-serialize the
      // CURRENT document — including element/document scroll offsets — and post
      // it back as a refresh:true initial document (see emit above) so the
      // recording opens from the true recording-start state. Emission is
      // synchronous inside takeFullSnapshot, so the flag is scoped to this call;
      // the trailing reset covers the throw path.
      window.addEventListener('message', function(event) {
        var data = event && event.data;
        if (!data || data.type !== ${JSON.stringify(RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE)}) return;
        if (!sentInitial) return;
        try {
          // Pre-recording mutations are already represented by this fresh baseline.
          // Do not flush them afterwards as incrementals and add the same nodes twice.
          if (frame) window.cancelAnimationFrame(frame);
          frame = 0;
          pendingEvents = [];
          lastCheckpointAt = getMessageTime();
          hostSnapshotRequested = true;
          window.rrweb.takeFullSnapshot();
        } catch (e) {}
        hostSnapshotRequested = false;
        pendingRefreshMeta = null;
      });

      function startRecording() {
        try {
          var stop = window.rrweb.record({
            emit: emit,
            recordCanvas: false,
            collectFonts: false,
            // Keep pointer positions: rrweb's replayer derives in-page hover (and
            // similar) styling from them, so replay fidelity needs the stream even
            // though the fake cursor itself is hidden (the host draws its own
            // cursor overlay). Scroll stays close to one frame (see
            // RRWEB_SCROLL_SAMPLING_MS) so it doesn't lag the cursor overlay's
            // own cadence; media only needs to look right, not be sample-perfect.
            sampling: { mousemove: 100, scroll: ${JSON.stringify(RRWEB_SCROLL_SAMPLING_MS)}, media: 800 },
            inlineStylesheet: true,
            // Bake image pixels into the snapshot (rr_dataURL). The preview page
            // is served from an ephemeral per-boot WebContainer origin, so any
            // project-served image recorded as a URL is unreachable in replay
            // (the host no longer resolves) — stable external URLs still work
            // either way. Same-origin loaded images inline synchronously during
            // serialization; an image still loading when serialized inlines via
            // a load listener, which only reaches storage if it fires before the
            // batch flushes (missed ones keep their URL — the pre-existing
            // behavior, not a regression).
            inlineImages: true,
            // Capture real input values: the preview replays the author's own demo
            // content, and typed text must stay visible in replay.
            maskAllInputs: false,
            // Scripts never execute in replay and our own injected scripts must not
            // bloat the snapshot; comments are noise. Drop both.
            slimDOMOptions: { script: true, comment: true },
          });
          // Expose the stop handle on the setup marker (still truthy, so the
          // re-entry guard holds) so tests and teardown paths can detach the
          // recorder's observers.
          if (stop) window[marker] = { stop: stop };
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
// content lag the audio/editor by that fixed offset.
//
// Rebase all events from one global rrweb timestamp origin instead of anchoring
// each batch independently. Batch `time` is when the host flushed the frame, which
// can be a little after the DOM event itself; preserving the raw rrweb deltas keeps
// replay aligned to when the preview actually changed.
export function buildRrwebReplayEvents(
  initialDocuments: PreviewInitialDocument[],
  patchBatches: PreviewDomPatchBatch[],
): eventWithTime[] {
  const segments = [...initialDocuments, ...patchBatches];
  const originSegment = segments.find((segment) => segment.events?.length);
  const originEvent = originSegment?.events?.[0];

  if (!originSegment || !originEvent) {
    return [];
  }

  let maxOffset = -Infinity;
  for (const segment of segments) {
    if (!segment.events?.length) {
      continue;
    }
    const offset = segment.events[0].timestamp - segment.time;
    if (offset > maxOffset) {
      maxOffset = offset;
    }
  }

  // Fallback if no valid events found
  if (maxOffset === -Infinity) {
    return [];
  }

  const events: PreviewRecordedEvent[] = [];

  for (const segment of segments) {
    if (!segment.events?.length) {
      continue;
    }
    for (const event of segment.events) {
      events.push({
        ...event,
        timestamp: Math.max(0, event.timestamp - maxOffset),
      });
    }
  }

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
