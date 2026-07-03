import { describe, expect, it } from "vitest";
import type { Recording } from "../../core/src";
import type { PreviewDomPatchBatch, PreviewInitialDocument } from "../../core/src/slides";
import { createStreamingRecordingReader, decodeRecordingStream, encodeRecordingToStream } from ".";
import { createPreviewAddNodeHydrator, createPreviewAddNodeStripper } from "./previewPatchDedup";

// A feed-row-sized subtree. Long text makes per-add duplication dominate the
// encoded size if the dedup ever regresses (repeats land in separate deflate
// segments, so compression alone cannot remove them).
const ROW_TEXT = "The same feed row remounted by a virtualized list. ".repeat(40); // ~2KB

// rrweb-shaped serialized element: a <li class="row"> wrapping a text node.
// `idBase` sets the rrweb node ids (fresh per remount); `htmlId`/`text` vary
// the CONTENT, which must prevent dedup.
function rowNode(idBase: number, htmlId: string, text: string = ROW_TEXT) {
  return {
    type: 2,
    tagName: "li",
    attributes: { class: "row", id: htmlId },
    childNodes: [{ type: 3, textContent: text, id: idBase + 1 }],
    id: idBase,
  };
}

function mutationBatch(
  time: number,
  adds: { parentId: number; nextId: number | null; node: unknown }[],
): PreviewDomPatchBatch {
  return {
    version: 2,
    time,
    source: "runtime-preview",
    documentId: "doc-1",
    route: "/",
    events: [
      {
        type: 3,
        timestamp: 1_700_000_000_000 + time,
        data: { source: 0, texts: [], attributes: [], removes: [], adds },
      },
    ],
  };
}

const INITIAL_DOCUMENT: PreviewInitialDocument = {
  version: 2,
  time: 0,
  documentId: "doc-1",
  route: "/",
  events: [
    { type: 4, timestamp: 1_700_000_000_000, data: { href: "/", width: 800, height: 600 } },
    { type: 2, timestamp: 1_700_000_000_001, data: { node: { type: 0, childNodes: [], id: 1 } } },
  ],
};

// Scroll churn: the same two rows remount repeatedly with fresh rrweb ids; a
// third add differs only in its HTML id attribute (content — must NOT dedup);
// a fourth lacks a numeric rrweb id on a child (must be skipped verbatim).
const PATCH_BATCHES: PreviewDomPatchBatch[] = [
  mutationBatch(1_000, [
    { parentId: 10, nextId: null, node: rowNode(100, "row-a") },
    { parentId: 10, nextId: null, node: rowNode(102, "row-b") },
  ]),
  mutationBatch(2_000, [
    // Identical content to the first two rows, new rrweb ids (a remount).
    { parentId: 10, nextId: null, node: rowNode(200, "row-a") },
    { parentId: 10, nextId: null, node: rowNode(202, "row-b") },
  ]),
  mutationBatch(3_000, [
    // Same shape but different HTML id attribute: distinct content.
    { parentId: 10, nextId: null, node: rowNode(300, "row-c") },
    // Same content as row-a again — dedups against batch 1.
    { parentId: 10, nextId: null, node: rowNode(302, "row-a") },
    // Child without a numeric rrweb id: never deduped, stored verbatim.
    {
      parentId: 10,
      nextId: null,
      node: {
        type: 2,
        tagName: "li",
        attributes: { class: "row", id: "row-a" },
        childNodes: [{ type: 3, textContent: ROW_TEXT }],
        id: 304,
      },
    },
  ]),
];

function makeRecording(patchBatches: PreviewDomPatchBatch[]): Recording {
  return {
    version: 4,
    id: "recording-preview-dedup",
    name: "Preview add-node dedup round trip",
    createdAt: 1_700_000_000_000,
    duration: 10_000,
    keyframeInterval: 120,
    frames: [],
    previewInitialDocuments: [INITIAL_DOCUMENT],
    previewPatchBatches: patchBatches,
    streamFinalized: true,
  };
}

