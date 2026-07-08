import { record, Replayer } from "rrweb";
import type { eventWithTime } from "rrweb";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  PreviewDomPatchBatch,
  PreviewInitialDocument,
  PreviewRecordedEvent,
} from "../../types/slides";
import { computeRrwebOffsetMs } from "./rrwebPreviewReplayer";
import { buildRrwebReplayEvents } from "./rrwebPreview";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let stopRecording: (() => void) | undefined;
let activeReplayer: Replayer | undefined;
const containers: HTMLElement[] = [];

// jsdom has no Element.scrollTo — rrweb's applyScroll would silently no-op (it
// wraps the call in try/catch). Reflect it onto scrollTop/scrollLeft so the
// replayed positions are observable.
beforeAll(() => {
  Element.prototype.scrollTo = function scrollTo(
    optionsOrX?: ScrollToOptions | number,
    y?: number,
  ) {
    if (typeof optionsOrX === "object" && optionsOrX !== null) {
      if (optionsOrX.top !== undefined) this.scrollTop = optionsOrX.top;
      if (optionsOrX.left !== undefined) this.scrollLeft = optionsOrX.left;
      return;
    }
    if (typeof optionsOrX === "number") this.scrollLeft = optionsOrX;
    if (typeof y === "number") this.scrollTop = y;
  };
});

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

