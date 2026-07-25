import type * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import {
  collaborationAwarenessServerStateSchema,
  type CollaborationAwarenessEvent,
} from "./protocol";

type CollaborationPresence = Extract<CollaborationAwarenessEvent, { kind: "state" }>;

export interface ResolvedMonacoAwarenessSelection {
  clientId: number;
  participant: CollaborationPresence;
  anchorOffset: number;
  headOffset: number;
}

/**
 * True when a relative position identifies its target only by root-type name.
 * Yjs resolves that shape through `Y.Doc.get(tname)`, which permanently creates
 * the root type when it does not already exist.
 */
function namesAnUnknownRootType(position: { item?: unknown; tname?: unknown } | null): boolean {
  return Boolean(position && position.item == null && position.tname != null);
}

/** Resolve standard y-monaco awareness selections that belong to one shared text. */
export function resolveMonacoAwarenessSelections(
  awareness: awarenessProtocol.Awareness,
  text: Y.Text,
): ResolvedMonacoAwarenessSelection[] {
  const doc = text.doc;
  if (!doc) return [];

  const selections: ResolvedMonacoAwarenessSelection[] = [];
  for (const [clientId, value] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue;
    const state = collaborationAwarenessServerStateSchema.safeParse(value);
    if (!state.success || state.data.collaboration.kind !== "state" || !state.data.selection) {
      continue;
    }
    // A relative position with no item and no type resolves by *name*, and
    // Y.Doc.get() creates a root type for any name it has not seen — so a peer
    // could grow this document's root map without bound by cycling `tname`.
    // Collaboration texts are nested types, never roots, so a legitimate
    // selection here always carries an item; anything else is dropped before it
    // reaches Yjs.
    if (namesAnUnknownRootType(state.data.selection.anchor)) continue;
    if (namesAnUnknownRootType(state.data.selection.head)) continue;
    try {
      const anchor = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(state.data.selection.anchor),
        doc,
      );
      const head = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(state.data.selection.head),
        doc,
      );
      if (!anchor || !head || anchor.type !== text || head.type !== text) continue;
      selections.push({
        clientId,
        participant: state.data.collaboration,
        anchorOffset: anchor.index,
        headOffset: head.index,
      });
    } catch {
      // A stale relative position can refer to a type that no longer exists.
    }
  }
  return selections;
}
