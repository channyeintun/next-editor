import type { Replayer } from "@rrweb/replay";
import type { eventWithTime } from "@rrweb/types";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createTopLayerReplayPlugin,
  markOpenPopovers,
  markTopLayerOrder,
  POPOVER_OPEN_ATTRIBUTE,
  popoverToggleChange,
  type RrwebRecordingIdMirror,
  type SerializedSnapshotNode,
  TOP_LAYER_ORDER_ATTRIBUTE,
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
      () => null,
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

    markOpenPopovers(snapshot, idMirror([]), document, POPOVER_OPEN_ATTRIBUTE, () => null);

    expect(snapshot).toEqual({ id: 1, attributes: {} });
  });

  it("records the invoker each open popover was opened with, by its rrweb id", () => {
    document.body.innerHTML = `<div popover id="menu"><button id="item">Sub</button></div><div popover id="sub"></div>`;
    const menu = document.getElementById("menu")!;
    const sub = document.getElementById("sub")!;
    const item = document.getElementById("item")!;
    fakePopover(menu, true);
    fakePopover(sub, true);
    const snapshot: SerializedSnapshotNode = {
      id: 1,
      childNodes: [
        { id: 2, attributes: { popover: "" }, childNodes: [{ id: 3, attributes: {} }] },
        { id: 4, attributes: { popover: "" } },
      ],
    };

    markOpenPopovers(
      snapshot,
      idMirror([
        [menu, 2],
        [item, 3],
        [sub, 4],
      ]),
      document,
      POPOVER_OPEN_ATTRIBUTE,
      (popover) => (popover === sub ? item : null),
    );

    expect(snapshot.childNodes?.[0].attributes).toEqual({
      popover: "",
      [POPOVER_OPEN_ATTRIBUTE]: "",
    });
    expect(snapshot.childNodes?.[1].attributes).toEqual({
      popover: "",
      [POPOVER_OPEN_ATTRIBUTE]: "3",
    });
  });
});

describe("markTopLayerOrder", () => {
  it("marks each open popover and modal dialog with when it entered the top layer", () => {
    document.body.innerHTML = `
      <div popover="manual" id="toast"></div>
      <dialog id="modal"></dialog>
      <dialog id="plain"></dialog>
      <div popover id="closed"></div>
      <div popover id="unknown"></div>`;
    const element = (id: string) => document.getElementById(id)!;
    fakePopover(element("toast"), true);
    fakePopover(element("closed"), false);
    fakePopover(element("unknown"), true);
    // jsdom has no :modal; "plain" is open but not modal (show()).
    for (const id of ["modal", "plain"]) {
      const matches = element(id).matches.bind(element(id));
      Object.defineProperty(element(id), "matches", {
        value: (selector: string) => (selector === ":modal" ? id === "modal" : matches(selector)),
      });
    }
    const ids = ["toast", "modal", "plain", "closed", "unknown"];
    const snapshot: SerializedSnapshotNode = {
      id: 1,
      childNodes: ids.map((_, index) => ({ id: index + 2, attributes: {} })),
    };
    const orders = new Map([
      [element("toast"), 4],
      [element("modal"), 7],
      [element("plain"), 8],
      [element("closed"), 9],
    ]);

    markTopLayerOrder(
      snapshot,
      idMirror(ids.map((id, index) => [element(id), index + 2])),
      document,
      TOP_LAYER_ORDER_ATTRIBUTE,
      (target) => orders.get(target as HTMLElement),
    );

    expect(snapshot.childNodes?.map((node) => node.attributes)).toEqual([
      { [TOP_LAYER_ORDER_ATTRIBUTE]: "4" },
      { [TOP_LAYER_ORDER_ATTRIBUTE]: "7" },
      {},
      {},
      {},
    ]);
  });
});

