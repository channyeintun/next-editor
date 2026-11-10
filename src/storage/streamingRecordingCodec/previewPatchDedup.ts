import {
  RRWEB_EVENT_TYPE,
  RRWEB_INCREMENTAL_SOURCE,
  type PreviewDomPatchBatch,
} from "../../core/src/preview";

// ============================================================================
// Preview-patch added-node dedup (stream-only representation)
//
// rrweb mutation events re-serialize a full node payload every time a node is
// (re)inserted. Pages that churn the same content — virtualized lists remount
// identical rows while scrolling, swap patterns re-add the same subtree — repeat
// byte-identical node payloads that differ only in their rrweb node ids. In a
// measured feed-style lesson, 81% of added-node bytes were such repeats, and
// per-segment deflate cannot remove them (repeats land in different segments,
// and even within one payload sit beyond deflate's 32KB window).
//
// On encode, an added node whose id-stripped content is byte-identical to an
// earlier added node is stored as a `{ dedupTemplate, dedupIds }` marker: the
// index of the earlier node in first-seen order, plus the subtree's rrweb ids
// in pre-order. On decode the marker is resolved by cloning that template and
// re-assigning the ids in the same pre-order walk, reproducing the original
// node exactly. Only the per-node rrweb `id` field participates — an `id`
// *attribute* (`attributes.id`) is content and keeps distinct nodes distinct.
// Nodes whose subtree lacks a numeric rrweb id anywhere are never deduped (nor
// registered as templates), so restoration is always exact. The marker exists
// ONLY inside the stream: in-memory `Recording` objects never carry it, and a
// decode(encode(x)) round-trip reproduces `x` exactly.
//
// A marker's size on the wire says nothing about what it is rebuilt into: the
// clone is as large as the template, which any number of later markers may name.
// So a marker must carry exactly one id per template node, which ties its
// encoded size to its clone, and each clone is charged to the stream's decoded
// budget (format.ts) through the `charge` callback. The stripper reports the
// same charge for every marker it writes, so the writer knows what its stream
// will cost a reader.
//
// Symmetry contract: strippers and hydrators must observe added nodes in the
// same order. The writer funnels previewPatch records through
// `StreamingRecordingWriter.appendEventSegment` in stream order, and both
// decoders (one-shot and incremental) hydrate segments in stream order — before
// any time re-sort — so the per-writer/per-reader template lists stay in
// lockstep: every non-marker dedupable node in the stream is a first occurrence,
// and both sides append it to their template list at the same index.
// ============================================================================

/**
 * What one cloned node is charged to the decoded budget: the node object and its
 * share of the `childNodes` array. Everything else a clone holds is shared with
 * the template.
 */
const HYDRATED_NODE_COST_BYTES = 64;

/** Reports decoded bytes to whoever keeps the stream's budget; a reader's throws when it is spent. */
type ChargeDecodedCost = (bytes: number) => void;

/** An id-stripped added node, kept for the stream's life so later markers can name it. */
interface DedupTemplate {
  node: Record<string, unknown>;
  /** Nodes in the subtree: the ids a marker must carry, and the nodes a clone allocates. */
  nodeCount: number;
}

