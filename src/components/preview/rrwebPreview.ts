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
const RRWEB_EVENT_TYPE_META = 4;

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
      var metaType = ${JSON.stringify(RRWEB_EVENT_TYPE_META)};
      var source = 'runtime-preview';
      var documentId = 'rrweb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

      var pendingEvents = [];
      var frame = 0;
      var sentInitial = false;
      var pendingMeta = null;

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

      function emit(event) {
        // Hold the Meta event so it can be bundled with the first FullSnapshot as
        // the initial document.
        if (event.type === metaType && !sentInitial) {
          pendingMeta = event;
          return;
        }

        if (event.type === fullSnapshotType && !sentInitial) {
          sentInitial = true;
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
      }

      try {
        window.rrweb.record({
          emit: emit,
          recordCanvas: false,
          collectFonts: false,
          inlineStylesheet: true,
          // Replay is visual-only; do not capture input values that may be secret.
          maskAllInputs: false,
        });
      } catch (e) {}
    })();
  `;

  return `${rrwebRecorderBundle}\n${wiring}`;
}

// Reassembles the full, time-ordered rrweb event stream that the `Replayer`
// consumes from the recorded segments. Initial-document events (Meta +
// FullSnapshot) precede incremental events; a stable sort by timestamp restores
// the original order across both segment arrays.
export function buildRrwebReplayEvents(
  initialDocuments: PreviewInitialDocument[],
  patchBatches: PreviewDomPatchBatch[],
): eventWithTime[] {
  const events: PreviewRecordedEvent[] = [];

  for (const initialDocument of initialDocuments) {
    if (initialDocument.events) {
      events.push(...initialDocument.events);
    }
  }

  for (const patchBatch of patchBatches) {
    if (patchBatch.events) {
      events.push(...patchBatch.events);
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
