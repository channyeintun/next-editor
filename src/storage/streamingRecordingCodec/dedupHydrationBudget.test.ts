import { describe, expect, it, vi } from "vite-plus/test";
import type { PreviewDomPatchBatch } from "../../core/src/preview";
import type { WorkspaceRecordingEvent } from "../../types/workspace";
import { createStreamingRecordingReader, decodeRecordingStream } from "./decode";
import { createStreamingRecordingWriter } from "./encode";
import {
  buildFooterChunk,
  buildHeaderChunk,
  buildSegmentChunk,
  chargeInflationBudget,
  concatChunks,
  createInflationBudget,
  encodeRecords,
  SEGMENT_KIND,
  type RecordingStreamMeta,
  type SegmentKind,
} from "./format";
import { createPreviewAddNodeHydrator, createPreviewAddNodeStripper } from "./previewPatchDedup";
import {
  createWorkspaceEventContentHydrator,
  createWorkspaceEventContentStripper,
} from "./workspaceEventDedup";

const MiB = 1024 * 1024;

// The real stream budget is 512 MiB, and a stream that spends it holds that much
// in memory first. Shrink it, for the readers and the writer alike, so the
// refusals can be exercised with small inputs.
const STREAM_BUDGET = 8 * MiB;

vi.mock("./format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./format")>();
  return {
    ...actual,
    MAX_INFLATED_STREAM_BYTES: 8 * 1024 * 1024,
    createInflationBudget: (maxBytes: number = 8 * 1024 * 1024) =>
      actual.createInflationBudget(maxBytes),
  };
});

// What one cloned node is charged (HYDRATED_NODE_COST_BYTES in previewPatchDedup.ts).
const NODE_COST = 64;
const TEMPLATE_CHILDREN = 10_000;
const TEMPLATE_NODES = TEMPLATE_CHILDREN + 1;

/** One rrweb mutation batch whose adds carry `nodes`. */
function addsBatch(time: number, nodes: unknown[]): PreviewDomPatchBatch {
  return {
    version: 2,
    time,
    source: "runtime-preview",
    documentId: "doc-1",
    route: "/",
    events: [
      {
        type: 3,
        timestamp: time,
        data: {
          source: 0,
          texts: [],
          attributes: [],
          removes: [],
          adds: nodes.map((node) => ({ parentId: 1, nextId: null, node })),
        },
      },
    ],
  };
}

/** A subtree of 10,001 nodes: identical children deflate to almost nothing. */
function templateNode(firstId: number) {
  return {
    type: 2,
    tagName: "ul",
    attributes: {},
    childNodes: Array.from({ length: TEMPLATE_CHILDREN }, (_, index) => ({
      type: 2,
      tagName: "li",
      attributes: {},
      childNodes: [],
      id: firstId + 1 + index,
    })),
    id: firstId,
  };
}

/** A marker as it sits on the wire: an earlier template's index plus `ids`. */
function marker(ids: number[]) {
  return { dedupTemplate: 0, dedupIds: ids };
}

const fullIds = Array.from({ length: TEMPLATE_NODES }, (_, index) => index + 1);

function addedNodes(batches: PreviewDomPatchBatch[]): unknown[] {
  return batches.flatMap((batch) =>
    (batch.events ?? []).flatMap((event) =>
      (event.data as { adds: { node: unknown }[] }).adds.map((add) => add.node),
    ),
  );
}

const FILE_PATH = "a.txt";
const BASE_CONTENT = "a".repeat(MiB);

function workspaceEvent(timestamp: number, file: Record<string, unknown>): WorkspaceRecordingEvent {
  return {
    timestamp,
    snapshot: {
      project: {
        id: "project",
        name: "Project",
        lessonType: "html-css",
        entryFilePath: FILE_PATH,
        folders: [],
        files: {
          [FILE_PATH]: { path: FILE_PATH, name: FILE_PATH, language: "plaintext", ...file },
        },
      },
      activeFilePath: FILE_PATH,
    },
  } as unknown as WorkspaceRecordingEvent;
}

/** A ~40-byte event, as it sits on the wire, that rebuilds the whole 1 MiB file. */
function spliceEvent(timestamp: number): WorkspaceRecordingEvent {
  return workspaceEvent(timestamp, { content: "", contentSplice: [1, 1, "b"] });
}

const SEED = workspaceEvent(0, { content: BASE_CONTENT }).snapshot;

const META: RecordingStreamMeta = {
  version: 4,
  id: "hydration",
  name: "Hydration",
  keyframeInterval: 120,
  createdAt: 1,
  duration: 1_000,
};

/** A finalized stream holding `segments` as they are, with no writer limit in the way. */
function streamOf(
  meta: RecordingStreamMeta,
  segments: Array<{ kind: SegmentKind; records: unknown[] }>,
): Uint8Array {
  const chunks = [buildHeaderChunk(meta, 0)];
  const index = segments.map(({ kind, records }) => {
    chunks.push(buildSegmentChunk(kind, encodeRecords(records).payload, 0, 0, -1, 0, false));
    return { kind, byteOffset: 0, firstTimestampMs: 0, firstFrameIndex: -1 };
  });
  chunks.push(buildFooterChunk(index));
  return concatChunks(chunks);
}

