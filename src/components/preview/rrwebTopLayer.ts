import type { playerConfig } from "@rrweb/replay";
import {
  RRWEB_EVENT_TYPE,
  RRWEB_INCREMENTAL_SOURCE,
  RRWEB_MOUSE_INTERACTION,
} from "../../core/src/preview";

// Top-layer state the rrweb recording does not carry. An open popover sits in
// the browser's top layer, which is not part of the DOM: popovertarget,
// showPopover() and light dismiss change no attribute, so rrweb records no
// mutation and every replayed popover stayed hidden.
//
// The recorder mirrors that state into the recording as a replay-only
// attribute on the popover's node — a synthetic attribute mutation on each
// `toggle`, and the attribute set on the node in every FullSnapshot (the seed,
// the host-requested recording-start snapshot and corrective checkpoints all
// pass through the recorder's emit). The live DOM is never touched. The
// replayed DOM then carries the state like any other attribute, through
// rebuilds and backward seeks, and the replay plugin below turns it back into
// real top-layer state with showPopover()/hidePopover(), so the popover gets
// its real stacking and UA positioning instead of an imitation of them.
//
// Modal dialogs are recorded (rrweb's rr_open_mode), but rrweb replays a
// close() by removing `open`, which only hides the dialog: it stays in the top
// layer and :modal, and the rest of the replayed document stays inert, so no
// later focus replays. The plugin closes it for real.
//
// Opening or closing moves focus live (into a dialog, back to its opener), and
// rrweb records that focus synchronously, before the attribute mutation it
// records a microtask later. Replay therefore focused an element that was still
// hidden or inert, and the focus was lost; the plugin re-applies the recorded
// focus once the top layer has changed.
export const POPOVER_OPEN_ATTRIBUTE = "data-next-editor-popover-open";

type ReplayPlugin = NonNullable<playerConfig["plugins"]>[number];

/** The parts of rrweb-snapshot's serialized node the recorder marks. */
export interface SerializedSnapshotNode {
  id?: number;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedSnapshotNode[];
}

/** rrweb's recording mirror (`record.mirror`), seen as node -> id. */
export interface RrwebRecordingIdMirror {
  getId(node: Node): number;
}

export interface PopoverAttributeChange {
  id: number;
  attributes: Record<string, string | null>;
}

// Marks the popovers that are open in `doc` on a FullSnapshot's serialized
// tree, by their rrweb ids. The snapshot must be the one rrweb just serialized
// from `doc` with `mirror`, so the ids match.
//
// This and popoverToggleChange are inlined verbatim, via .toString(), into the
// injected recorder script that runs inside the preview realm: plain var /
// function / for with no module-scope references. Keep them self-contained.
export function markOpenPopovers(
  snapshot: SerializedSnapshotNode,
  mirror: RrwebRecordingIdMirror,
  doc: Document,
  attributeName: string,
): void {
  var openIds: Record<number, boolean> = {};
  var hasOpen = false;
  var popovers = doc.querySelectorAll("[popover]");
  for (var index = 0; index < popovers.length; index += 1) {
    var isOpen = false;
    try {
      isOpen = popovers[index].matches(":popover-open");
    } catch {
      // A browser without popovers has none open.
    }
    var id = isOpen ? mirror.getId(popovers[index]) : -1;
    if (id > 0) {
      openIds[id] = true;
      hasOpen = true;
    }
  }
  if (!hasOpen) return;

  // Iterative walk: a deep document must not overflow the stack.
  var pending = [snapshot];
  while (pending.length > 0) {
    var node = pending.pop();
    if (!node) continue;
    if (node.attributes && node.id !== undefined && openIds[node.id]) {
      node.attributes[attributeName] = "";
    }
    var children = node.childNodes || [];
    for (var child = 0; child < children.length; child += 1) {
      pending.push(children[child]);
    }
  }
}

// The attribute change that mirrors a `toggle` event into the recording, or
// null when the target is not a popover rrweb has recorded. Reads the state
// itself rather than the event's newState: toggle events coalesce, so an open
// and close in one task arrive as a single event.
export function popoverToggleChange(
  target: EventTarget | null,
  mirror: RrwebRecordingIdMirror,
  attributeName: string,
): PopoverAttributeChange | null {
  var element = target as Element | null;
  if (!element || typeof element.hasAttribute !== "function" || !element.hasAttribute("popover")) {
    return null;
  }
  var id = mirror.getId(element);
  if (!(id > 0)) return null;
  var isOpen = false;
  try {
    isOpen = element.matches(":popover-open");
  } catch {
    return null;
  }
  var attributes: Record<string, string | null> = {};
  attributes[attributeName] = isOpen ? "" : null;
  return { id: id, attributes: attributes };
}