function collectAddNodes(batches: PreviewDomPatchBatch[] | undefined): unknown[] {
  const nodes: unknown[] = [];
  for (const batch of batches ?? []) {
    for (const event of batch.events ?? []) {
      const data = event.data as { source?: number; adds?: { node?: unknown }[] };
      if (event.type === 3 && data?.source === 0) {
        for (const add of data.adds ?? []) {
          nodes.push(add.node);
        }
      }
    }
  }
  return nodes;
}

describe("preview patch added-node dedup", () => {
  it("round-trips patch batches exactly through encode/decode", async () => {
    const bytes = await encodeRecordingToStream(makeRecording(PATCH_BATCHES));
    const decoded = decodeRecordingStream(bytes);

    expect(decoded.previewPatchBatches).toEqual(PATCH_BATCHES);
    // The stream-only marker must never leak into memory.
    for (const node of collectAddNodes(decoded.previewPatchBatches)) {
      expect(node).not.toHaveProperty("dedupTemplate");
    }
  });

  it("strips repeated added-node content to template markers", () => {
    const stripped = createPreviewAddNodeStripper()(PATCH_BATCHES) as PreviewDomPatchBatch[];
    const nodes = collectAddNodes(stripped);

    // Batch 1: first occurrences of row-a (template 0) and row-b (template 1),
    // kept verbatim.
    expect(nodes[0]).not.toHaveProperty("dedupTemplate");
    expect(nodes[1]).not.toHaveProperty("dedupTemplate");
    // Batch 2: identical remounts collapse to markers carrying fresh ids.
    expect(nodes[2]).toEqual({ dedupTemplate: 0, dedupIds: [200, 201] });
    expect(nodes[3]).toEqual({ dedupTemplate: 1, dedupIds: [202, 203] });
    // Batch 3: row-c differs in content (HTML id attribute) — verbatim; the
    // repeated row-a dedups again; the id-less node is never deduped.
    expect(nodes[4]).not.toHaveProperty("dedupTemplate");
    expect(nodes[5]).toEqual({ dedupTemplate: 0, dedupIds: [302, 303] });
    expect(nodes[6]).not.toHaveProperty("dedupTemplate");

    // The stripped form is what shrinks the stream: each of the three repeats
    // costs a ~60-byte marker instead of its ~2KB payload, independent of
    // deflate window reach.
    expect(JSON.stringify(stripped).length).toBeLessThan(
      JSON.stringify(PATCH_BATCHES).length - 3 * ROW_TEXT.length,
    );

    // Hydrating the stripped records in the same order restores the originals.
    expect(createPreviewAddNodeHydrator()(stripped)).toEqual(PATCH_BATCHES);
  });

  it("does not mutate the recording being encoded", async () => {
    const batches = structuredClone(PATCH_BATCHES);
    await encodeRecordingToStream(makeRecording(batches));

    expect(batches).toEqual(PATCH_BATCHES);
  });

  it("hydrates identically through the incremental reader, chunk by chunk", async () => {
    const bytes = await encodeRecordingToStream(makeRecording(PATCH_BATCHES));
    const reader = createStreamingRecordingReader();

    const CHUNK = 1024;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      reader.push(bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK)));
    }

    const streamed = reader.getRecording();
    expect(streamed?.previewPatchBatches).toEqual(PATCH_BATCHES);
  });

  it("keeps nodes distinct when only the HTML id attribute differs", async () => {
    // row-c (batch 3) shares every byte with row-a except attributes.id; if the
    // signature ever ignored attribute ids, restore would corrupt the DOM.
    const bytes = await encodeRecordingToStream(makeRecording(PATCH_BATCHES));
    const decoded = decodeRecordingStream(bytes);

    const nodes = collectAddNodes(decoded.previewPatchBatches) as {
      attributes?: { id?: string };
    }[];
    expect(nodes.map((node) => node.attributes?.id)).toEqual([
      "row-a",
      "row-b",
      "row-a",
      "row-b",
      "row-c",
      "row-a",
      "row-a",
    ]);
  });
});
