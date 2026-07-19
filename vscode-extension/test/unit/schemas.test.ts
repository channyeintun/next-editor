import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionEventType } from "../../src/model/events";
import {
  manifestSchema,
  seekIndexSchema,
  sessionEventSchema,
  sessionMetadataSchema,
  validateSessionEventRaw,
  type WireSessionEvent,
} from "../../src/model/schemas";
import type { ManifestV1 } from "../../src/model/manifest";
import { buildSeekIndex } from "../../src/storage/SeekIndexBuilder";
import { benchmarkFixtureConfigs, generateFixture } from "../../src/webview/player/fixtures";

// Type-level equivalence pin (plan §7): every SessionEvent the extension
// produces must be a valid wire event. (The reverse direction is widened
// by branded ID types, which erase at runtime.)
const _assignable: WireSessionEvent = null as unknown as SessionEvent;
void _assignable;

function sample<T extends SessionEventType>(type: T, payload: unknown): SessionEvent {
  return { seq: 0, tUs: 0, type, payload } as SessionEvent;
}

const samples: SessionEvent[] = [
  sample("session.started", {
    sessionId: "s",
    extensionVersion: "1",
    vscodeVersion: "1",
    platform: "darwin",
    architecture: "arm64",
  }),
  sample("roots.snapshot", {
    roots: [{ rootId: "r", name: "root", ordinal: 0 }],
  }),
  sample("document.enrolled", {
    descriptor: {
      documentId: "d",
      rootId: null,
      logicalPath: "a.ts",
      displayName: "a.ts",
      schemeClass: "file",
      languageId: "typescript",
      eol: "LF",
      initialVersion: 1,
      initialCheckpointId: "c",
      byteLength: 3,
      sha256: "abc",
    },
  }),
  sample("document.patch", {
    documentId: "d",
    beforeVersion: 1,
    afterVersion: 2,
    reason: "unknown",
    changes: [{ rangeOffsetUtf16: 0, rangeLengthUtf16: 0, text: "x" }],
    beforeHash: "a",
    afterHash: "b",
    eolBefore: "LF",
    eolAfter: "LF",
  }),
  sample("document.checkpoint", {
    checkpointId: "c2",
    documentId: "d",
    reason: "interval",
    version: 4,
    eol: "LF",
    byteLength: 10,
    sha256: "h",
  }),
  sample("document.languageChanged", { documentId: "d", languageId: "rust" }),
  sample("document.eolChanged", { documentId: "d", eol: "CRLF", version: 5 }),
  sample("document.saved", { documentId: "d", version: 5 }),
  sample("document.closed", { documentId: "d" }),
  sample("document.resumed", { documentId: "d", version: 1 }),
  sample("surface.opened", {
    surfaceId: "s1",
    documentId: "d",
    groupId: null,
    viewColumn: 1,
    selections: [{ anchorOffsetUtf16: 0, activeOffsetUtf16: 0 }],
    visibleRanges: [{ startLine: 0, startCharacter: 0, endLine: 3, endCharacter: 0 }],
    isActive: true,
  }),
  sample("surface.closed", { surfaceId: "s1" }),
  sample("surface.focused", { surfaceId: "s1" }),
  sample("surface.selectionChanged", {
    surfaceId: "s1",
    documentId: "d",
    documentVersion: 2,
    kind: "mouse",
    selections: [{ anchorOffsetUtf16: 1, activeOffsetUtf16: 4 }],
  }),
  sample("surface.viewportChanged", {
    surfaceId: "s1",
    documentId: "d",
    documentVersion: 2,
    visibleRanges: [{ startLine: 5, startCharacter: 0, endLine: 40, endCharacter: 0 }],
  }),
  sample("topology.snapshot", {
    groups: [
      {
        groupId: "g1",
        viewColumn: 1,
        isActive: true,
        activeTabId: "t1",
        tabs: [
          {
            tabId: "t1",
            kind: "text",
            documentId: "d",
            label: "a.ts",
            isActive: true,
            isPinned: false,
            isPreview: false,
          },
        ],
      },
    ],
    activeGroupId: "g1",
    fidelity: "reconstructed-no-geometry",
    discontinuity: false,
  }),
  sample("window.focusChanged", { focused: true }),
  sample("capability.unsupportedSurface", {
    tabId: "t2",
    kind: "textDiff",
    label: "diff",
  }),
  sample("capture.overload", { queuedEvents: 10, note: "queue" }),
  sample("capture.shadowMismatch", {
    documentId: "d",
    expectedSha256: "a",
    observedSha256: "b",
    version: 9,
  }),
  sample("audio.started", {
    audioTrackId: "au",
    sampleRate: 48000,
    channels: 1,
  }),
  sample("audio.calibration", {
    audioTrackId: "au",
    offsetUs: 120.5,
    drift: 1.000001,
    points: 12,
    uncertaintyUsP50: 250,
    uncertaintyUsP95: 900,
  }),
  sample("audio.discontinuity", { audioTrackId: "au", reason: "device-lost" }),
  sample("audio.stopped", { audioTrackId: "au", sampleFrames: 480000 }),
  sample("session.stopping", { reason: "user" }),
  sample("session.finalized", { eventCount: 100, durationUs: 5_000_000 }),
  sample("session.recovered", { recoveredThroughSeq: 42 }),
  sample("session.failed", { message: "disk full" }),
  sample("marker", { label: "note" }),
];

