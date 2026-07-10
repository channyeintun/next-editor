import { describe, expect, it } from "vitest";
import type {
  PreviewDomPatchBatch,
  PreviewInitialDocument,
  PreviewRecordedEvent,
} from "../../types/slides";
import {
  buildRrwebReplayEvents,
  createRrwebPreviewRecorderScript,
  hasRrwebPreviewEvents,
  PREVIEW_RRWEB_FORMAT_VERSION,
  RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE,
  RUNTIME_PATCH_BATCH_MESSAGE_TYPE,
  RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE,
} from "./rrwebPreview";

function event(type: number, timestamp: number): PreviewRecordedEvent {
  return { type, timestamp, data: { tag: timestamp } };
}

function initialDocument(events: PreviewRecordedEvent[]): PreviewInitialDocument {
  return {
    version: 2,
    time: events[0]?.timestamp ?? 0,
    documentId: "doc-1",
    events,
  };
}

function patchBatch(events: PreviewRecordedEvent[]): PreviewDomPatchBatch {
  return {
    version: 2,
    time: events[0]?.timestamp ?? 0,
    source: "runtime-preview",
    documentId: "doc-1",
    events,
  };
}

describe("buildRrwebReplayEvents", () => {
  it("concatenates seed + incremental events sorted by timestamp", () => {
    const seed = initialDocument([event(4, 0), event(2, 1)]);
    const batchA = patchBatch([event(3, 5), event(3, 2)]);
    const batchB = patchBatch([event(3, 10)]);

    const events = buildRrwebReplayEvents([seed], [batchA, batchB]);

    expect(events.map((entry) => entry.timestamp)).toEqual([0, 1, 2, 5, 10]);
  });

  it("tolerates records without events", () => {
    const bare: PreviewInitialDocument = {
      version: 2,
      time: 0,
      documentId: "doc-1",
    };

    expect(buildRrwebReplayEvents([bare], [])).toEqual([]);
  });

  it("rebases events onto the recording clock, dropping the preview-clock offset", () => {
    // The preview iframe records on a raw Date.now() clock that sits far ahead of
    // the recording clock (audio warmup delays `startedAt`). Replay must follow the
    // recording clock while preserving the preview event deltas.
    const PREVIEW_BASE = 1_700_000_000_000;
    const seed: PreviewInitialDocument = {
      version: 2,
      time: 0,
      documentId: "doc-1",
      events: [event(4, PREVIEW_BASE), event(2, PREVIEW_BASE + 1)],
    };
    // No drift: the batch's preview-clock lead over its recording time matches
    // the seed's, so every event keeps its raw rrweb delta with the epoch-sized
    // lead removed.
    const batch: PreviewDomPatchBatch = {
      version: 2,
      time: 2200,
      source: "runtime-preview",
      documentId: "doc-1",
      events: [event(3, PREVIEW_BASE + 2200), event(3, PREVIEW_BASE + 2210)],
    };

    const events = buildRrwebReplayEvents([seed], [batch]);

    expect(events.map((entry) => entry.timestamp)).toEqual([0, 1, 2200, 2210]);
  });

  it("anchors on the largest preview-clock lead so replay never lags the recording clock", () => {
    // The preview clock's lead over the recording clock can grow mid-recording
    // (the recording clock stalls while the preview keeps ticking). Rebasing by
    // the origin segment's smaller lead would replay later segments late vs the
    // audio (see 88f8114 "Fix rrweb playback delay"); instead the largest lead
    // wins: that segment lands exactly on its recording time, and segments with
    // a smaller lead shift earlier, clamped at 0.
    const PREVIEW_BASE = 1_700_000_000_000;
    const seed: PreviewInitialDocument = {
      version: 2,
      time: 0,
      documentId: "doc-1",
      events: [event(4, PREVIEW_BASE), event(2, PREVIEW_BASE + 1)],
    };
    // Recorded 2200ms into the preview clock but only 500ms into the recording
    // clock — a 1700ms larger lead than the seed's.
    const batch: PreviewDomPatchBatch = {
      version: 2,
      time: 500,
      source: "runtime-preview",
      documentId: "doc-1",
      events: [event(3, PREVIEW_BASE + 2200), event(3, PREVIEW_BASE + 2210)],
    };

    const events = buildRrwebReplayEvents([seed], [batch]);

    // Batch anchored at its recording time (500); seed events clamp at 0.
    expect(events.map((entry) => entry.timestamp)).toEqual([0, 0, 500, 510]);
  });
});

