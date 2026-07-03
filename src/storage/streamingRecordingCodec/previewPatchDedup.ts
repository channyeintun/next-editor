import type { PreviewDomPatchBatch } from "../../core/src/slides";

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
// Symmetry contract: strippers and hydrators must observe added nodes in the
// same order. Both encoders (the live writer and the one-shot exporter) funnel
// previewPatch records through `StreamingRecordingWriter.appendEventSegment` in
// stream order, and both decoders (one-shot and incremental) hydrate segments
// in stream order — before any time re-sort — so the per-writer/per-reader
// template lists stay in lockstep: every non-marker dedupable node in the
// stream is a first occurrence, and both sides append it to their template
// list at the same index.
// ============================================================================

// rrweb EventType.IncrementalSnapshot / IncrementalSource.Mutation. Hardcoded
// (as in rrwebPreview.ts) so storage never depends on rrweb's enums.
const INCREMENTAL_SNAPSHOT_EVENT_TYPE = 3;
const MUTATION_SOURCE = 0;

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
    if (!isRecord(event) || event.type !== INCREMENTAL_SNAPSHOT_EVENT_TYPE) {
      return event;
    }
    const data = event.data;
    if (
      !isRecord(data) ||
      data.source !== MUTATION_SOURCE ||
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
 * `dedupTemplate` marker. Never mutates its input.
 */
export function createPreviewAddNodeStripper(): (records: ReadonlyArray<unknown>) => unknown[] {
  const templateIndexBySignature = new Map<string, number>();
  let templateCount = 0;

  return (records) =>
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
 * rather than throwing, matching the codec's tolerant-decode posture.
 */
export function createPreviewAddNodeHydrator(): (
  records: PreviewDomPatchBatch[],
) => PreviewDomPatchBatch[] {
  const templates: Record<string, unknown>[] = [];

  return (records) =>
    records.map((record) =>
      mapMutationAdds(record, (add) => {
        const node = add.node;
        if (isDedupAddMarker(node)) {
          const template = templates[node.dedupTemplate];
          if (!template) {
            return add;
          }
          return { ...add, node: applyNodeIds(template, node.dedupIds, { index: 0 }) };
        }

        if (!isRecord(node)) {
          return add;
        }
        const ids: number[] = [];
        if (!collectNodeIds(node, ids)) {
          return add;
        }
        templates.push(canonicalizeNode(node));
        return add;
      }),
    ) as PreviewDomPatchBatch[];
}
