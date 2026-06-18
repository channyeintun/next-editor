import { record, Replayer } from "rrweb";
import type { eventWithTime } from "rrweb";
import { afterEach, describe, expect, it } from "vitest";
import type { PreviewRecordedEvent } from "../../types/slides";

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

// Characterizes how repeated pause(offset) (the per-tick driving model) applies
// removes both forward and backward across multiple recorded frames.
describe("rrweb seek driving (per-tick pause)", () => {
  it("applies removes forward and backward across multiple frames", async () => {
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
  });
});