describe("v1 schemas", () => {
  it("covers every event type in the union", () => {
    const covered = new Set(samples.map((event) => event.type));
    const declared = sessionEventSchema.options.map((option) => option.shape.type.value as string);
    for (const type of declared) {
      expect(covered.has(type as SessionEventType), `missing sample for ${type}`).toBe(true);
    }
    expect(declared.length).toBe(samples.length);
  });

  it("accepts every produced event shape", () => {
    for (const event of samples) {
      expect(validateSessionEventRaw(event), `${event.type} failed validation`).toBeNull();
    }
  });

  it("rejects malformed events", () => {
    expect(validateSessionEventRaw({})).not.toBeNull();
    expect(validateSessionEventRaw({ seq: 0, tUs: 0, type: "nope", payload: {} })).not.toBeNull();
    expect(
      validateSessionEventRaw({
        seq: -1,
        tUs: 0,
        type: "marker",
        payload: { label: "x" },
      }),
    ).not.toBeNull();
    expect(
      validateSessionEventRaw({
        seq: 0,
        tUs: 0,
        type: "document.patch",
        payload: { documentId: "d" },
      }),
    ).not.toBeNull();
  });

  it("accepts every event of a generated fixture", () => {
    const config = benchmarkFixtureConfigs().find((c) => c.name === "unicode")!;
    const fixture = generateFixture(config);
    for (const event of fixture.events) {
      expect(validateSessionEventRaw(event), `seq ${event.seq}`).toBeNull();
    }
  });

  it("validates a well-formed manifest", () => {
    const manifest: ManifestV1 = {
      kind: "next-recording",
      formatVersion: 1,
      sessionId: "s",
      createdAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      durationUs: 1000,
      producer: {
        extensionVersion: "0.0.1",
        vscodeVersion: "1.129.0",
        platform: "darwin",
        architecture: "arm64",
      },
      timebase: { kind: "host-monotonic-us" },
      capabilities: {
        textDocuments: true,
        selections: true,
        verticalViewport: true,
        topology: true,
        audio: false,
        unsupportedSurfaceMarkers: true,
      },
      limitsApplied: [],
      workspaceRoots: [],
      documents: [],
      tabs: [],
      initialTopologyRef: null,
      eventJournalRef: { entry: "events.ndjson", eventCount: 0 },
      seekIndexRef: { entry: "index.json" },
      audioTracks: [],
      integrity: { entries: {} },
    };
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifestSchema.safeParse({ ...manifest, formatVersion: 2 }).success).toBe(false);
  });

  it("validates seek index and session metadata", () => {
    const config = benchmarkFixtureConfigs().find((c) => c.name === "edit-burst")!;
    const fixture = generateFixture(config);
    const index = buildSeekIndex(fixture.events, null);
    expect(seekIndexSchema.safeParse(index).success).toBe(true);

    expect(
      sessionMetadataSchema.safeParse({
        formatVersion: 1,
        sessionId: "s",
        state: "recording",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastDurableSeq: -1,
        extensionVersion: "0.0.1",
        vscodeVersion: "1.129.0",
        failure: null,
        artifactPath: null,
      }).success,
    ).toBe(true);
  });
});
