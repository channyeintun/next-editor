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

  it("rebases events onto each segment's recording time, dropping the preview-clock offset", () => {
    // The preview iframe records on a raw Date.now() clock that sits far ahead of
    // the recording clock (audio warmup delays `startedAt`). Replay must follow the
    // recording clock, so events anchor to their segment `time`, not their raw ts.
    const PREVIEW_BASE = 1_700_000_000_000;
    const seed: PreviewInitialDocument = {
      version: 2,
      time: 0,
      documentId: "doc-1",
      events: [event(4, PREVIEW_BASE), event(2, PREVIEW_BASE + 1)],
    };
    const batch: PreviewDomPatchBatch = {
      version: 2,
      time: 500,
      source: "runtime-preview",
      documentId: "doc-1",
      events: [event(3, PREVIEW_BASE + 2200), event(3, PREVIEW_BASE + 2210)],
    };

    const events = buildRrwebReplayEvents([seed], [batch]);

    // Seed anchored at 0 (offsets 0,1); batch anchored at 500 (offsets 0,10) —
    // the ~2.2s preview-clock lead is gone.
    expect(events.map((entry) => entry.timestamp)).toEqual([0, 1, 500, 510]);
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
    expect(script.length).toBeGreaterThan(100_000);
  });
});
