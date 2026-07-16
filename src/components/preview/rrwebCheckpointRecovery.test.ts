import { record, Replayer } from "rrweb";
import type { eventWithTime } from "rrweb";
import { afterEach, describe, expect, it } from "vitest";
import type { PreviewRecordedEvent } from "../../types/slides";
import {
  buildRrwebReplayEvents,
  collectStaleMirrorNodeIds,
  createRrwebPreviewRecorderScript,
  type RrwebRecordingMirror,
} from "./rrwebPreview";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let stopRecording: (() => void) | undefined;
let activeReplayer: Replayer | undefined;
const containers: HTMLElement[] = [];

afterEach(() => {
  stopRecording?.();
  stopRecording = undefined;
  activeReplayer?.destroy();
  activeReplayer = undefined;
  for (const container of containers.splice(0)) {
    container.remove();
  }
  document.body.innerHTML = "";
});

// htmx innerHTML swap shape: append the new node, drop the old ones.
function swap(result: Element, label: string): void {
  const old = Array.from(result.childNodes);
  const p = document.createElement("p");
  p.textContent = label;
  result.appendChild(p);
  for (const node of old) result.removeChild(node);
}

// Simulate rrweb's real-browser capture bug: drop every other Mutation that
// carries removes, leaving the corresponding adds in place.
function dropAlternatingRemoves(events: PreviewRecordedEvent[]): PreviewRecordedEvent[] {
  let seen = 0;
  return events.map((entry) => {
    const event = entry as unknown as {
      type: number;
      data?: { source?: number; removes?: unknown[] };
    };
    if (event.type === 3 && event.data?.source === 0 && (event.data.removes?.length ?? 0) > 0) {
      const drop = seen % 2 === 0;
      seen += 1;
      if (drop) {
        return {
          ...event,
          data: { ...event.data, removes: [] },
        } as unknown as PreviewRecordedEvent;
      }
    }
    return entry;
  });
}

function replayFinalParagraphCount(events: PreviewRecordedEvent[]): number {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);

  activeReplayer = new Replayer(events as unknown as eventWithTime[], {
    root: container,
    liveMode: false,
    mouseTail: false,
    showWarning: false,
    useVirtualDom: false,
    speed: 1,
    UNSAFE_replayCanvas: true,
  });
  activeReplayer.pause(10_000_000);

  return (
    container
      .querySelector("iframe")
      ?.contentDocument?.getElementById("result")
      ?.querySelectorAll("p").length ?? -1
  );
}

// A throwaway mirror over a fixed id→node map, for unit-testing the drift scan
// without a live rrweb recorder.
function fakeMirror(entries: Array<[number, Node]>): RrwebRecordingMirror {
  const map = new Map(entries);
  return {
    getIds: () => Array.from(map.keys()),
    getNode: (id) => map.get(id) ?? null,
  };
}

