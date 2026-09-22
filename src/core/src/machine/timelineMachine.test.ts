import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { assign, createActor, sendTo, setup } from "xstate";
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

// Counts what the timeline reports to its parent, as the editor machine receives it.
const countingTimelineParentMachine = setup({
  types: {
    context: {} as { ticks: number[]; finished: number },
    events: {} as { type: "TICK"; timestamp: number; currentTime: number } | { type: "FINISHED" },
  },
  actors: { timeline: timelineMachine },
}).createMachine({
  context: { ticks: [], finished: 0 },
  invoke: {
    src: "timeline",
    id: "timelineActor",
    input: { duration: 1000, speed: 1, startPosition: 0 },
  },
  on: {
    TICK: {
      actions: assign({ ticks: ({ context, event }) => [...context.ticks, event.currentTime] }),
    },
    FINISHED: {
      actions: assign({ finished: ({ context }) => context.finished + 1 }),
    },
  },
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
    requestFrame = vi.fn<(callback: FrameRequestCallback) => number>((callback) => {
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

  const runNextFrame = () => {
    const [frameId, callback] = [...frames.entries()][0]!;
    frames.delete(frameId);
    callback(performance.now());
  };

  describe("position", () => {
    let clock: { now: number };

    beforeEach(() => {
      clock = { now: 0 };
      vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const startTimeline = () => {
      const actor = createActor(countingTimelineParentMachine).start();
      const timelineActor = actor.getSnapshot().children.timelineActor!;
      timelineActor.send({ type: "START" });
      const position = () => timelineActor.getSnapshot().context.currentTime;
      return { actor, timelineActor, position };
    };

    it("accumulates position across a pause, not counting the time spent paused", () => {
      const { actor, timelineActor, position } = startTimeline();

      clock.now = 300;
      runNextFrame();
      expect(position()).toBe(300);

      timelineActor.send({ type: "PAUSE" });
      expect(frames.size).toBe(0);
      clock.now = 5_000;
      timelineActor.send({ type: "START" });
      clock.now = 5_100;
      runNextFrame();

      expect(position()).toBe(400);
      expect(actor.getSnapshot().context.ticks).toEqual([300, 400]);
      actor.stop();
    });

    it("re-anchors on a speed change so only later time runs faster", () => {
      const { actor, timelineActor, position } = startTimeline();

      clock.now = 400;
      runNextFrame();
      timelineActor.send({ type: "SET_SPEED", speed: 2 });
      clock.now = 500;
      runNextFrame();

      expect(position()).toBe(600);
      actor.stop();
    });

    it("re-anchors on a seek while running", () => {
      const { actor, timelineActor, position } = startTimeline();

      clock.now = 100;
      runNextFrame();
      timelineActor.send({ type: "SEEK", time: 600 });
      clock.now = 150;
      runNextFrame();

      expect(position()).toBe(650);
      actor.stop();
    });

    it("never shrinks the duration below the current position", () => {
      const { actor, timelineActor } = startTimeline();

      clock.now = 400;
      runNextFrame();
      timelineActor.send({ type: "SET_DURATION", duration: 200 });

      expect(timelineActor.getSnapshot().context.duration).toBe(400);
      actor.stop();
    });

    it("stops at the end and tells the parent it finished exactly once", () => {
      const { actor, timelineActor, position } = startTimeline();

      clock.now = 1_500;
      runNextFrame();

      expect(position()).toBe(1_000);
      expect(timelineActor.getSnapshot().value).toBe("stopped");
      expect(actor.getSnapshot().context.finished).toBe(1);
      expect(frames.size).toBe(0);
      actor.stop();
    });
  });
});
