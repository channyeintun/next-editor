import { record } from "@rrweb/record";
import { Replayer } from "@rrweb/replay";
import type { eventWithTime } from "@rrweb/types";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { PreviewRecordedEvent } from "../../types/slides";
import { RrwebPreviewReplayer } from "./rrwebPreviewReplayer";

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

function rowIndices(doc: Document | null | undefined): string[] {
  return Array.from(doc?.querySelectorAll(".row") ?? []).map(
    (row) => row.getAttribute("data-index") ?? "?",
  );
}

function createReplayer(events: eventWithTime[], root: HTMLElement): Replayer {
  return new Replayer(events, {
    root,
    liveMode: false,
    mouseTail: false,
    showWarning: false,
    useVirtualDom: false,
    speed: 1,
    UNSAFE_replayCanvas: true,
  });
}

// Characterizes how repeated pause(offset) (the per-tick driving model) applies
// removes across multiple recorded frames and across a fresh second playback.
describe("rrweb seek driving (per-tick pause)", () => {
  it("applies removes forward and backward, then starts the second playback cleanly", async () => {
    document.body.innerHTML = `
      <div id="timeline">
        <div class="row" data-index="0">post 0</div>
        <div class="row" data-index="1">post 1</div>
      </div>
    `;

    const events: PreviewRecordedEvent[] = [];
    stopRecording = record({
      emit: (event) => events.push(event as unknown as PreviewRecordedEvent),
      inlineStylesheet: true,
      slimDOMOptions: { script: true, comment: true },
    });
    await sleep(30);

    const timeline = document.getElementById("timeline");
    if (!timeline) {
      throw new Error("missing #timeline");
    }

    // Frame B: drop row 0, add rows 2,3.
    timeline.querySelector('[data-index="0"]')?.remove();
    for (const index of [2, 3]) {
      const row = document.createElement("div");
      row.className = "row";
      row.setAttribute("data-index", String(index));
      row.textContent = `post ${index}`;
      timeline.appendChild(row);
    }
    await sleep(40);
    const frameBTimestamp = events[events.length - 1].timestamp;

    // Frame C: drop row 1, add rows 4,5.
    timeline.querySelector('[data-index="1"]')?.remove();
    for (const index of [4, 5]) {
      const row = document.createElement("div");
      row.className = "row";
      row.setAttribute("data-index", String(index));
      row.textContent = `post ${index}`;
      timeline.appendChild(row);
    }
    await sleep(40);

    const baseTimestamp = events[0].timestamp;
    const offsetAfterB = frameBTimestamp - baseTimestamp + 1;

    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);

    activeReplayer = createReplayer(events as unknown as eventWithTime[], container);
    await sleep(0);

    const replayedDoc = () => container.querySelector("iframe")?.contentDocument;

    // Forward to frame B: row 0 removed, rows 1,2,3 present.
    activeReplayer.pause(offsetAfterB);
    await sleep(0);
    expect(rowIndices(replayedDoc()).sort()).toEqual(["1", "2", "3"]);

    // Forward to end: rows 0 and 1 removed, rows 2,3,4,5 present.
    activeReplayer.pause(10_000_000);
    await sleep(0);
    expect(rowIndices(replayedDoc()).sort()).toEqual(["2", "3", "4", "5"]);

    // Backward to frame B: row 1 back, rows 4,5 gone.
    activeReplayer.pause(offsetAfterB);
    await sleep(0);
    expect(rowIndices(replayedDoc()).sort()).toEqual(["1", "2", "3"]);

    // rrweb's pause(0) does not rebuild a used Replayer's initial snapshot. The
    // production wrapper therefore replaces it when playback returns to start.
    activeReplayer.destroy();
    activeReplayer = undefined;
    container.replaceChildren();
    activeReplayer = createReplayer(events as unknown as eventWithTime[], container);
    await sleep(5);
    expect(rowIndices(replayedDoc()).sort()).toEqual(["0", "1"]);

    activeReplayer.pause(10_000_000);
    await sleep(0);
    expect(rowIndices(replayedDoc()).sort()).toEqual(["2", "3", "4", "5"]);
  });
});

// The production wrapper with the jsdom rebuild guard bypassed (see replayDirect
// in rrwebRoundTrip.test.ts), counting the seeks that reach rrweb.
class CountingReplayer extends Replayer {
  static pauseCalls = 0;

  constructor(events: eventWithTime[], config: ConstructorParameters<typeof Replayer>[1]) {
    super(events, { ...config, UNSAFE_replayCanvas: true });
  }

  override pause(timeOffset?: number): void {
    CountingReplayer.pauseCalls += 1;
    super.pause(timeOffset);
  }
}

