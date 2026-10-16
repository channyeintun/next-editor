import type { Replayer } from "@rrweb/replay";
import type { eventWithTime } from "@rrweb/types";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createTopLayerReplayPlugin,
  markOpenPopovers,
  POPOVER_OPEN_ATTRIBUTE,
  popoverToggleChange,
  type RrwebRecordingIdMirror,
  type SerializedSnapshotNode,
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

describe("createTopLayerReplayPlugin", () => {
  it("opens and closes a replayed popover as its mirrored attribute changes", () => {
    document.body.innerHTML = `<div popover id="menu"></div>`;
    const menu = document.getElementById("menu")!;
    const popover = fakePopover(menu);
    const context = replayContext(document, new Map([[4, menu]]));
    const plugin = createTopLayerReplayPlugin();

    menu.setAttribute(POPOVER_OPEN_ATTRIBUTE, "");
    plugin.handler?.(
      mutation([{ id: 4, attributes: { [POPOVER_OPEN_ATTRIBUTE]: "" } }]),
      true,
      context,
    );
    expect(popover.showPopover).toHaveBeenCalledOnce();

    menu.removeAttribute(POPOVER_OPEN_ATTRIBUTE);
    plugin.handler?.(
      mutation([{ id: 4, attributes: { [POPOVER_OPEN_ATTRIBUTE]: null } }]),
      true,
      context,
    );
    expect(popover.hidePopover).toHaveBeenCalledOnce();

    // Other attribute changes never touch the top layer.
    plugin.handler?.(mutation([{ id: 4, attributes: { class: "x" } }]), true, context);
    expect(popover.showPopover).toHaveBeenCalledOnce();
    expect(popover.hidePopover).toHaveBeenCalledOnce();
  });

  it("reopens the popovers a rebuilt FullSnapshot marks as open", () => {
    document.body.innerHTML = `<div popover id="open" ${POPOVER_OPEN_ATTRIBUTE}></div><div popover id="closed"></div>`;
    const open = fakePopover(document.getElementById("open")!);
    const closed = fakePopover(document.getElementById("closed")!);

    createTopLayerReplayPlugin().handler?.(
      { type: 2, timestamp: 0, data: {} } as unknown as eventWithTime,
      true,
      replayContext(document),
    );

    expect(open.showPopover).toHaveBeenCalledOnce();
    expect(closed.showPopover).not.toHaveBeenCalled();
    expect(closed.hidePopover).not.toHaveBeenCalled();
  });

  // jsdom has no top layer: the dialog tracks "modal" itself, like Chrome does
  // after rrweb removed `open` from a dialog it opened with showModal().
  function fakeModalDialog(dialog: HTMLDialogElement, initiallyModal = true) {
    let modal = initiallyModal;
    const matches = dialog.matches.bind(dialog);
    Object.defineProperty(dialog, "matches", {
      value: (selector: string) => (selector === ":modal" ? modal : matches(selector)),
    });
    const close = vi.fn<() => void>(() => {
      // close() is a no-op unless the dialog has `open`.
      if (!dialog.hasAttribute("open")) return;
      dialog.removeAttribute("open");
      modal = false;
    });
    Object.assign(dialog, { close });
    return { close, isModal: () => modal };
  }

  function dialogFixture() {
    document.body.innerHTML = `<button id="opener">Open</button><dialog id="dialog" rr_open_mode="non-modal"><button id="inside">Close</button></dialog>`;
    const opener = document.getElementById("opener")!;
    const dialog = document.getElementById("dialog") as HTMLDialogElement;
    const nodes = new Map<number, Node>([
      [1, opener],
      [2, dialog],
      [3, document.getElementById("inside")!],
    ]);
    return { opener, dialog, context: replayContext(document, nodes) };
  }

  const focusEvent = (id: number, type = 5) =>
    ({ type: 3, timestamp: 0, data: { source: 2, type, id } }) as unknown as eventWithTime;

  it("closes a replayed modal dialog whose recorded close rrweb only hid", () => {
    const { dialog, context } = dialogFixture();
    const fake = fakeModalDialog(dialog);

    // rrweb has already removed `open` (and replayed rr_open_mode) by now.
    createTopLayerReplayPlugin().handler?.(
      mutation([{ id: 2, attributes: { open: null, rr_open_mode: "non-modal" } }]),
      true,
      context,
    );

    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.isModal()).toBe(false);
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("leaves a dialog that stayed modal live to rrweb", () => {
    const { dialog, context } = dialogFixture();
    const fake = fakeModalDialog(dialog);

    // Live, removing `open` by hand left the dialog modal; rrweb recorded that.
    createTopLayerReplayPlugin().handler?.(
      mutation([{ id: 2, attributes: { open: null, rr_open_mode: "modal" } }]),
      true,
      context,
    );

    expect(fake.close).not.toHaveBeenCalled();
    expect(fake.isModal()).toBe(true);
  });

  it("leaves a closed non-modal dialog alone: without `open` it is fully closed", () => {
    const { dialog, context } = dialogFixture();
    const fake = fakeModalDialog(dialog, false);

    createTopLayerReplayPlugin().handler?.(
      mutation([{ id: 2, attributes: { open: null, rr_open_mode: "non-modal" } }]),
      true,
      context,
    );

    expect(fake.close).not.toHaveBeenCalled();
  });

  it("re-applies the recorded focus that landed before the dialog closed", () => {
    const { opener, dialog, context } = dialogFixture();
    fakeModalDialog(dialog);
    const plugin = createTopLayerReplayPlugin();

    // Live order: close() returns focus to the opener at once, and the
    // `open` removal is recorded a microtask later. The replayed focus came
    // while the opener was still inert behind the modal dialog.
    plugin.handler?.(focusEvent(1), true, context);
    expect(document.activeElement).not.toBe(opener);
    plugin.handler?.(
      mutation([{ id: 2, attributes: { open: null, rr_open_mode: "non-modal" } }]),
      true,
      context,
    );

    expect(document.activeElement).toBe(opener);
  });

  it("re-applies nothing once the recorded focus has blurred", () => {
    const { opener, dialog, context } = dialogFixture();
    fakeModalDialog(dialog);
    const plugin = createTopLayerReplayPlugin();

    plugin.handler?.(focusEvent(1), true, context);
    plugin.handler?.(focusEvent(1, 6), true, context);
    plugin.handler?.(
      mutation([{ id: 2, attributes: { open: null, rr_open_mode: "non-modal" } }]),
      true,
      context,
    );

    expect(document.activeElement).not.toBe(opener);
  });
});
