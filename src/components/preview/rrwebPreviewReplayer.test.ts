import { within } from "@testing-library/react";
import type { eventWithTime } from "@rrweb/types";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PreviewDomPatchBatch, PreviewInitialDocument } from "../../types/slides";
import { buildRrwebReplayEvents } from "./rrwebPreview";
import { computeRrwebOffsetMs, createRrwebPreviewReplayer } from "./rrwebPreviewReplayer";

interface FakeReplayerInstance {
  pause: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  addEvent: ReturnType<typeof vi.fn>;
}

const fakeRrweb = vi.hoisted(() => ({
  instances: [] as FakeReplayerInstance[],
}));

vi.mock("@rrweb/replay", () => ({
  Replayer: class FakeReplayer {
    readonly wrapper = document.createElement("div");
    readonly iframe = document.createElement("iframe");
    readonly pause = vi.fn<(offset?: number) => void>();
    readonly destroy = vi.fn<() => void>(() => this.wrapper.remove());
    readonly addEvent = vi.fn<(event: eventWithTime) => void>();

    constructor(_events: unknown[], config: { root: HTMLElement }) {
      this.wrapper.append(this.iframe);
      config.root.append(this.wrapper);
      fakeRrweb.instances.push(this);
    }
  },
}));

beforeEach(() => {
  fakeRrweb.instances.length = 0;
  document.body.replaceChildren();
});

describe("computeRrwebOffsetMs", () => {
  it("shifts recording time by the snapshot base time", () => {
    expect(computeRrwebOffsetMs(1000, 200)).toBe(800);
  });

  it("clamps to zero before the first snapshot", () => {
    expect(computeRrwebOffsetMs(50, 200)).toBe(0);
    expect(computeRrwebOffsetMs(200, 200)).toBe(0);
  });

  it("is identity when the snapshot is at recording start", () => {
    expect(computeRrwebOffsetMs(1234, 0)).toBe(1234);
  });
});

function rrwebEvent(type: number, timestamp: number): eventWithTime {
  return { type, timestamp, data: {} } as eventWithTime;
}

// IncrementalSnapshot/MouseMove whose first position is sampled before the
// event's own timestamp, as rrweb's recorder batches pointer positions.
function mouseMoveEvent(timestamp: number, firstPositionOffset: number): eventWithTime {
  return {
    type: 3,
    timestamp,
    data: { source: 1, positions: [{ x: 0, y: 0, id: 1, timeOffset: firstPositionOffset }] },
  } as eventWithTime;
}

