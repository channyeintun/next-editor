import { record, Replayer } from "rrweb";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PreviewDomPatchBatch,
  PreviewInitialDocument,
  PreviewRecordedEvent,
} from "../../types/slides";
import { buildRrwebReplayEvents } from "./rrwebPreview";
import { computeRrwebOffsetMs } from "./rrwebPreviewReplayer";

const RRWEB_EVENT_TYPE_FULL_SNAPSHOT = 2;
const RRWEB_EVENT_TYPE_META = 4;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Splits a captured rrweb stream into the recorded-segment shape the bridge
// produces: Meta + FullSnapshot in the initial document, the rest as a batch.
function toSegments(events: PreviewRecordedEvent[]): {
  initialDocuments: PreviewInitialDocument[];
  patchBatches: PreviewDomPatchBatch[];
} {
  const seedEvents = events.filter(
    (event) =>
      event.type === RRWEB_EVENT_TYPE_META || event.type === RRWEB_EVENT_TYPE_FULL_SNAPSHOT,
  );
  const incrementalEvents = events.filter(
    (event) =>
      event.type !== RRWEB_EVENT_TYPE_META && event.type !== RRWEB_EVENT_TYPE_FULL_SNAPSHOT,
  );

  return {
    initialDocuments: [{ version: 2, time: 0, documentId: "doc-1", events: seedEvents }],
    patchBatches: [
      {
        version: 2,
        time: 1000,
        source: "runtime-preview",
        documentId: "doc-1",
        events: incrementalEvents,
      },
    ],
  };
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

// Drives an rrweb Replayer the same way RrwebPreviewReplayer does (offset =
// currentTime - baseTime via computeRrwebOffsetMs), but constructs the Replayer
// directly with UNSAFE_replayCanvas so the rebuild target guard is bypassed: rrweb
// 2.x rejects rebuilding into a document whose iframe it can't verify as
// sandboxed, and jsdom's sandboxed-iframe contentDocument identity is unstable, so
// the production createSandboxedIframe path cannot be exercised under jsdom. The
// rebuild + incremental-application fidelity under test is identical either way.
function replayDirect(events: ReturnType<typeof buildRrwebReplayEvents>, root: HTMLElement) {
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

describe("rrweb preview record -> replay round trip", () => {
  it("replays a virtualized-list scroll churn to the exact final DOM (no drift, not empty)", async () => {
    // A window-virtualizer-like list: a spacer with absolutely-placed rows.
    document.body.innerHTML = `
      <main>
        <div id="timeline" style="position:relative;height:1000px">
          <div class="row" data-index="0" style="transform:translateY(0px)">post 0</div>
          <div class="row" data-index="1" style="transform:translateY(100px)">post 1</div>
        </div>
      </main>
    `;

    const events: PreviewRecordedEvent[] = [];
    stopRecording = record({
      emit: (event) => events.push(event as unknown as PreviewRecordedEvent),
      inlineStylesheet: true,
      slimDOMOptions: { script: true, comment: true },
    });

    await flush();

    // Simulate scrolling the virtual list: drop the top row, append new rows with
    // updated translateY, and grow the spacer — exactly the dense churn that made
    // the legacy index-based replay drift to empty.
    const timeline = document.getElementById("timeline");
    if (!timeline) {
      throw new Error("missing #timeline");
    }

    timeline.querySelector('[data-index="0"]')?.remove();
    for (let index = 2; index <= 6; index++) {
      const row = document.createElement("div");
      row.className = "row";
      row.setAttribute("data-index", String(index));
      row.style.transform = `translateY(${index * 100}px)`;
      row.textContent = `post ${index}`;
      timeline.appendChild(row);
    }
    timeline.style.height = "2000px";

    await flush();

    const { initialDocuments, patchBatches } = toSegments(events);
    expect(initialDocuments[0].events?.length).toBeGreaterThanOrEqual(2);
    expect(patchBatches[0].events?.length).toBeGreaterThan(0);

    const replayEvents = buildRrwebReplayEvents(initialDocuments, patchBatches);

    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);

    activeReplayer = replayDirect(replayEvents, container);
    await flush();
    // Seek well past the end so all incremental events are applied.
    activeReplayer.pause(computeRrwebOffsetMs(1_000_000, 0));
    await flush();

    const replayedDocument = container.querySelector("iframe")?.contentDocument;
    expect(replayedDocument).toBeTruthy();

    const replayedRows = Array.from(replayedDocument?.querySelectorAll(".row") ?? []);
    const liveRows = Array.from(timeline.querySelectorAll(".row"));

    // The replayed list is not empty and matches the live final DOM exactly.
    expect(liveRows.length).toBe(6);
    expect(replayedRows.length).toBe(liveRows.length);
    expect(replayedRows.map((row) => row.textContent)).toEqual(
      liveRows.map((row) => row.textContent),
    );
    expect(replayedRows.map((row) => row.getAttribute("data-index"))).toEqual(
      liveRows.map((row) => row.getAttribute("data-index")),
    );
    // The grown spacer height replayed too (scroll/translateY context intact).
    expect(replayedDocument?.getElementById("timeline")?.getAttribute("style")).toContain("2000px");
  });
});