/** Stream-only shape: replaces a mutation add's `node` whose content repeats. */
interface DedupAddMarker {
  dedupTemplate: number;
  dedupIds: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDedupAddMarker(value: unknown): value is DedupAddMarker {
  return (
    isRecord(value) && typeof value.dedupTemplate === "number" && Array.isArray(value.dedupIds)
  );
}

/**
 * Collects the subtree's rrweb node ids in pre-order (node, then childNodes in
 * array order). Returns `false` — dedup is skipped — when any node lacks a
 * numeric id, so a restore can never fabricate or drop an id field.
 */
function collectNodeIds(node: Record<string, unknown>, out: number[]): boolean {
  if (typeof node.id !== "number") {
    return false;
  }
  out.push(node.id);
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      if (!isRecord(child) || !collectNodeIds(child, out)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Copy of a serialized node without the per-node rrweb `id` fields (top level
 * and recursively through `childNodes`). Everything else — including an HTML
 * `id` attribute inside `attributes` — is kept, and non-copied values (like the
 * attributes object) are shared by reference, so templates are memory-cheap.
 */
function canonicalizeNode(node: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "id") {
      continue;
    }
    copy[key] =
      key === "childNodes" && Array.isArray(value)
        ? value.map((child) => (isRecord(child) ? canonicalizeNode(child) : child))
        : value;
  }
  return copy;
}

/** Rebuilds a node from an id-stripped template plus its pre-order id list. */
function applyNodeIds(
  template: Record<string, unknown>,
  ids: number[],
  cursor: { index: number },
): Record<string, unknown> {
  const restored: Record<string, unknown> = { id: ids[cursor.index], ...template };
  cursor.index += 1;
  if (Array.isArray(template.childNodes)) {
    restored.childNodes = template.childNodes.map((child) =>
      isRecord(child) ? applyNodeIds(child, ids, cursor) : child,
    );
  }
  return restored;
}

/**
 * Maps every mutation add of every rrweb event in a previewPatch record through
 * `mapAdd`, copying only what changes; records, events, and adds that come back
 * untouched keep their original references (input is live app state — never
 * mutated).
 */
function mapMutationAdds(
  record: unknown,
  mapAdd: (add: Record<string, unknown>) => unknown,
): unknown {
  if (!isRecord(record) || !Array.isArray(record.events)) {
    return record;
  }

  let eventsChanged = false;
  const nextEvents = record.events.map((event) => {
    if (!isRecord(event) || event.type !== RRWEB_EVENT_TYPE.IncrementalSnapshot) {
      return event;
    }
    const data = event.data;
    if (
      !isRecord(data) ||
      data.source !== RRWEB_INCREMENTAL_SOURCE.Mutation ||
      !Array.isArray(data.adds) ||
      data.adds.length === 0
    ) {
      return event;
    }

    let addsChanged = false;
    const nextAdds = data.adds.map((add) => {
      if (!isRecord(add)) {
        return add;
      }
      const nextAdd = mapAdd(add);
      if (nextAdd !== add) {
        addsChanged = true;
      }
      return nextAdd;
    });

    if (!addsChanged) {
      return event;
    }
    eventsChanged = true;
    return { ...event, data: { ...data, adds: nextAdds } };
  });

  if (!eventsChanged) {
    return record;
  }
  return { ...record, events: nextEvents };
}

/**
 * Stateful stripper for one encode pass. Feed previewPatch records in stream
 * order; returns copies with repeated added-node content replaced by the
 * `dedupTemplate` marker. Never mutates its input. `charge` is told what a reader
 * will charge for rebuilding each marker.
 */
export function createPreviewAddNodeStripper(): (
  records: ReadonlyArray<unknown>,
  charge?: ChargeDecodedCost,
) => unknown[] {
  const templateIndexBySignature = new Map<string, number>();
  let templateCount = 0;

  return (records, charge) =>
    records.map((record) =>
      mapMutationAdds(record, (add) => {
        const node = add.node;
        if (!isRecord(node)) {
          return add;
        }
        const ids: number[] = [];
        if (!collectNodeIds(node, ids)) {
          return add;
        }

        const signature = JSON.stringify(canonicalizeNode(node));
        const templateIndex = templateIndexBySignature.get(signature);
        if (templateIndex !== undefined) {
          const marker: DedupAddMarker = { dedupTemplate: templateIndex, dedupIds: ids };
          charge?.(ids.length * HYDRATED_NODE_COST_BYTES);
          return { ...add, node: marker };
        }

        templateIndexBySignature.set(signature, templateCount);
        templateCount += 1;
        return add;
      }),
    );
}

/**
 * Stateful hydrator for one decode pass. Feed decoded previewPatch records in
 * stream order; registers every dedupable non-marker node as a template (each
 * is a first occurrence, mirroring the stripper) and resolves markers by
 * cloning the referenced template with its recorded ids re-applied. A marker
 * pointing at an unknown template (foreign or corrupt stream) is left as-is
 * rather than throwing, matching the codec's tolerant-decode posture. A marker
 * whose id list does not fit its template is refused: no writer produces one,
 * and it would clone the template for the price of an empty list.
 *
 * Each clone is reported to `charge` before it is made. The template list only
 * grows on `commit`, so a call that throws, or whose segment is refused, leaves
 * the hydrator as it was.
 */
export function createPreviewAddNodeHydrator(): (
  records: PreviewDomPatchBatch[],
  charge?: ChargeDecodedCost,
) => { records: PreviewDomPatchBatch[]; commit: () => void } {
  const templates: DedupTemplate[] = [];

  return (records, charge) => {
    // Templates first seen in this call. Markers later in the same call may name them.
    const staged: DedupTemplate[] = [];
    const templateAt = (index: number): DedupTemplate | undefined =>
      index < templates.length ? templates[index] : staged[index - templates.length];

    const hydrated = records.map((record) =>
      mapMutationAdds(record, (add) => {
        const node = add.node;
        if (isDedupAddMarker(node)) {
          const template = templateAt(node.dedupTemplate);
          if (!template) {
            return add;
          }
          if (node.dedupIds.length !== template.nodeCount) {
            throw new Error("Invalid SCR3 stream: preview dedup marker does not fit its template");
          }
          charge?.(template.nodeCount * HYDRATED_NODE_COST_BYTES);
          return { ...add, node: applyNodeIds(template.node, node.dedupIds, { index: 0 }) };
        }

        if (!isRecord(node)) {
          return add;
        }
        const ids: number[] = [];
        if (!collectNodeIds(node, ids)) {
          return add;
        }
        staged.push({ node: canonicalizeNode(node), nodeCount: ids.length });
        return add;
      }),
    ) as PreviewDomPatchBatch[];

    return {
      records: hydrated,
      commit: () => {
        for (const template of staged) templates.push(template);
      },
    };
  };
}
