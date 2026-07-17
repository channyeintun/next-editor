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
