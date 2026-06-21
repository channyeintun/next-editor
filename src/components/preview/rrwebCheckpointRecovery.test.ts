import { record, Replayer } from "rrweb";
import type { eventWithTime } from "rrweb";
import { afterEach, describe, expect, it } from "vitest";
import type { PreviewRecordedEvent } from "../../types/slides";
import { buildRrwebReplayEvents, createRrwebPreviewRecorderScript } from "./rrwebPreview";

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

describe("corrective checkpoint recovery", () => {
  it("wires a settled FullSnapshot checkpoint into the recorder", () => {
    const script = createRrwebPreviewRecorderScript({ setupMarker: "__CHK__" });
    expect(script).toContain("takeFullSnapshot");
    expect(script).toContain("scheduleCheckpoint");
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
});