describe("popoverToggleChange", () => {
  it("mirrors a recorded popover's current state as an attribute change", () => {
    document.body.innerHTML = `<div popover id="menu"></div>`;
    const menu = document.getElementById("menu")!;
    const popover = fakePopover(menu, true);
    const mirror = idMirror([[menu, 7]]);

    expect(popoverToggleChange(menu, mirror, POPOVER_OPEN_ATTRIBUTE, null)).toEqual({
      id: 7,
      attributes: { [POPOVER_OPEN_ATTRIBUTE]: "" },
    });
    // A coalesced open+close arrives as one toggle: the state wins, not the event.
    popover.setOpen(false);
    expect(popoverToggleChange(menu, mirror, POPOVER_OPEN_ATTRIBUTE, null)).toEqual({
      id: 7,
      attributes: { [POPOVER_OPEN_ATTRIBUTE]: null },
    });
  });

  it("records the invoker of an opening popover, and none once it closes", () => {
    document.body.innerHTML = `<button id="opener"></button><div popover id="menu"></div>`;
    const menu = document.getElementById("menu")!;
    const opener = document.getElementById("opener")!;
    const popover = fakePopover(menu, true);
    const mirror = idMirror([
      [opener, 5],
      [menu, 7],
    ]);

    expect(popoverToggleChange(menu, mirror, POPOVER_OPEN_ATTRIBUTE, opener)).toEqual({
      id: 7,
      attributes: { [POPOVER_OPEN_ATTRIBUTE]: "5" },
    });
    popover.setOpen(false);
    expect(popoverToggleChange(menu, mirror, POPOVER_OPEN_ATTRIBUTE, opener)).toEqual({
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

    expect(popoverToggleChange(details, mirror, POPOVER_OPEN_ATTRIBUTE, null)).toBeNull();
    expect(popoverToggleChange(unrecorded, mirror, POPOVER_OPEN_ATTRIBUTE, null)).toBeNull();
    expect(popoverToggleChange(null, mirror, POPOVER_OPEN_ATTRIBUTE, null)).toBeNull();
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

  // A model of the auto-popover stack: showing a popover hides every open one
  // that is not its popover ancestor — found through its DOM parents or, as in
  // the browser, through the invoker passed as `source`.
  function fakeAutoPopovers(ids: string[]) {
    const open = new Set<HTMLElement>();
    const elements = ids.map((id) => document.getElementById(id)!);
    const ancestorOf = (element: HTMLElement, source?: HTMLElement) => {
      for (const start of [element.parentElement, source]) {
        let node = start ?? null;
        while (node && !(open.has(node) && node !== element)) node = node.parentElement;
        if (node) return node;
      }
      return null;
    };
    type ShowPopover = (options?: { source?: HTMLElement }) => void;
    const shown = new Map<HTMLElement, ReturnType<typeof vi.fn<ShowPopover>>>();
    for (const element of elements) {
      const matches = element.matches.bind(element);
      Object.defineProperty(element, "matches", {
        value: (selector: string) =>
          selector === ":popover-open" ? open.has(element) : matches(selector),
      });
      const showPopover = vi.fn<ShowPopover>((options) => {
        const keep = new Set<HTMLElement>();
        for (let node = ancestorOf(element, options?.source); node; node = ancestorOf(node)) {
          keep.add(node);
        }
        // Deleting the entry being visited is safe while iterating a Set.
        for (const other of open) if (!keep.has(other)) open.delete(other);
        open.add(element);
      });
      shown.set(element, showPopover);
      Object.assign(element, { showPopover, hidePopover: () => open.delete(element) });
    }
    return {
      openIds: () => elements.filter((element) => open.has(element)).map((element) => element.id),
      showPopover: (id: string) => shown.get(document.getElementById(id)!)!,
    };
  }

  const fullSnapshot = { type: 2, timestamp: 0, data: {} } as unknown as eventWithTime;

  it("opens a popover from its recorded invoker, keeping the popover that invoker sits in open", () => {
    document.body.innerHTML = `
      <div popover id="menu" ${POPOVER_OPEN_ATTRIBUTE}><button id="item">Sub</button></div>
      <div popover id="sub"></div>`;
    const item = document.getElementById("item")!;
    const sub = document.getElementById("sub")!;
    const stack = fakeAutoPopovers(["menu", "sub"]);
    const plugin = createTopLayerReplayPlugin();
    const context = replayContext(
      document,
      new Map<number, Node>([
        [2, document.getElementById("menu")!],
        [3, item],
        [4, sub],
      ]),
    );
    plugin.handler?.(fullSnapshot, true, context);

    sub.setAttribute(POPOVER_OPEN_ATTRIBUTE, "3");
    plugin.handler?.(
      mutation([{ id: 4, attributes: { [POPOVER_OPEN_ATTRIBUTE]: "3" } }]),
      true,
      context,
    );

    expect(stack.showPopover("sub")).toHaveBeenCalledWith({ source: item });
    expect(stack.openIds()).toEqual(["menu", "sub"]);
  });

  it("rebuilds nested popovers parent first, whatever their document order", () => {
    // The submenu comes first in the document, and nests only via its invoker.
    document.body.innerHTML = `
      <div popover id="sub" ${POPOVER_OPEN_ATTRIBUTE}="3"></div>
      <div popover id="menu" ${POPOVER_OPEN_ATTRIBUTE}><button id="item">Sub</button></div>`;
    const stack = fakeAutoPopovers(["sub", "menu"]);
    const context = replayContext(document, new Map([[3, document.getElementById("item")!]]));

    createTopLayerReplayPlugin().handler?.(fullSnapshot, true, context);

    expect(stack.openIds()).toEqual(["sub", "menu"]);
  });

  it("falls back to a popovertarget button inside an open popover when no invoker was recorded", () => {
    document.body.innerHTML = `
      <button popovertarget="menu">Menu</button>
      <div popover id="sub" ${POPOVER_OPEN_ATTRIBUTE}></div>
      <div popover id="menu" ${POPOVER_OPEN_ATTRIBUTE}><button id="item" popovertarget="sub">Sub</button></div>`;
    const stack = fakeAutoPopovers(["sub", "menu"]);

    createTopLayerReplayPlugin().handler?.(fullSnapshot, true, replayContext(document));

    expect(stack.showPopover("sub")).toHaveBeenCalledWith({
      source: document.getElementById("item"),
    });
    expect(stack.showPopover("menu")).toHaveBeenCalledWith(undefined);
    expect(stack.openIds()).toEqual(["sub", "menu"]);
  });

  // A model of the top layer: its elements stack in the order they entered it.
  // As in the browser, showing an auto popover hides the hint popovers.
  function fakeTopLayer(ids: string[]) {
    const layer: HTMLElement[] = [];
    for (const id of ids) {
      const element = document.getElementById(id)!;
      const inLayer = () => layer.includes(element);
      const enter = () => layer.push(element);
      const leave = () => {
        if (inLayer()) layer.splice(layer.indexOf(element), 1);
      };
      const matches = element.matches.bind(element);
      Object.defineProperty(element, "matches", {
        value: (selector: string) => {
          if (selector === ":modal") return element.nodeName === "DIALOG" && inLayer();
          if (selector === ":popover-open") return element.hasAttribute("popover") && inLayer();
          return matches(selector);
        },
      });
      if (element.nodeName === "DIALOG") {
        const showModal = vi.fn<() => void>(() => {
          element.setAttribute("open", "");
          enter();
        });
        const close = vi.fn<() => void>(() => {
          // close() is a no-op unless the dialog has `open`.
          if (!element.hasAttribute("open")) return;
          element.removeAttribute("open");
          leave();
        });
        Object.assign(element, { showModal, close });
        continue;
      }
      const showPopover = () => {
        if (element.getAttribute("popover") === "") {
          for (let index = layer.length - 1; index >= 0; index -= 1) {
            if (layer[index].getAttribute("popover") === "hint") layer.splice(index, 1);
          }
        }
        enter();
      };
      Object.assign(element, { showPopover, hidePopover: leave });
    }
    return { ids: () => layer.map((element) => element.id) };
  }

  it("rebuilds the top layer in the recorded order, a toast under a later modal", () => {
    document.body.innerHTML = `
      <div popover="manual" id="toast" ${POPOVER_OPEN_ATTRIBUTE} ${TOP_LAYER_ORDER_ATTRIBUTE}="3"></div>
      <dialog id="late" rr_open_mode="modal" ${TOP_LAYER_ORDER_ATTRIBUTE}="9"></dialog>
      <dialog id="early" rr_open_mode="modal" ${TOP_LAYER_ORDER_ATTRIBUTE}="5"></dialog>`;
    const topLayer = fakeTopLayer(["toast", "late", "early"]);
    // rrweb's rebuild has shown the modal dialogs already, in document order.
    for (const id of ["late", "early"]) {
      (document.getElementById(id) as HTMLDialogElement).showModal();
    }

    createTopLayerReplayPlugin().handler?.(fullSnapshot, true, replayContext(document));

    expect(topLayer.ids()).toEqual(["toast", "early", "late"]);
  });

  it("rebuilds a hint popover shown after an auto popover still open", () => {
    // Showing the auto popover after the hint would close the hint again.
    document.body.innerHTML = `
      <div popover="hint" id="hint" ${POPOVER_OPEN_ATTRIBUTE} ${TOP_LAYER_ORDER_ATTRIBUTE}="2"></div>
      <div popover id="menu" ${POPOVER_OPEN_ATTRIBUTE} ${TOP_LAYER_ORDER_ATTRIBUTE}="1"></div>`;
    const topLayer = fakeTopLayer(["hint", "menu"]);

    createTopLayerReplayPlugin().handler?.(fullSnapshot, true, replayContext(document));

    expect(topLayer.ids()).toEqual(["menu", "hint"]);
  });

  it("keeps an unordered recording's placement: dialogs as rebuilt, popovers above", () => {
    document.body.innerHTML = `
      <div popover="manual" id="toast" ${POPOVER_OPEN_ATTRIBUTE}></div>
      <dialog id="dialog" rr_open_mode="modal"></dialog>`;
    const topLayer = fakeTopLayer(["toast", "dialog"]);
    const dialog = document.getElementById("dialog") as HTMLDialogElement;
    dialog.showModal();

    createTopLayerReplayPlugin().handler?.(fullSnapshot, true, replayContext(document));

    expect(topLayer.ids()).toEqual(["dialog", "toast"]);
    expect(dialog.close).not.toHaveBeenCalled();
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