function pushInSlices(stream: Uint8Array): void {
  const reader = createStreamingRecordingReader();
  for (let offset = 0; offset < stream.byteLength; offset += 64 * 1024) {
    reader.push(stream.subarray(offset, offset + 64 * 1024));
  }
}

describe("preview dedup markers", () => {
  // An empty id list cost ~26 bytes on the wire and cloned the whole template.
  it("refuses a marker whose ids do not fit its template", () => {
    const hydrate = createPreviewAddNodeHydrator();
    hydrate([addsBatch(0, [templateNode(1)])]).commit();

    expect(() => hydrate([addsBatch(1, [marker([])])])).toThrow(
      /Invalid SCR3 stream: preview dedup marker does not fit its template/,
    );
    expect(() => hydrate([addsBatch(1, [marker(fullIds.slice(1))])])).toThrow(
      /does not fit its template/,
    );
    expect(() => hydrate([addsBatch(1, [marker([...fullIds, 0])])])).toThrow(
      /does not fit its template/,
    );
  });

  it("charges each clone to the budget and refuses the one that overspends it", () => {
    const hydrate = createPreviewAddNodeHydrator();
    hydrate([addsBatch(0, [templateNode(1)])]).commit();
    const budget = createInflationBudget(2 * MiB);
    const charge = (bytes: number) => chargeInflationBudget(budget, bytes);

    const first = hydrate([addsBatch(1, [marker(fullIds)])], charge);
    expect(addedNodes(first.records)).toEqual([templateNode(1)]);
    expect(2 * MiB - budget.remaining).toBe(TEMPLATE_NODES * NODE_COST);

    // Each marker is ~640 KiB of clone, so the budget runs out on the fourth.
    const markers = Array.from({ length: 50 }, () => marker(fullIds));
    expect(() => hydrate([addsBatch(2, markers)], charge)).toThrow(
      /Invalid SCR3 stream: stream exceeds the decoded size limit/,
    );
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
    expect(budget.remaining).toBeLessThan(TEMPLATE_NODES * NODE_COST);
  });

  it("forgets the templates of a call that threw", () => {
    const hydrate = createPreviewAddNodeHydrator();
    hydrate([addsBatch(0, [templateNode(1)])]).commit();
    const other = { type: 3, textContent: "other", id: 7 };
    const useOther = { dedupTemplate: 1, dedupIds: [8] };

    expect(() => hydrate([addsBatch(1, [other, useOther, marker([])])])).toThrow(
      /does not fit its template/,
    );
    // Template 1 was only staged, so a later marker naming it is left as it is.
    expect(addedNodes(hydrate([addsBatch(2, [useOther])]).records)).toEqual([useOther]);

    // Committed, the same template resolves.
    hydrate([addsBatch(3, [other])]).commit();
    expect(addedNodes(hydrate([addsBatch(4, [useOther])]).records)).toEqual([{ ...other, id: 8 }]);
  });

  it("tells a writer what a reader charges for the markers it writes", () => {
    const strip = createPreviewAddNodeStripper();
    let written = 0;
    const stripped = strip(
      [addsBatch(0, [templateNode(1)]), addsBatch(1, [templateNode(20_000), templateNode(40_000)])],
      (bytes) => {
        written += bytes;
      },
    ) as PreviewDomPatchBatch[];

    let read = 0;
    const hydrated = createPreviewAddNodeHydrator()(stripped, (bytes) => {
      read += bytes;
    });
    expect(read).toBe(2 * TEMPLATE_NODES * NODE_COST);
    expect(written).toBe(read);
    expect(addedNodes(hydrated.records)).toEqual([
      templateNode(1),
      templateNode(20_000),
      templateNode(40_000),
    ]);
  });

  // ~12 KiB of markers per megabyte of clones: far past the stream's budget in
  // memory while the inflated bytes charged for them stayed a rounding error.
  it("refuses a stream whose markers clone past the stream budget", () => {
    const markers = Array.from({ length: 20 }, () => marker(fullIds));
    const stream = streamOf(META, [
      { kind: SEGMENT_KIND.previewPatch, records: [addsBatch(0, [templateNode(1)])] },
      { kind: SEGMENT_KIND.previewPatch, records: [addsBatch(1, markers)] },
    ]);
    expect(20 * TEMPLATE_NODES * NODE_COST).toBeGreaterThan(STREAM_BUDGET);

    expect(() => decodeRecordingStream(stream)).toThrow(/stream exceeds the decoded size limit/);
    expect(() => pushInSlices(stream)).toThrow(/stream exceeds the decoded size limit/);
  });

  it("refuses a stream whose markers carry no ids", () => {
    const markers = Array.from({ length: 50 }, () => marker([]));
    const stream = streamOf(META, [
      {
        kind: SEGMENT_KIND.previewPatch,
        records: [addsBatch(0, [templateNode(1)]), addsBatch(1, markers)],
      },
    ]);

    expect(() => decodeRecordingStream(stream)).toThrow(/does not fit its template/);
    expect(() => pushInSlices(stream)).toThrow(/does not fit its template/);
  });
});

