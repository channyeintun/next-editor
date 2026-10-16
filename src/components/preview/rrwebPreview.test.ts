import fc from "fast-check";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  loadRrwebRecorderBundle,
  PINNED_RRWEB_RECORD_VERSION,
  RRWEB_RECORDER_GZIP_BUDGET_BYTES,
} from "../../../build/rrwebRecorderBundlePlugin";
import type {
  PreviewDomPatchBatch,
  PreviewInitialDocument,
  PreviewRecordedEvent,
} from "../../types/slides";
import {
  buildRrwebReplayEvents,
  PREVIEW_RRWEB_FORMAT_VERSION,
  RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE,
  RUNTIME_PATCH_BATCH_MESSAGE_TYPE,
  RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE,
} from "./rrwebPreview";
import { createRrwebPreviewRecorderScript } from "./rrwebRecorderScript";
import { POPOVER_OPEN_ATTRIBUTE, TOP_LAYER_ORDER_ATTRIBUTE } from "./rrwebTopLayer";

function event(type: number, timestamp: number): PreviewRecordedEvent {
  return { type, timestamp, data: { tag: timestamp } };
}

function initialDocument(events: PreviewRecordedEvent[]): PreviewInitialDocument {
  return {
    version: 2,
    time: events[0]?.timestamp ?? 0,
    documentId: "doc-1",
    events,
  };
}

function patchBatch(events: PreviewRecordedEvent[]): PreviewDomPatchBatch {
  return {
    version: 2,
    time: events[0]?.timestamp ?? 0,
    source: "runtime-preview",
    documentId: "doc-1",
    events,
  };
}