describe("hasRrwebPreviewEvents", () => {
  it("detects rrweb-format records", () => {
    expect(hasRrwebPreviewEvents([initialDocument([event(2, 0)])], [])).toBe(true);
    expect(hasRrwebPreviewEvents([], [patchBatch([event(3, 0)])])).toBe(true);
  });

  it("returns false for legacy records and empty input", () => {
    const legacy: PreviewInitialDocument = {
      version: 2,
      time: 0,
      documentId: "doc-1",
    };

    expect(hasRrwebPreviewEvents([legacy], [])).toBe(false);
    expect(hasRrwebPreviewEvents(undefined, undefined)).toBe(false);
  });
});

describe("createRrwebPreviewRecorderScript", () => {
  it("inlines the rrweb bundle and the recording wiring", () => {
    const script = createRrwebPreviewRecorderScript({ setupMarker: "__TEST_MARKER__" });

    // The UMD bundle is present (sets window.rrweb).
    expect(script).toContain("rrweb");
    // The wiring records and forwards events.
    expect(script).toContain("window.rrweb.record");
    expect(script).toContain("__TEST_MARKER__");
    expect(script).toContain(String(PREVIEW_RRWEB_FORMAT_VERSION));
    // Images must be baked into snapshots as data URLs: project-served image
    // URLs point at the ephemeral WebContainer origin and are dead in replay.
    expect(script).toContain("inlineImages: true");
    expect(script.length).toBeGreaterThan(100_000);
  });
});

// Executes the full injected script (UMD bundle + wiring) in the test DOM and
// drives the host protocol over real postMessage, verifying the recording-start
// snapshot handshake end to end. Runs last in this file: the wiring exposes no
// stop handle, so its recorder stays attached to the document afterwards.
describe("recorder wiring snapshot handshake", () => {
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  interface PostedMessage {
    type: string;
    payload: {
      documentId: string;
      refresh?: boolean;
      events?: PreviewRecordedEvent[];
    };
  }

  it("answers a host snapshot request with a refresh initial document, never a patch-stream snapshot", async () => {
    document.body.innerHTML = "<main><p id='status'>ready</p></main>";

    const messages: PostedMessage[] = [];
    const onMessage = (event: MessageEvent) => {
      const data = event.data as PostedMessage | undefined;
      if (
        data?.type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE ||
        data?.type === RUNTIME_PATCH_BATCH_MESSAGE_TYPE
      ) {
        messages.push(data);
      }
    };
    window.addEventListener("message", onMessage);

    // The wiring batches patches on animation frames; jsdom only provides rAF
    // when pretending to be visual, so fall back to a timer.
    window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(0), 16);

    try {
      // Indirect eval so the bundle + wiring run at global scope, as they would
      // when inlined into the served preview page.
      (0, eval)(createRrwebPreviewRecorderScript({ setupMarker: "__WIRING_TEST__" }));
      await sleep(50);

      const initialDocs = messages.filter(
        (message) => message.type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE,
      );
      expect(initialDocs).toHaveLength(1);
      expect(initialDocs[0].payload.refresh).toBeUndefined();
      const documentId = initialDocs[0].payload.documentId;

      // Host asks for the recording-start snapshot.
      window.postMessage({ type: RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE }, "*");
      await sleep(50);

      const refreshDocs = messages.filter(
        (message) =>
          message.type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE && message.payload.refresh,
      );
      expect(refreshDocs).toHaveLength(1);
      expect(refreshDocs[0].payload.documentId).toBe(documentId);
      // The answer carries a FullSnapshot (type 2) so it can seed replay.
      expect(refreshDocs[0].payload.events?.some((event) => event.type === 2)).toBe(true);

      // Prove the patch stream is alive, then confirm the snapshot was diverted
      // out of it: mutations flow as patches, FullSnapshots do not.
      const status = document.getElementById("status");
      if (!status) throw new Error("missing fixture node");
      status.textContent = "mutated";
      await sleep(100);

      const patchBatches = messages.filter(
        (message) => message.type === RUNTIME_PATCH_BATCH_MESSAGE_TYPE,
      );
      expect(patchBatches.length).toBeGreaterThan(0);
      const patchEvents = patchBatches.flatMap((message) => message.payload.events ?? []);
      expect(patchEvents.some((event) => event.type === 2)).toBe(false);
    } finally {
      // Detach the recorder via the stop handle the wiring parks on its setup
      // marker, so its observers don't outlive the test environment.
      const marker = (window as unknown as Record<string, { stop?: () => void } | boolean>)
        .__WIRING_TEST__;
      if (typeof marker === "object" && typeof marker.stop === "function") {
        marker.stop();
      }
      window.removeEventListener("message", onMessage);
    }
  });
});