describe("workspace content splices", () => {
  it("charges each rebuilt file to the budget and refuses the one that overspends it", () => {
    const hydrate = createWorkspaceEventContentHydrator(SEED);
    const budget = createInflationBudget(4 * MiB);
    const charge = (bytes: number) => chargeInflationBudget(budget, bytes);

    const first = hydrate([spliceEvent(1)], charge);
    expect(first.records[0].snapshot.project.files[FILE_PATH].content).toBe(
      `ab${"a".repeat(MiB - 2)}`,
    );
    expect(4 * MiB - budget.remaining).toBe(MiB);

    const events = Array.from({ length: 16 }, (_, index) => spliceEvent(index + 2));
    expect(() => hydrate(events, charge)).toThrow(
      /Invalid SCR3 stream: stream exceeds the decoded size limit/,
    );
    expect(budget.remaining).toBe(0);
  });

  it("keeps its carry as it was when a call throws or is not committed", () => {
    const hydrate = createWorkspaceEventContentHydrator(SEED);
    const replaced = workspaceEvent(1, { content: "replaced" });
    const malformed = workspaceEvent(2, { content: "", contentSplice: [0, 0, 7] });
    const unchanged = workspaceEvent(3, { content: "", contentUnchanged: true });
    const contentOf = (events: WorkspaceRecordingEvent[]) =>
      events.map((event) => event.snapshot.project.files[FILE_PATH].content);

    expect(() => hydrate([replaced, malformed])).toThrow(/malformed workspace content splice/);
    expect(contentOf(hydrate([unchanged]).records)).toEqual([BASE_CONTENT]);

    // Staged but never committed: the next call still builds on the seed.
    expect(contentOf(hydrate([replaced, unchanged]).records)).toEqual(["replaced", "replaced"]);
    expect(contentOf(hydrate([unchanged]).records)).toEqual([BASE_CONTENT]);

    hydrate([replaced]).commit();
    expect(contentOf(hydrate([unchanged]).records)).toEqual(["replaced"]);
  });

  it.each([
    ["a non-string insert", [0, 0, ["x"]]],
    ["a negative start", [-1, 0, "x"]],
    ["a fractional delete count", [0, 0.5, "x"]],
    ["a missing insert", [0, 0]],
    ["an object", { start: 0 }],
  ])("refuses a splice with %s", (_label, contentSplice) => {
    const hydrate = createWorkspaceEventContentHydrator(SEED);
    expect(() => hydrate([workspaceEvent(1, { content: "", contentSplice })])).toThrow(
      /Invalid SCR3 stream: malformed workspace content splice for a\.txt/,
    );
  });

  it("tells a writer what a reader charges for the splices it writes", () => {
    const edited = (index: number) => `${"b".repeat(index)}${BASE_CONTENT.slice(index)}`;
    const events = [1, 2, 3].map((index) => workspaceEvent(index, { content: edited(index) }));
    let written = 0;
    const stripped = createWorkspaceEventContentStripper(SEED)(events, (bytes) => {
      written += bytes;
    }) as WorkspaceRecordingEvent[];

    let read = 0;
    const hydrated = createWorkspaceEventContentHydrator(SEED)(stripped, (bytes) => {
      read += bytes;
    });
    expect(read).toBe(3 * MiB);
    expect(written).toBe(read);
    expect(hydrated.records).toEqual(events);
  });

  // 16 events of ~40 bytes each rebuilt 16 MiB of file content, none of it charged.
  it("refuses a stream whose splices rebuild past the stream budget", () => {
    const events = Array.from({ length: 16 }, (_, index) => spliceEvent(index + 1));
    const stream = streamOf({ ...META, workspaceSnapshot: SEED }, [
      { kind: SEGMENT_KIND.workspace, records: events },
    ]);
    expect(stream.byteLength).toBeLessThan(64 * 1024);

    expect(() => decodeRecordingStream(stream)).toThrow(/stream exceeds the decoded size limit/);
    expect(() => pushInSlices(stream)).toThrow(/stream exceeds the decoded size limit/);
  });

  it("has the writer refuse the edits a reader would, and readers open the rest", () => {
    const writer = createStreamingRecordingWriter();
    writer.writeHeader({ ...META, workspaceSnapshot: SEED });
    const edited = (index: number) => `${"b".repeat(index)}${BASE_CONTENT.slice(index)}`;
    const event = (index: number) => workspaceEvent(index, { content: edited(index) });

    // The header's 1 MiB seed and six rebuilt copies fit the 8 MiB budget; a seventh does not.
    for (let index = 1; index <= 6; index += 1) {
      writer.appendEventSegment(SEGMENT_KIND.workspace, [event(index)]);
    }
    expect(() => writer.appendEventSegment(SEGMENT_KIND.workspace, [event(7)])).toThrow(
      /Recording is too large to save: its records would exceed .* once decoded/,
    );

    const decoded = decodeRecordingStream(writer.finalize());
    expect(decoded.streamFinalized).toBe(true);
    expect(decoded.workspaceEvents).toEqual([1, 2, 3, 4, 5, 6].map(event));
  });
});