describe("collectStaleMirrorNodeIds", () => {
  it("returns nothing when every tracked node is still connected", () => {
    document.body.innerHTML = `<main><p id="a">a</p><p id="b">b</p></main>`;
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    const mirror = fakeMirror([
      [1, document],
      [2, a],
      [3, b],
    ]);
    expect(collectStaleMirrorNodeIds(mirror, document)).toEqual([]);
  });

  it("flags only the ids whose nodes have been detached from the document", () => {
    document.body.innerHTML = `<main><p id="a">a</p><p id="b">b</p></main>`;
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    const orphan = document.createElement("p"); // never inserted
    // Mirror still tracks `a` after it leaves the live DOM (a dropped remove).
    a.remove();
    const mirror = fakeMirror([
      [1, document],
      [2, a],
      [3, b],
      [4, orphan],
    ]);
    // The document node itself is never flagged; only the detached nodes are.
    expect(collectStaleMirrorNodeIds(mirror, document).sort()).toEqual([2, 4]);
  });

  it("a corrective snapshot without a mirror reset leaves the drift in place (storm risk)", async () => {
    document.body.innerHTML = `<main><div id="result"><p id="x">old</p></div></main>`;
    stopRecording = record({
      emit: () => {},
      inlineStylesheet: true,
      slimDOMOptions: { script: true, comment: true },
    });
    await sleep(20);

    const mirror = (record as unknown as { mirror: RrwebRecordingMirror & { reset(): void } })
      .mirror;
    const x = document.getElementById("x")!;
    // Synchronous window: remove x but snapshot before rrweb's MutationObserver
    // processes the removal — the exact state a dropped remove leaves behind.
    x.remove();
    expect(collectStaleMirrorNodeIds(mirror, document).length).toBeGreaterThan(0);

    // takeFullSnapshot reuses ids and never prunes the dropped node, so the drift
    // survives — every later mutation would retrigger a snapshot (a storm).
    record.takeFullSnapshot();
    expect(collectStaleMirrorNodeIds(mirror, document).length).toBeGreaterThan(0);

    // Resetting the mirror before the snapshot rebuilds it from the live DOM, so
    // the dropped node is gone and no further snapshots are provoked.
    mirror.reset();
    record.takeFullSnapshot();
    expect(collectStaleMirrorNodeIds(mirror, document)).toEqual([]);
  });

  it("replays to the correct single line after a mid-stream reset + corrective snapshot", async () => {
    document.body.innerHTML = `<main><div id="result"></div></main>`;
    const events: PreviewRecordedEvent[] = [];
    stopRecording = record({
      emit: (event) => events.push(event as unknown as PreviewRecordedEvent),
      inlineStylesheet: true,
      slimDOMOptions: { script: true, comment: true },
    });
    await sleep(20);

    const result = document.getElementById("result")!;
    const mirror = (record as unknown as { mirror: { reset(): void } }).mirror;

    swap(result, "one");
    await sleep(20);
    // Mimic the recorder's corrective path: reset the mirror, then snapshot. The
    // snapshot's nodes therefore carry freshly renumbered ids mid-stream.
    mirror.reset();
    record.takeFullSnapshot();
    await sleep(20);
    swap(result, "two");
    await sleep(20);

    stopRecording?.();
    stopRecording = undefined;
    expect(result.querySelectorAll("p").length).toBe(1);

    // Seed = the very first Meta + FullSnapshot; everything after (incl. the
    // mid-stream reset snapshot and the renumbered incrementals) is the patch batch.
    let seeded = false;
    const seed: PreviewRecordedEvent[] = [];
    const rest: PreviewRecordedEvent[] = [];
    for (const event of events) {
      const type = (event as { type: number }).type;
      if (!seeded) {
        seed.push(event);
        if (type === 2) seeded = true;
        continue;
      }
      rest.push(event);
    }

    const replayEvents = buildRrwebReplayEvents(
      [{ version: 2, time: 0, documentId: "d", events: seed }],
      [{ version: 2, time: 1, source: "runtime-preview", documentId: "d", events: rest }],
    );
    expect(replayFinalParagraphCount(replayEvents as unknown as PreviewRecordedEvent[])).toBe(1);
  });

  it("detects drift in a real rrweb recorder mirror when a remove is not captured", async () => {
    document.body.innerHTML = `<main><div id="result"><p>seed</p></div></main>`;

    const events: PreviewRecordedEvent[] = [];
    stopRecording = record({
      emit: (event) => events.push(event as unknown as PreviewRecordedEvent),
      inlineStylesheet: true,
      slimDOMOptions: { script: true, comment: true },
    });
    await sleep(20);

    const mirror = (record as unknown as { mirror: RrwebRecordingMirror }).mirror;
    // Clean DOM → no drift, so the recorder would take zero checkpoints.
    expect(collectStaleMirrorNodeIds(mirror, document)).toEqual([]);

    // Stop the recorder, then remove a node so rrweb never processes the removal —
    // exactly the state left behind by a dropped remove. The mirror still maps it.
    const seed = document.querySelector("#result p")!;
    stopRecording?.();
    stopRecording = undefined;
    seed.remove();

    const stale = collectStaleMirrorNodeIds(mirror, document);
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every((id) => mirror.getNode(id) !== document)).toBe(true);
  });
});