// End-to-end scroll replay: record real rrweb events, wrap them into the same
// initial-document/patch-batch shapes the machine stores (recording-relative
// `time`, raw in-page event timestamps), rebuild the replay stream, and drive the
// replayer with recording-time seeks exactly like playback ticks do. The replayed
// scroll must land at the recorded position at the recorded time — no earlier, no
// later, and seeks backward must restore earlier positions.
describe("rrweb preview scroll replay timing", () => {
  it("replays element scroll at the recorded recording-times", async () => {
    document.body.innerHTML = `
      <div id="scroller" style="height: 200px; overflow: auto;">
        <div style="height: 10000px;">tall</div>
      </div>
    `;

    const recorded: PreviewRecordedEvent[] = [];
    stopRecording = record({
      emit: (event) => recorded.push(event as unknown as PreviewRecordedEvent),
      inlineStylesheet: true,
      slimDOMOptions: { script: true, comment: true },
    });
    await sleep(30);

    const scroller = document.getElementById("scroller");
    if (!scroller) throw new Error("missing #scroller");

    // Two scroll positions, far enough apart to defeat rrweb's 100ms scroll throttle.
    scroller.scrollTop = 500;
    scroller.dispatchEvent(new Event("scroll"));
    await sleep(150);
    scroller.scrollTop = 900;
    scroller.dispatchEvent(new Event("scroll"));
    await sleep(150);

    stopRecording?.();
    stopRecording = undefined;

    const isScrollEvent = (event: PreviewRecordedEvent) =>
      event.type === 3 && (event.data as { source?: number }).source === 3;
    const seedEvents = recorded.filter((event) => !isScrollEvent(event));
    const scrollEvents = recorded.filter(isScrollEvent);
    expect(scrollEvents.length).toBeGreaterThanOrEqual(2);

    // Machine-shaped storage. In production, batch `time` is the host's frame
    // flush time, a little after the rrweb event itself; the replay builder should
    // preserve the raw rrweb event deltas instead of delaying each event to that
    // flush time.
    const baseTime = 1_000;
    const firstRawTimestamp = seedEvents[0]?.timestamp ?? recorded[0]?.timestamp ?? 0;
    const recordingTimeFor = (event: PreviewRecordedEvent) =>
      baseTime + (event.timestamp - firstRawTimestamp);
    const initialDocuments: PreviewInitialDocument[] = [
      {
        version: 2,
        time: baseTime,
        documentId: "doc-1",
        route: "/",
        events: seedEvents,
      },
    ];
    const patchBatches: PreviewDomPatchBatch[] = scrollEvents.map((event) => ({
      version: 2,
      time: recordingTimeFor(event) + 50,
      source: "runtime-preview",
      documentId: "doc-1",
      route: "/",
      events: [event],
    }));
    const firstScrollTime = recordingTimeFor(scrollEvents[0]);
    const secondScrollTime = recordingTimeFor(scrollEvents[1]);

    const events = buildRrwebReplayEvents(initialDocuments, patchBatches);
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);

    // Raw Replayer with the jsdom rebuild-guard bypass (same pattern as the other
    // rrweb tests); driven with the exact production offset math
    // (`RrwebPreviewReplayer.seekToRecordingTime` = `pause(computeRrwebOffsetMs)`).
    activeReplayer = new Replayer(events as unknown as eventWithTime[], {
      root: container,
      liveMode: false,
      mouseTail: false,
      showWarning: false,
      useVirtualDom: false,
      speed: 1,
      UNSAFE_replayCanvas: true,
    });
    const seekToRecordingTime = (currentTime: number) =>
      activeReplayer?.pause(computeRrwebOffsetMs(currentTime, baseTime));
    await sleep(0);

    // The replay iframe is its own jsdom realm with its own Element prototype —
    // patch scrollTo there too, or rrweb's applyScroll still no-ops.
    const replayWindow = container.querySelector("iframe")?.contentWindow as
      | (Window & { Element: typeof Element })
      | null;
    if (replayWindow?.Element) {
      replayWindow.Element.prototype.scrollTo = Element.prototype.scrollTo;
    }

    const replayedScroller = () =>
      container.querySelector("iframe")?.contentDocument?.getElementById("scroller");

    // Before the first recorded scroll: still at the top.
    seekToRecordingTime(firstScrollTime - 10);
    await sleep(0);
    expect(replayedScroller()?.scrollTop ?? 0).toBe(0);

    // At/after the first scroll's recording time: first position, not the second.
    seekToRecordingTime(firstScrollTime + 10);
    await sleep(0);
    expect(replayedScroller()?.scrollTop).toBe(500);

    // Between the two: still the first position.
    seekToRecordingTime(secondScrollTime - 10);
    await sleep(0);
    expect(replayedScroller()?.scrollTop).toBe(500);

    // After the second: second position.
    seekToRecordingTime(secondScrollTime + 10);
    await sleep(0);
    expect(replayedScroller()?.scrollTop).toBe(900);

    // Seek backward: the earlier position is restored.
    seekToRecordingTime(firstScrollTime + 10);
    await sleep(0);
    expect(replayedScroller()?.scrollTop).toBe(500);
  });

  // State reached before recording starts (mutations, scroll) is missing from
  // the page-load snapshot, so the recording-start snapshot
  // (RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE) re-serializes the current document.
  // Replay must rebuild from a later FullSnapshot wherever it appears in the
  // stream — this also covers drift-checkpoint snapshots in the patch stream.
  it("recovers pre-recording mutations and scroll via the record-start snapshot", async () => {
    document.body.innerHTML = `
      <div id="scroller" style="height: 200px; overflow: auto;">
        <div id="content" style="height: 10000px;">initial</div>
      </div>
    `;

    const recorded: PreviewRecordedEvent[] = [];
    stopRecording = record({
      emit: (event) => recorded.push(event as unknown as PreviewRecordedEvent),
      inlineStylesheet: true,
      slimDOMOptions: { script: true, comment: true },
    });
    await sleep(30);
    const seedEvents = recorded.splice(0);

    // Pre-recording activity: content changes and the panel is scrolled. The host
    // is not recording yet, so these incremental events are dropped (splice below).
    const content = document.getElementById("content");
    const scroller = document.getElementById("scroller");
    if (!content || !scroller) throw new Error("missing fixture nodes");
    content.textContent = "changed before recording";
    scroller.scrollTop = 777;
    scroller.dispatchEvent(new Event("scroll"));
    await sleep(150);
    recorded.splice(0);

    // Recording starts: the host asks for a corrective snapshot.
    record.takeFullSnapshot();
    await sleep(30);
    const correctiveEvents = recorded.splice(0);
    expect(correctiveEvents.some((event) => event.type === 2)).toBe(true);

    stopRecording?.();
    stopRecording = undefined;

    const events = buildRrwebReplayEvents(
      [{ version: 2, time: 1_000, documentId: "doc-1", route: "/", events: seedEvents }],
      [
        {
          version: 2,
          time: 1_010,
          source: "runtime-preview",
          documentId: "doc-1",
          route: "/",
          events: correctiveEvents,
        },
      ],
    );

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
    await sleep(0);

    const replayWindow = container.querySelector("iframe")?.contentWindow as
      | (Window & { Element: typeof Element })
      | null;
    if (replayWindow?.Element) {
      replayWindow.Element.prototype.scrollTo = Element.prototype.scrollTo;
    }

    activeReplayer.pause(computeRrwebOffsetMs(1_500, 1_000));
    await sleep(0);

    const replayedDoc = container.querySelector("iframe")?.contentDocument;
    expect(replayedDoc?.getElementById("content")?.textContent).toBe("changed before recording");
    expect(replayedDoc?.getElementById("scroller")?.scrollTop).toBe(777);
  });
});
