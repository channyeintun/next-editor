import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeRrwebOffsetMs, createRrwebPreviewReplayer } from "./rrwebPreviewReplayer";

interface FakeReplayerInstance {
  pause: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
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

describe("RrwebPreviewReplayer", () => {
  it("uses a fresh rrweb instance when a completed recording starts again", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const preview = await createRrwebPreviewReplayer({ root, events: [], baseTime: 100 });
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
});