describe("corrective checkpoint recovery", () => {
  it("wires a drift-gated FullSnapshot checkpoint into the recorder", () => {
    const script = createRrwebPreviewRecorderScript({ setupMarker: "__CHK__" });
    expect(script).toContain("takeFullSnapshot");
    expect(script).toContain("scheduleCheckpoint");
    // The snapshot is gated on detected drift, not taken after every mutation.
    expect(script).toContain("collectStaleMirrorNodeIds");
    expect(script).toContain("record.mirror");
  });

  // Replay must rebuild from periodic checkpoint snapshots so that removes the
  // recorder failed to capture (the htmx "stacking" bug) do not accumulate.
  it("heals dropped removes when checkpoints are present, stacks without them", async () => {
    document.body.innerHTML = `<main><div id="result"></div></main>`;

    const events: PreviewRecordedEvent[] = [];
    stopRecording = record({
      emit: (event) => events.push(event as unknown as PreviewRecordedEvent),
      inlineStylesheet: true,
      slimDOMOptions: { script: true, comment: true },
    });
    await sleep(20);

    const result = document.getElementById("result");
    if (!result) {
      throw new Error("missing #result");
    }

    // Ten "get server time" swaps; a corrective checkpoint after each settles.
    for (let index = 1; index <= 10; index += 1) {
      swap(result, `Server time: ${index}`);
      await sleep(20);
      record.takeFullSnapshot();
      await sleep(20);
    }
    stopRecording?.();
    stopRecording = undefined;

    expect(result.querySelectorAll("p").length).toBe(1);

    const seed = events.filter(
      (e) => (e as { type: number }).type === 2 || (e as { type: number }).type === 4,
    );

    // A checkpoint full snapshot was emitted beyond the initial one.
    expect(events.filter((e) => (e as { type: number }).type === 2).length).toBeGreaterThan(1);

    const corrupted = dropAlternatingRemoves(events);

    // With the checkpoints kept, replay rebuilds to the true single line.
    const withCheckpoints = buildRrwebReplayEvents(
      [
        {
          version: 2,
          time: 0,
          documentId: "d",
          events: corrupted
            .filter((e) => (e as { type: number }).type === 4 || (e as { type: number }).type === 2)
            .slice(0, 2),
        },
      ],
      // Keep everything (incl. checkpoints) in the patch stream after the seed.
      [
        {
          version: 2,
          time: 1,
          source: "runtime-preview",
          documentId: "d",
          events: corrupted.slice(2),
        },
      ],
    );
    expect(replayFinalParagraphCount(withCheckpoints as unknown as PreviewRecordedEvent[])).toBe(1);

    // Control: strip the checkpoint snapshots → the dropped removes stack up.
    const checkpointsRemoved = corrupted.filter(
      (e, i) => i < 2 || ((e as { type: number }).type !== 2 && (e as { type: number }).type !== 4),
    );
    const noCheckpoints = buildRrwebReplayEvents(
      [{ version: 2, time: 0, documentId: "d", events: seed.slice(0, 2) }],
      [
        {
          version: 2,
          time: 1,
          source: "runtime-preview",
          documentId: "d",
          events: checkpointsRemoved.slice(2),
        },
      ],
    );
    expect(
      replayFinalParagraphCount(noCheckpoints as unknown as PreviewRecordedEvent[]),
    ).toBeGreaterThan(1);
  });

  // The recorder fires the checkpoint on a microtask so the snapshot lands in the
  // SAME batch (timestamp) as the swap. When that holds, a dropped remove is never
  // visible at any seek point — the stale add and the rebuild apply together.
  it("never shows a stacking frame when the checkpoint shares the swap's batch", async () => {
    document.body.innerHTML = `<main><div id="result"></div></main>`;

    const events: PreviewRecordedEvent[] = [];
    stopRecording = record({
      emit: (event) => events.push(event as unknown as PreviewRecordedEvent),
      inlineStylesheet: true,
      slimDOMOptions: { script: true, comment: true },
    });
    await sleep(20);

    const result = document.getElementById("result");
    if (!result) {
      throw new Error("missing #result");
    }

    // Each "swap + same-microtask checkpoint" is one recorded segment. Record the
    // event index spans so we can bundle each into a single batch (one timestamp).
    const seedCount = events.length;
    const swapSpans: { start: number; end: number }[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const start = events.length;
      swap(result, `Server time: ${index}`);
      record.takeFullSnapshot(); // same task → shares the swap's timestamp/batch
      swapSpans.push({ start, end: events.length });
      await sleep(20);
    }
    stopRecording?.();
    stopRecording = undefined;

    const corrupted = dropAlternatingRemoves(events);

    // One batch per swap-segment, all events in it sharing a single recording time.
    const patchBatches = swapSpans.map((span, i) => ({
      version: 2 as const,
      time: 100 + i * 100,
      source: "runtime-preview" as const,
      documentId: "d",
      events: corrupted.slice(span.start, span.end),
    }));
    const replayEvents = buildRrwebReplayEvents(
      [{ version: 2, time: 0, documentId: "d", events: corrupted.slice(0, seedCount) }],
      patchBatches,
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    activeReplayer = new Replayer(replayEvents as unknown as eventWithTime[], {
      root: container,
      liveMode: false,
      mouseTail: false,
      showWarning: false,
      useVirtualDom: false,
      speed: 1,
      UNSAFE_replayCanvas: true,
    });

    // Sweep the whole timeline at fine granularity: no seek point shows >1 line.
    let maxParagraphs = 0;
    for (let t = 0; t <= 800; t += 5) {
      activeReplayer.pause(t);
      const count =
        container
          .querySelector("iframe")
          ?.contentDocument?.getElementById("result")
          ?.querySelectorAll("p").length ?? 0;
      maxParagraphs = Math.max(maxParagraphs, count);
    }
    expect(maxParagraphs).toBe(1);
  });
});
