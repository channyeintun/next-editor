import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createActor, sendTo, setup } from "xstate";
import { timelineMachine } from "./timelineMachine";

const timelineParentMachine = setup({
  types: {
    context: {} as Record<string, never>,
    events: {} as { type: "TICK"; timestamp: number; currentTime: number } | { type: "FINISHED" },
  },
  actors: { timeline: timelineMachine },
}).createMachine({
  context: {},
  invoke: {
    src: "timeline",
    id: "timelineActor",
    input: { duration: 0, speed: 1, startPosition: 0 },
  },
  entry: sendTo("timelineActor", { type: "START" }),
});

describe("timelineMachine ticker lifecycle", () => {
  const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  const originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "cancelAnimationFrame",
  );
  let nextFrameId = 1;
  let frames: Map<number, FrameRequestCallback>;
  let requestFrame: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    nextFrameId = 1;
    frames = new Map();
    requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: requestFrame,
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: (id: number) => frames.delete(id),
    });
  });

  afterEach(() => {
    if (originalRequestAnimationFrame) {
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRequestAnimationFrame);
    } else {
      delete (globalThis as Record<string, unknown>).requestAnimationFrame;
    }
    if (originalCancelAnimationFrame) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancelAnimationFrame);
    } else {
      delete (globalThis as Record<string, unknown>).cancelAnimationFrame;
    }
  });

  it("does not schedule another frame when the finishing pulse disposes the ticker", () => {
    const actor = createActor(timelineParentMachine).start();
    const timelineActor = actor.getSnapshot().children.timelineActor!;

    expect(timelineActor.getSnapshot().value).toBe("running");
    expect(frames.size).toBe(1);

    const [frameId, callback] = [...frames.entries()][0]!;
    frames.delete(frameId);
    callback(0);

    expect(timelineActor.getSnapshot().value).toBe("stopped");
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    actor.stop();
  });
});