describe("RrwebPreviewReplayer", () => {
  it("casts an event once the recording clock reaches its rebased time", async () => {
    // rrweb stamps the seed's Meta event before it serializes the page, so the
    // seed reaches the host (which stamps `time`) later than a one-event batch
    // does: here 80ms after its Meta event versus 5ms after the scroll.
    const PREVIEW_CLOCK = 1_700_000_000_000;
    const seed: PreviewInitialDocument = {
      version: 2,
      time: 1_080,
      documentId: "doc-1",
      events: [rrwebEvent(4, PREVIEW_CLOCK + 1_000), rrwebEvent(2, PREVIEW_CLOCK + 1_060)],
    };
    const batch: PreviewDomPatchBatch = {
      version: 2,
      time: 1_205,
      source: "runtime-preview",
      documentId: "doc-1",
      events: [rrwebEvent(3, PREVIEW_CLOCK + 1_200)],
    };
    const events = buildRrwebReplayEvents([seed], [batch]);
    const scroll = events.find((event) => event.type === 3);
    if (!scroll) throw new Error("missing scroll event");
    const root = document.createElement("div");
    document.body.append(root);
    const preview = await createRrwebPreviewReplayer({ root, events });

    preview.seekToRecordingTime(scroll.timestamp + 1);

    // rrweb's pause(offset) casts every event older than events[0].timestamp + offset.
    const offset = fakeRrweb.instances[0]?.pause.mock.lastCall?.[0] as number;
    expect(events[0].timestamp + offset).toBeGreaterThan(scroll.timestamp);
    preview.destroy();
  });

  it("names the replay frame like the live runtime frame, also after a restart", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const preview = await createRrwebPreviewReplayer({
      root,
      events: [rrwebEvent(4, 100), rrwebEvent(2, 100)],
    });

    expect(within(root).getByTitle("Runtime Preview").tagName).toBe("IFRAME");

    // Seeking back to the start replaces the Replayer and its iframe.
    preview.seekToRecordingTime(1_000);
    preview.seekToRecordingTime(100);

    expect(fakeRrweb.instances).toHaveLength(2);
    expect(within(root).getByTitle("Runtime Preview")).toBe(root.querySelector("iframe"));

    preview.destroy();
  });

  it("uses a fresh rrweb instance when a completed recording starts again", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const preview = await createRrwebPreviewReplayer({
      root,
      events: [rrwebEvent(4, 100), rrwebEvent(2, 100)],
    });
    const first = fakeRrweb.instances[0];

    expect(first).toBeDefined();
    preview.seekToRecordingTime(1_000);
    expect(first?.pause).toHaveBeenLastCalledWith(900);

    preview.seekToRecordingTime(100);

    expect(first?.destroy).toHaveBeenCalledOnce();
    expect(fakeRrweb.instances).toHaveLength(2);
    expect(root.childElementCount).toBe(1);
    expect(fakeRrweb.instances[1]?.pause).toHaveBeenLastCalledWith(0);

    preview.destroy();
  });

  it("seeks rrweb only when the clock crosses an event, moves back, or first applies", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const preview = await createRrwebPreviewReplayer({
      root,
      events: [rrwebEvent(4, 100), rrwebEvent(2, 100), rrwebEvent(3, 500), rrwebEvent(3, 900)],
    });
    const pause = fakeRrweb.instances[0]?.pause;
    const pausedOffsets = () => pause?.mock.calls.map(([offset]) => offset);

    preview.seekToRecordingTime(150);
    expect(pausedOffsets()).toEqual([50]);

    // rrweb casts `timestamp < baseline`, so reaching an event's time is not crossing it.
    for (const time of [200, 300, 500]) preview.seekToRecordingTime(time);
    expect(pausedOffsets()).toEqual([50]);

    preview.seekToRecordingTime(501);
    preview.seekToRecordingTime(700);
    expect(pausedOffsets()).toEqual([50, 401]);

    preview.seekToRecordingTime(600);
    preview.seekToRecordingTime(650);
    expect(pausedOffsets()).toEqual([50, 401, 500]);

    preview.seekToRecordingTime(901);
    preview.seekToRecordingTime(5_000);
    expect(pausedOffsets()).toEqual([50, 401, 500, 801]);

    // Back to the start still restarts on a fresh Replayer that seeks at once,
    // and the seed events at its first event time are crossed right after.
    preview.seekToRecordingTime(100);
    expect(fakeRrweb.instances[1]?.pause.mock.calls).toEqual([[0]]);
    preview.seekToRecordingTime(120);
    preview.seekToRecordingTime(140);
    expect(fakeRrweb.instances[1]?.pause.mock.calls).toEqual([[0], [20]]);

    preview.destroy();
  });

  it("hands later events to the live Replayer and counts the ones it casts on arrival", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const preview = await createRrwebPreviewReplayer({
      root,
      events: [rrwebEvent(4, 100), rrwebEvent(2, 100), rrwebEvent(3, 500)],
    });
    const replayer = fakeRrweb.instances[0];
    preview.seekToRecordingTime(600);
    expect(replayer?.pause.mock.calls).toEqual([[500]]);

    // Older than the last seek's baseline, so rrweb casts it as it is added.
    const late = rrwebEvent(3, 550);
    expect(preview.appendEvents([late])).toBe(true);
    expect(replayer?.addEvent).toHaveBeenLastCalledWith(late);
    preview.seekToRecordingTime(650);
    expect(replayer?.pause.mock.calls).toEqual([[500]]);

    // Ahead of it, so the seek that crosses it casts it.
    expect(preview.appendEvents([rrwebEvent(3, 700)])).toBe(true);
    preview.seekToRecordingTime(690);
    preview.seekToRecordingTime(701);
    expect(replayer?.pause.mock.calls).toEqual([[500], [601]]);

    // Anything not after the stream's last event would replay out of order.
    expect(preview.appendEvents([rrwebEvent(3, 700)])).toBe(false);
    expect(replayer?.addEvent).toHaveBeenCalledTimes(2);
    expect(fakeRrweb.instances).toHaveLength(1);

    preview.destroy();
  });

  it("gates a MouseMove on its raw timestamp, not its earlier first position", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const preview = await createRrwebPreviewReplayer({
      root,
      events: [rrwebEvent(4, 100), rrwebEvent(2, 100), mouseMoveEvent(600, -400)],
    });
    const pause = fakeRrweb.instances[0]?.pause;

    preview.seekToRecordingTime(150);
    // Past the first position (200) but not the event: rrweb would cast nothing yet.
    preview.seekToRecordingTime(400);
    expect(pause?.mock.calls).toEqual([[50]]);

    preview.seekToRecordingTime(601);
    expect(pause?.mock.calls).toEqual([[50], [501]]);

    preview.destroy();
  });
});
