import type { Replayer } from "@rrweb/replay";
import type { eventWithTime } from "@rrweb/types";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  markOpenPopovers,
  POPOVER_OPEN_ATTRIBUTE,
  popoverToggleChange,
  type RrwebRecordingIdMirror,
  type SerializedSnapshotNode,
  topLayerReplayPlugin,
} from "./rrwebTopLayer";

// jsdom parses :popover-open (never matching) but has no popover methods, so
// popovers here carry their own open state and a stubbed show/hide.
function fakePopover(element: HTMLElement, initiallyOpen = false) {
  let open = initiallyOpen;
  const matches = element.matches.bind(element);
  Object.defineProperty(element, "matches", {
    value: (selector: string) => (selector === ":popover-open" ? open : matches(selector)),
  });
  const showPopover = vi.fn<() => void>(() => {
    open = true;
  });
  const hidePopover = vi.fn<() => void>(() => {
    open = false;
  });
  Object.assign(element, { showPopover, hidePopover });
  return {
    showPopover,
    hidePopover,
    setOpen: (value: boolean) => {
      open = value;
    },
  };
}

function idMirror(entries: Array<[Node, number]>): RrwebRecordingIdMirror {
  const ids = new Map(entries);
  return { getId: (node) => ids.get(node) ?? -1 };
}

function mutation(attributes: { id: number; attributes: Record<string, unknown> }[]) {
  return {
    type: 3,
    timestamp: 0,
    data: { source: 0, texts: [], attributes, removes: [], adds: [] },
  } as unknown as eventWithTime;
}

// The parts of a Replayer the plugin reads: its frame document and node mirror.
function replayContext(doc: Document, nodes: Map<number, Node> = new Map()) {
  return {
    replayer: {
      iframe: { contentDocument: doc },
      getMirror: () => ({ getNode: (id: number) => nodes.get(id) ?? null }),
    } as unknown as Replayer,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("markOpenPopovers", () => {
  it("marks only the open popovers' serialized nodes, at any depth", () => {
    document.body.innerHTML = `<div popover id="open"></div><div popover id="closed"></div><p id="plain"></p>`;
    const open = document.getElementById("open")!;
    const closed = document.getElementById("closed")!;
    fakePopover(open, true);
    fakePopover(closed, false);
    const snapshot: SerializedSnapshotNode = {
      id: 1,
      childNodes: [
        {
          id: 2,
          attributes: {},
          childNodes: [
            { id: 3, attributes: { popover: "" } },
            { id: 4, attributes: { popover: "" } },
            { id: 5 },
          ],
        },
      ],
    };

    markOpenPopovers(
      snapshot,
      idMirror([
        [open, 3],
        [closed, 4],
      ]),
      document,
      POPOVER_OPEN_ATTRIBUTE,
    );

    const [body] = snapshot.childNodes!;
    expect(body.attributes).toEqual({});
    expect(body.childNodes?.[0].attributes).toEqual({ popover: "", [POPOVER_OPEN_ATTRIBUTE]: "" });
    expect(body.childNodes?.[1].attributes).toEqual({ popover: "" });
  });

  it("leaves the snapshot alone when no popover is open", () => {
    document.body.innerHTML = `<div popover id="closed"></div>`;
    fakePopover(document.getElementById("closed")!, false);
    const snapshot: SerializedSnapshotNode = { id: 1, attributes: {} };

    markOpenPopovers(snapshot, idMirror([]), document, POPOVER_OPEN_ATTRIBUTE);

    expect(snapshot).toEqual({ id: 1, attributes: {} });
  });
});

describe("popoverToggleChange", () => {
  it("mirrors a recorded popover's current state as an attribute change", () => {
    document.body.innerHTML = `<div popover id="menu"></div>`;
    const menu = document.getElementById("menu")!;
    const popover = fakePopover(menu, true);
    const mirror = idMirror([[menu, 7]]);

    expect(popoverToggleChange(menu, mirror, POPOVER_OPEN_ATTRIBUTE)).toEqual({
      id: 7,
      attributes: { [POPOVER_OPEN_ATTRIBUTE]: "" },
    });
    // A coalesced open+close arrives as one toggle: the state wins, not the event.
    popover.setOpen(false);
    expect(popoverToggleChange(menu, mirror, POPOVER_OPEN_ATTRIBUTE)).toEqual({
      id: 7,
      attributes: { [POPOVER_OPEN_ATTRIBUTE]: null },
    });
  });

  it("ignores details toggles and nodes rrweb has not recorded", () => {
    document.body.innerHTML = `<details id="details"></details><div popover id="unrecorded"></div>`;
    const details = document.getElementById("details")!;
    const unrecorded = document.getElementById("unrecorded")!;
    fakePopover(unrecorded, true);
    const mirror = idMirror([[details, 2]]);

    expect(popoverToggleChange(details, mirror, POPOVER_OPEN_ATTRIBUTE)).toBeNull();
    expect(popoverToggleChange(unrecorded, mirror, POPOVER_OPEN_ATTRIBUTE)).toBeNull();
    expect(popoverToggleChange(null, mirror, POPOVER_OPEN_ATTRIBUTE)).toBeNull();
  });
});

describe("topLayerReplayPlugin", () => {
  it("opens and closes a replayed popover as its mirrored attribute changes", () => {
    document.body.innerHTML = `<div popover id="menu"></div>`;
    const menu = document.getElementById("menu")!;
    const popover = fakePopover(menu);
    const context = replayContext(document, new Map([[4, menu]]));

    menu.setAttribute(POPOVER_OPEN_ATTRIBUTE, "");
    topLayerReplayPlugin.handler?.(
      mutation([{ id: 4, attributes: { [POPOVER_OPEN_ATTRIBUTE]: "" } }]),
      true,
      context,
    );
    expect(popover.showPopover).toHaveBeenCalledOnce();

    menu.removeAttribute(POPOVER_OPEN_ATTRIBUTE);
    topLayerReplayPlugin.handler?.(
      mutation([{ id: 4, attributes: { [POPOVER_OPEN_ATTRIBUTE]: null } }]),
      true,
      context,
    );
    expect(popover.hidePopover).toHaveBeenCalledOnce();

    // Other attribute changes never touch the top layer.
    topLayerReplayPlugin.handler?.(
      mutation([{ id: 4, attributes: { class: "x" } }]),
      true,
      context,
    );
    expect(popover.showPopover).toHaveBeenCalledOnce();
    expect(popover.hidePopover).toHaveBeenCalledOnce();
  });

  it("reopens the popovers a rebuilt FullSnapshot marks as open", () => {
    document.body.innerHTML = `<div popover id="open" ${POPOVER_OPEN_ATTRIBUTE}></div><div popover id="closed"></div>`;
    const open = fakePopover(document.getElementById("open")!);
    const closed = fakePopover(document.getElementById("closed")!);

    topLayerReplayPlugin.handler?.(
      { type: 2, timestamp: 0, data: {} } as unknown as eventWithTime,
      true,
      replayContext(document),
    );

    expect(open.showPopover).toHaveBeenCalledOnce();
    expect(closed.showPopover).not.toHaveBeenCalled();
    expect(closed.hidePopover).not.toHaveBeenCalled();
  });
});