interface RecordedAttributeChange {
  id: number;
  attributes: Record<string, unknown>;
}

// Opens or closes a replayed popover to match its mirrored attribute. Called
// from the host realm on a node of the replay frame, so it duck-types rather
// than using instanceof.
function syncPopover(node: Node): void {
  const popover = node as HTMLElement;
  if (typeof popover.showPopover !== "function") return;
  const shouldBeOpen = popover.hasAttribute(POPOVER_OPEN_ATTRIBUTE);
  try {
    if (popover.matches(":popover-open") === shouldBeOpen) return;
    if (shouldBeOpen) {
      popover.showPopover();
    } else {
      popover.hidePopover();
    }
  } catch {
    // No longer a popover, or detached: the next change or rebuild resyncs it.
  }
}

// Closes a replayed modal dialog that rrweb hid by removing `open` after a
// recorded close. rrweb records rr_open_mode "modal" alongside a removed `open`
// only when the live dialog was still modal afterwards (its attribute removed
// by hand, which leaves a dialog modal live too), so that case is left as is.
function closeDialog(node: Node, change: RecordedAttributeChange): void {
  const dialog = node as HTMLDialogElement;
  if (
    dialog.nodeName !== "DIALOG" ||
    change.attributes.open !== null ||
    change.attributes.rr_open_mode === "modal" ||
    typeof dialog.close !== "function" ||
    dialog.hasAttribute("open")
  ) {
    return;
  }
  try {
    if (!dialog.matches(":modal")) return;
    // close() does nothing without the attribute, which rrweb already removed.
    dialog.setAttribute("open", "");
    dialog.close();
  } catch {
    // Detached or already closed: nothing left in the top layer.
  }
}

// rrweb calls a plugin's handler right after it casts each event, also while
// fast-forwarding a seek, so the replayed top layer is updated before the next
// event is applied. One plugin per Replayer: it follows that Replayer's focus.
export function createTopLayerReplayPlugin(): ReplayPlugin {
  // The node the recording last focused (rrweb id), null once it blurred.
  let focusedId: number | null = null;

  return {
    handler(event, _isSync, { replayer }) {
      if (event.type === RRWEB_EVENT_TYPE.FullSnapshot) {
        // A rebuild creates fresh nodes, none of them in the top layer or
        // focused yet, and a corrective snapshot may renumber them.
        focusedId = null;
        const doc = replayer.iframe.contentDocument;
        for (const popover of doc?.querySelectorAll(`[${POPOVER_OPEN_ATTRIBUTE}]`) ?? []) {
          syncPopover(popover);
        }
        return;
      }
      if (event.type !== RRWEB_EVENT_TYPE.IncrementalSnapshot) return;

      const data = event.data as {
        source?: number;
        type?: number;
        id?: number;
        attributes?: RecordedAttributeChange[];
      };
      if (data.source === RRWEB_INCREMENTAL_SOURCE.MouseInteraction) {
        if (data.type === RRWEB_MOUSE_INTERACTION.Focus && data.id !== undefined) {
          focusedId = data.id;
        } else if (data.type === RRWEB_MOUSE_INTERACTION.Blur && data.id === focusedId) {
          focusedId = null;
        }
        return;
      }
      if (data.source !== RRWEB_INCREMENTAL_SOURCE.Mutation) return;

      const mirror = replayer.getMirror();
      let topLayerChanged = false;
      for (const change of data.attributes ?? []) {
        const isPopoverChange = POPOVER_OPEN_ATTRIBUTE in change.attributes;
        if (!isPopoverChange && !("open" in change.attributes)) continue;
        const node = mirror.getNode(change.id);
        if (!node) continue;
        if (isPopoverChange) syncPopover(node);
        closeDialog(node, change);
        topLayerChanged = true;
      }

      const focused = topLayerChanged && focusedId !== null ? mirror.getNode(focusedId) : null;
      if (focused && focused.ownerDocument?.activeElement !== focused) {
        try {
          // As rrweb applies a recorded focus.
          (focused as HTMLElement).focus?.({ preventScroll: true });
        } catch {
          // Not focusable here: the next recorded focus applies as usual.
        }
      }
    },
  };
}