// Records a page that swaps its only row for the next one four times (a remove
// and an add each), with a MouseMove just after each swap whose first position
// was sampled before it, as rrweb's recorder batches pointer positions.
async function recordRowSwaps(): Promise<eventWithTime[]> {
  document.body.innerHTML = `<div id="timeline"><div class="row" data-index="0">post 0</div></div>`;

  const recorded: PreviewRecordedEvent[] = [];
  stopRecording = record({
    emit: (event) => recorded.push(event as unknown as PreviewRecordedEvent),
    slimDOMOptions: { script: true, comment: true },
  });
  await sleep(20);

  const timeline = document.getElementById("timeline");
  if (!timeline) {
    throw new Error("missing #timeline");
  }

  for (let index = 1; index <= 4; index += 1) {
    timeline.firstElementChild?.remove();
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("data-index", String(index));
    row.textContent = `post ${index}`;
    timeline.appendChild(row);
    await sleep(40);
  }
  stopRecording?.();
  stopRecording = undefined;

  const swapTimes = recorded.filter((event) => event.type === 3).map((event) => event.timestamp);
  return [
    ...recorded,
    ...swapTimes.map((timestamp) => ({
      type: 3,
      timestamp: timestamp + 5,
      data: { source: 1, positions: [{ x: 1, y: 1, id: 1, timeOffset: -20 }] },
    })),
  ].sort((left, right) => left.timestamp - right.timestamp) as unknown as eventWithTime[];
}

const replayedBody = (container: HTMLElement) =>
  container.querySelector("iframe")?.contentDocument?.body?.innerHTML;

// The expected DOM at an offset: a fresh Replayer seeked straight there, which
// only changes once the offset crosses another event.
function freshBodies(events: eventWithTime[]): (offset: number) => string | undefined {
  const bodies = new Map<number, string | undefined>();
  return (offset) => {
    const crossed = events.filter((event) => event.timestamp < events[0].timestamp + offset).length;
    if (!bodies.has(crossed)) {
      const freshRoot = document.createElement("div");
      document.body.append(freshRoot);
      const fresh = createReplayer(structuredClone(events), freshRoot);
      fresh.pause(offset);
      bodies.set(crossed, replayedBody(freshRoot));
      fresh.destroy();
      freshRoot.remove();
    }
    return bodies.get(crossed);
  };
}

function mountReplayRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  containers.push(root);
  return root;
}

describe("rrweb preview replayer per-tick driving", () => {
  it("reaches the DOM of a fresh seek on every tick, through MouseMoves and a seek back", async () => {
    const events = await recordRowSwaps();
    const removeCounts = () =>
      events.map((event) => (event.data as { removes?: unknown[] }).removes?.length);
    const recordedRemoveCounts = removeCounts();

    const root = mountReplayRoot();
    CountingReplayer.pauseCalls = 0;
    const preview = new RrwebPreviewReplayer({ root, events }, CountingReplayer);
    await sleep(5);

    const firstEventTime = events[0].timestamp;
    const endOffset = events[events.length - 1].timestamp - firstEventTime + 50;
    const midOffset = Math.round(endOffset / 2);
    // Forward at 4ms ticks, then back to the middle and forward again.
    const offsets: number[] = [];
    for (let offset = 4; offset <= endOffset; offset += 4) offsets.push(offset);
    for (let offset = midOffset; offset <= endOffset; offset += 4) offsets.push(offset);

    const freshBody = freshBodies(events);
    for (const offset of offsets) {
      preview.seekToRecordingTime(firstEventTime + offset);
      expect(replayedBody(root), `at offset ${offset}`).toBe(freshBody(offset));
    }

    expect(rowIndices(root.querySelector("iframe")?.contentDocument)).toEqual(["4"]);
    // rrweb drops removes it re-casts after their node is gone; none were re-cast.
    expect(removeCounts()).toEqual(recordedRemoveCounts);
    // Only the first seek, the move back, and ticks that cross an event reach
    // rrweb: at most every event once per pass, against 60+ ticks.
    expect(CountingReplayer.pauseCalls).toBeLessThanOrEqual(2 * events.length + 2);
    preview.destroy();
  });

  it("reaches the same DOM when the stream's tail is appended mid-playback", async () => {
    const events = await recordRowSwaps();
    // Split between two distinct times, as a streamed delta lands after the last
    // event already built.
    let split = Math.floor(events.length / 2);
    while (events[split].timestamp === events[split - 1].timestamp) split += 1;
    const head = events.slice(0, split);
    const tail = events.slice(split);

    const root = mountReplayRoot();
    const preview = new RrwebPreviewReplayer({ root, events: head }, CountingReplayer);
    await sleep(5);

    const firstEventTime = events[0].timestamp;
    const endOffset = events[events.length - 1].timestamp - firstEventTime + 50;
    const freshBody = freshBodies(events);
    let offset = 4;
    for (; firstEventTime + offset <= tail[1].timestamp; offset += 4) {
      preview.seekToRecordingTime(firstEventTime + offset);
    }
    // Playback ran past the first tail events before they arrived: rrweb casts
    // those on arrival, and later ones as the clock crosses them.
    expect(preview.appendEvents(structuredClone(tail))).toBe(true);
    for (; offset <= endOffset; offset += 4) {
      preview.seekToRecordingTime(firstEventTime + offset);
      // rrweb adds events on a microtask.
      await sleep(0);
      expect(replayedBody(root), `at offset ${offset}`).toBe(freshBody(offset));
    }

    expect(rowIndices(root.querySelector("iframe")?.contentDocument)).toEqual(["4"]);
    preview.destroy();
  });
});