describe("buildRrwebReplayEvents", () => {
  it("concatenates seed + incremental events sorted by timestamp", () => {
    const seed = initialDocument([event(4, 0), event(2, 1)]);
    const batchA = patchBatch([event(3, 5), event(3, 2)]);
    const batchB = patchBatch([event(3, 10)]);

    const events = buildRrwebReplayEvents([seed], [batchA, batchB]);

    expect(events.map((entry) => entry.timestamp)).toEqual([0, 1, 2, 5, 10]);
  });

  it("tolerates records without events", () => {
    const bare: PreviewInitialDocument = {
      version: 2,
      time: 0,
      documentId: "doc-1",
    };

    expect(buildRrwebReplayEvents([bare], [])).toEqual([]);
  });

  it("rebases events onto the recording clock, dropping the preview-clock offset", () => {
    // The preview iframe records on a raw Date.now() clock that sits far ahead of
    // the recording clock (audio warmup delays `startedAt`). Replay must follow the
    // recording clock while preserving the preview event deltas.
    const PREVIEW_BASE = 1_700_000_000_000;
    const seed: PreviewInitialDocument = {
      version: 2,
      time: 0,
      documentId: "doc-1",
      events: [event(4, PREVIEW_BASE), event(2, PREVIEW_BASE + 1)],
    };
    // No drift: the batch's preview-clock lead over its recording time matches
    // the seed's, so every event keeps its raw rrweb delta with the epoch-sized
    // lead removed.
    const batch: PreviewDomPatchBatch = {
      version: 2,
      time: 2200,
      source: "runtime-preview",
      documentId: "doc-1",
      events: [event(3, PREVIEW_BASE + 2200), event(3, PREVIEW_BASE + 2210)],
    };

    const events = buildRrwebReplayEvents([seed], [batch]);

    expect(events.map((entry) => entry.timestamp)).toEqual([0, 1, 2200, 2210]);
  });

  it("anchors on the largest preview-clock lead so replay never lags the recording clock", () => {
    // The preview clock's lead over the recording clock can grow mid-recording
    // (the recording clock stalls while the preview keeps ticking). Rebasing by
    // the origin segment's smaller lead would replay later segments late vs the
    // audio (see 88f8114 "Fix rrweb playback delay"); instead the largest lead
    // wins: that segment lands exactly on its recording time, and segments with
    // a smaller lead shift earlier, clamped at 0.
    const PREVIEW_BASE = 1_700_000_000_000;
    const seed: PreviewInitialDocument = {
      version: 2,
      time: 0,
      documentId: "doc-1",
      events: [event(4, PREVIEW_BASE), event(2, PREVIEW_BASE + 1)],
    };
    // Recorded 2200ms into the preview clock but only 500ms into the recording
    // clock — a 1700ms larger lead than the seed's.
    const batch: PreviewDomPatchBatch = {
      version: 2,
      time: 500,
      source: "runtime-preview",
      documentId: "doc-1",
      events: [event(3, PREVIEW_BASE + 2200), event(3, PREVIEW_BASE + 2210)],
    };

    const events = buildRrwebReplayEvents([seed], [batch]);

    // Batch anchored at its recording time (500); seed events clamp at 0.
    expect(events.map((entry) => entry.timestamp)).toEqual([0, 0, 500, 510]);
  });

  // An event's true recording time is its segment's `time` plus its distance from the
  // segment's first event. Events inside a segment need not be sorted: a batch can
  // carry stamps [5, 2].
  it("never places an event after its true recording time and keeps the gaps it does not clamp", () => {
    const PREVIEW_BASE = 1_700_000_000_000;
    const arbSegment = fc.record({
      time: fc.nat({ max: 5_000 }),
      firstStamp: fc.nat({ max: 5_000 }),
      offsets: fc.array(fc.integer({ min: -50, max: 400 }), { maxLength: 4 }),
      isSeed: fc.boolean(),
    });

    fc.assert(
      fc.property(fc.array(arbSegment, { maxLength: 6 }), (segments) => {
        // Each event carries its index as a tag, to find it again after the sort.
        const trueTimes: number[] = [];
        const rawStamps: number[] = [];
        const seeds: PreviewInitialDocument[] = [];
        const batches: PreviewDomPatchBatch[] = [];
        for (const { time, firstStamp, offsets, isSeed } of segments) {
          const first = PREVIEW_BASE + firstStamp;
          const events = [first, ...offsets.map((offset) => first + offset)].map((timestamp) => {
            const tag = rawStamps.length;
            trueTimes.push(time + timestamp - first);
            rawStamps.push(timestamp);
            return { type: 3, timestamp, data: { tag } };
          });
          if (isSeed) {
            seeds.push({ version: 2, time, documentId: "doc-1", events });
          } else {
            batches.push({
              version: 2,
              time,
              source: "runtime-preview",
              documentId: "doc-1",
              events,
            });
          }
        }

        const replayed = buildRrwebReplayEvents(seeds, batches);

        expect(replayed).toHaveLength(rawStamps.length);
        const placed = replayed.map((entry) => entry.timestamp);
        expect(placed).toEqual([...placed].sort((left, right) => left - right));
        const shifts = new Set<number>();
        for (const entry of replayed) {
          const { tag } = entry.data as { tag: number };
          expect(entry.timestamp).toBeLessThanOrEqual(Math.max(0, trueTimes[tag]));
          if (entry.timestamp > 0) shifts.add(rawStamps[tag] - entry.timestamp);
        }
        // Every event that was not clamped at 0 moved back by the same lead.
        expect(shifts.size).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe("createRrwebPreviewRecorderScript", () => {
  it("inlines the rrweb bundle and the recording wiring", () => {
    const script = createRrwebPreviewRecorderScript({ setupMarker: "__TEST_MARKER__" });

    // The recorder-only UMD bundle is present (sets window.rrwebRecord).
    expect(script).toContain("rrwebRecord");
    // The wiring records and forwards events.
    expect(script).toContain("window.rrwebRecord.record");
    expect(script).toContain("__TEST_MARKER__");
    expect(script).toContain(String(PREVIEW_RRWEB_FORMAT_VERSION));
    // Images must be baked into snapshots as data URLs: project-served image
    // URLs point at the ephemeral WebContainer origin and are dead in replay.
    expect(script).toContain("inlineImages: true");
    expect(script.length).toBeLessThan(150_000);
  });

  it("keeps the pinned injected recorder below its gzip budget", () => {
    const artifact = loadRrwebRecorderBundle();

    expect(artifact.version).toBe(PINNED_RRWEB_RECORD_VERSION);
    expect(artifact.gzipBytes).toBeLessThanOrEqual(RRWEB_RECORDER_GZIP_BUDGET_BYTES);
    expect(artifact.rawBytes).toBeLessThan(100_000);
  });
});

// Executes the full injected script (UMD bundle + wiring) in the test DOM and
// drives the host protocol with message events, verifying the recording-start
// snapshot handshake end to end. The finally block stops the recorder through the
// handle the wiring parks on its setup marker; the wiring's message listener
// stays, which is harmless (a stopped recorder refuses takeFullSnapshot).
describe("recorder wiring snapshot handshake", () => {
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  interface PostedMessage {
    type: string;
    payload: {
      documentId: string;
      refresh?: boolean;
      events?: PreviewRecordedEvent[];
    };
  }

  interface SerializedNode {
    id?: number;
    tagName?: string;
    attributes?: Record<string, string>;
    childNodes?: SerializedNode[];
  }

  function findSerializedById(
    node: SerializedNode | undefined,
    id: string,
  ): SerializedNode | undefined {
    if (!node) return undefined;
    if (node.attributes?.id === id) return node;
    for (const child of node.childNodes ?? []) {
      const match = findSerializedById(child, id);
      if (match) return match;
    }
    return undefined;
  }

  function fullSnapshotRoot(message: PostedMessage | undefined): SerializedNode | undefined {
    const fullSnapshot = message?.payload.events?.find((event) => event.type === 2);
    return (fullSnapshot?.data as { node?: SerializedNode } | undefined)?.node;
  }

  function findSerializedElement(
    node: SerializedNode | undefined,
    tagName: string,
  ): SerializedNode | undefined {
    if (!node) return undefined;
    if (node.tagName === tagName) return node;
    for (const child of node.childNodes ?? []) {
      const match = findSerializedElement(child, tagName);
      if (match) return match;
    }
    return undefined;
  }

  it("answers a host snapshot request with a refresh initial document, never a patch-stream snapshot", async () => {
    document.body.innerHTML = `
      <style>.accent { color: rgb(1, 2, 3); }</style>
      <main>
        <p id="status" class="accent">ready</p>
        <input id="name" value="Ada" />
        <img id="avatar" src="/avatar.png" />
      </main>`;
    const image = document.getElementById("avatar");
    if (!(image instanceof HTMLImageElement)) throw new Error("missing image fixture");
    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalHeight: { configurable: true, value: 1 },
      naturalWidth: { configurable: true, value: 1 },
    });
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage: vi.fn<() => void>() } as unknown as CanvasRenderingContext2D);
    const toDataUrl = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/png;base64,YXZhdGFy");

    const messages: PostedMessage[] = [];
    const onMessage = (event: MessageEvent) => {
      const data = event.data as PostedMessage | undefined;
      if (
        data?.type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE ||
        data?.type === RUNTIME_PATCH_BATCH_MESSAGE_TYPE
      ) {
        messages.push(data);
      }
    };
    window.addEventListener("message", onMessage);

    // The wiring batches patches on animation frames; jsdom only provides rAF
    // when pretending to be visual, so fall back to a timer.
    window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(0), 16);

    try {
      // Indirect eval so the bundle + wiring run at global scope, as they would
      // when inlined into the served preview page.
      // oxlint-disable-next-line no-eval -- running the served script is the point
      (0, eval)(createRrwebPreviewRecorderScript({ setupMarker: "__WIRING_TEST__" }));
      await sleep(50);

      const initialDocs = messages.filter(
        (message) => message.type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE,
      );
      expect(initialDocs).toHaveLength(1);
      expect(initialDocs[0].payload.refresh).toBeUndefined();
      const documentId = initialDocs[0].payload.documentId;
      const fullSnapshot = initialDocs[0].payload.events?.find((event) => event.type === 2);
      const serializedRoot = (fullSnapshot?.data as { node?: SerializedNode } | undefined)?.node;
      expect(findSerializedElement(serializedRoot, "style")?.attributes?._cssText).toContain(
        ".accent",
      );
      expect(findSerializedElement(serializedRoot, "input")?.attributes?.value).toBe("Ada");
      expect(findSerializedElement(serializedRoot, "img")?.attributes?.rr_dataURL).toBe(
        "data:image/png;base64,YXZhdGFy",
      );
      // Images are encoded as WebP rather than rrweb's default PNG.
      expect(toDataUrl).toHaveBeenCalledWith("image/webp", 0.9);

      const findRefreshDocs = () =>
        messages.filter(
          (message) =>
            message.type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE && message.payload.refresh,
        );

      // Only the host may ask: jsdom delivers window.postMessage with a null
      // source, i.e. from a window that is not this page's parent.
      window.postMessage({ type: RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE }, "*");
      await sleep(50);
      expect(findRefreshDocs()).toHaveLength(0);

      // Host asks for the recording-start snapshot (jsdom's top window is its
      // own parent).
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE },
          source: window,
        }),
      );
      await sleep(50);

      const refreshDocs = findRefreshDocs();
      expect(refreshDocs).toHaveLength(1);
      expect(refreshDocs[0].payload.documentId).toBe(documentId);
      // The answer carries a FullSnapshot (type 2) so it can seed replay.
      expect(refreshDocs[0].payload.events?.some((event) => event.type === 2)).toBe(true);

      // Prove the patch stream is alive, then confirm the snapshot was diverted
      // out of it: mutations flow as patches, FullSnapshots do not.
      const status = document.getElementById("status");
      if (!status) throw new Error("missing fixture node");
      status.textContent = "mutated";
      const input = document.getElementById("name");
      if (!(input instanceof HTMLInputElement)) throw new Error("missing input fixture");
      input.value = "Grace";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(100);

      const patchBatches = messages.filter(
        (message) => message.type === RUNTIME_PATCH_BATCH_MESSAGE_TYPE,
      );
      expect(patchBatches.length).toBeGreaterThan(0);
      const patchEvents = patchBatches.flatMap((message) => message.payload.events ?? []);
      expect(patchEvents.some((event) => event.type === 2)).toBe(false);
      expect(
        patchEvents.some(
          (event) =>
            event.type === 3 &&
            (event.data as { source?: number; text?: string }).source === 5 &&
            (event.data as { text?: string }).text === "Grace",
        ),
      ).toBe(true);
    } finally {
      // Detach the recorder via the stop handle the wiring parks on its setup
      // marker, so its observers don't outlive the test environment.
      const marker = (window as unknown as Record<string, { stop?: () => void } | boolean>)
        .__WIRING_TEST__;
      if (typeof marker === "object" && typeof marker.stop === "function") {
        marker.stop();
      }
      getContext.mockRestore();
      toDataUrl.mockRestore();
      window.removeEventListener("message", onMessage);
    }
  });

  // A popover opens in the top layer without a DOM mutation, so rrweb alone
  // records nothing; the wiring mirrors it as a replay-only attribute.
  it("records popover open state on every FullSnapshot and on each toggle, never on the live DOM", async () => {
    document.body.innerHTML = `
      <div popover id="menu">Menu</div>
      <div popover="manual" id="tip">Tip</div>
      <button id="opener" popovertarget="tip">Open tip</button>`;
    // jsdom has no popover top layer: each popover carries its own state.
    const openState = new Map<string, boolean>([
      ["menu", true],
      ["tip", false],
    ]);
    for (const id of openState.keys()) {
      const element = document.getElementById(id);
      if (!element) throw new Error("missing popover fixture");
      const matches = element.matches.bind(element);
      Object.defineProperty(element, "matches", {
        value: (selector: string) =>
          selector === ":popover-open" ? openState.get(id) === true : matches(selector),
      });
    }
    const tip = document.getElementById("tip")!;
    const menu = document.getElementById("menu")!;

    const messages: PostedMessage[] = [];
    const onMessage = (event: MessageEvent) => {
      const data = event.data as PostedMessage | undefined;
      if (
        data?.type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE ||
        data?.type === RUNTIME_PATCH_BATCH_MESSAGE_TYPE
      ) {
        messages.push(data);
      }
    };
    window.addEventListener("message", onMessage);
    window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(0), 16);

    try {
      // oxlint-disable-next-line no-eval -- running the served script is the point
      (0, eval)(createRrwebPreviewRecorderScript({ setupMarker: "__POPOVER_WIRING_TEST__" }));
      await sleep(50);

      const [seed] = messages.filter(
        (message) => message.type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE,
      );
      // An earlier test's wiring may still be listening; keep to this one.
      const documentId = seed.payload.documentId;
      const ownPatchEvents = () =>
        messages
          .filter(
            (message) =>
              message.type === RUNTIME_PATCH_BATCH_MESSAGE_TYPE &&
              message.payload.documentId === documentId,
          )
          .flatMap((message) => message.payload.events ?? []);
      const seedRoot = fullSnapshotRoot(seed);
      expect(findSerializedById(seedRoot, "menu")?.attributes?.[POPOVER_OPEN_ATTRIBUTE]).toBe("");
      expect(findSerializedById(seedRoot, "tip")?.attributes).not.toHaveProperty(
        POPOVER_OPEN_ATTRIBUTE,
      );
      const tipId = findSerializedById(seedRoot, "tip")?.id;
      const menuId = findSerializedById(seedRoot, "menu")?.id;

      const openerId = findSerializedById(seedRoot, "opener")?.id;

      // The invoker rides along (ToggleEvent.source), so replay can nest it.
      openState.set("tip", true);
      const opened = new Event("toggle");
      Object.defineProperty(opened, "source", { value: document.getElementById("opener") });
      tip.dispatchEvent(opened);
      openState.set("menu", false);
      menu.dispatchEvent(new Event("toggle"));
      await sleep(50);

      const changes = ownPatchEvents()
        .filter((event) => event.type === 3)
        .flatMap(
          (event) =>
            (event.data as { attributes?: { id: number; attributes: object }[] }).attributes ?? [],
        );
      expect(changes).toEqual([
        { id: tipId, attributes: { [POPOVER_OPEN_ATTRIBUTE]: String(openerId) } },
        { id: menuId, attributes: { [POPOVER_OPEN_ATTRIBUTE]: null } },
      ]);
      // The mirror lives only in the recording, not on the author's page.
      expect(tip.hasAttribute(POPOVER_OPEN_ATTRIBUTE)).toBe(false);

      // The host's recording-start snapshot carries the state as of now.
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE },
          source: window,
        }),
      );
      await sleep(50);
      const refresh = messages.find(
        (message) =>
          message.type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE &&
          message.payload.refresh &&
          message.payload.documentId === documentId,
      );
      const refreshRoot = fullSnapshotRoot(refresh);
      // The snapshot renumbers nodes; the invoker is looked up afresh.
      expect(findSerializedById(refreshRoot, "tip")?.attributes?.[POPOVER_OPEN_ATTRIBUTE]).toBe(
        String(findSerializedById(refreshRoot, "opener")?.id),
      );
      expect(findSerializedById(refreshRoot, "menu")?.attributes).not.toHaveProperty(
        POPOVER_OPEN_ATTRIBUTE,
      );
    } finally {
      const marker = (window as unknown as Record<string, { stop?: () => void } | boolean>)
        .__POPOVER_WIRING_TEST__;
      if (typeof marker === "object" && typeof marker.stop === "function") {
        marker.stop();
      }
      window.removeEventListener("message", onMessage);
    }
  });

  // The top layer stacks in the order its elements entered it, which a rebuild
  // from a FullSnapshot cannot see; every snapshot records that order.
  it("records the order popovers and modal dialogs entered the top layer on each FullSnapshot", async () => {
    document.body.innerHTML = `
      <dialog id="modal">Modal</dialog>
      <div popover="manual" id="toast">Toast</div>`;
    // jsdom has no top layer: each element carries its own state.
    const inTopLayer = new Set<string>();
    for (const [id, selector] of [
      ["modal", ":modal"],
      ["toast", ":popover-open"],
    ]) {
      const element = document.getElementById(id)!;
      const matches = element.matches.bind(element);
      Object.defineProperty(element, "matches", {
        value: (query: string) => (query === selector ? inTopLayer.has(id) : matches(query)),
      });
    }
    // The browser fires beforetoggle just before the element enters.
    const enterTopLayer = (id: string) => {
      const beforeToggle = new Event("beforetoggle");
      Object.defineProperty(beforeToggle, "newState", { value: "open" });
      document.getElementById(id)!.dispatchEvent(beforeToggle);
      inTopLayer.add(id);
    };

    const messages: PostedMessage[] = [];
    const onMessage = (event: MessageEvent) => {
      const data = event.data as PostedMessage | undefined;
      if (data?.type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE) messages.push(data);
    };
    window.addEventListener("message", onMessage);
    window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(0), 16);

    try {
      // oxlint-disable-next-line no-eval -- running the served script is the point
      (0, eval)(createRrwebPreviewRecorderScript({ setupMarker: "__TOP_LAYER_WIRING_TEST__" }));
      await sleep(50);
      // An earlier test's wiring may still be listening; keep to this one.
      const { documentId } = messages[0].payload;
      const takeSnapshot = async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE },
            source: window,
          }),
        );
        await sleep(50);
        const refresh = messages.findLast(
          (message) => message.payload.refresh && message.payload.documentId === documentId,
        );
        const root = fullSnapshotRoot(refresh);
        return (id: string) =>
          Number(findSerializedById(root, id)?.attributes?.[TOP_LAYER_ORDER_ATTRIBUTE]);
      };

      // A toast, then a modal dialog over it.
      enterTopLayer("toast");
      enterTopLayer("modal");
      const first = await takeSnapshot();
      expect(first("toast")).toBeGreaterThan(0);
      expect(first("modal")).toBeGreaterThan(first("toast"));

      // The toast shows again: now it is the topmost.
      enterTopLayer("toast");
      const second = await takeSnapshot();
      expect(second("toast")).toBeGreaterThan(second("modal"));
      // The order lives only in the recording, not on the author's page.
      expect(document.getElementById("toast")!.hasAttribute(TOP_LAYER_ORDER_ATTRIBUTE)).toBe(false);
    } finally {
      const marker = (window as unknown as Record<string, { stop?: () => void } | boolean>)
        .__TOP_LAYER_WIRING_TEST__;
      if (typeof marker === "object" && typeof marker.stop === "function") {
        marker.stop();
      }
      window.removeEventListener("message", onMessage);
    }
  });
});
