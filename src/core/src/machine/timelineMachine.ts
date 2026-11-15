import { setup, assign, fromCallback, sendParent, enqueueActions } from "xstate";
import {
  normalizePlaybackSpeed,
  normalizeTimelineDuration,
  normalizeTimelineTime,
} from "./playbackValues";

/** All times are timeline milliseconds. */
export interface TimelineContext {
  currentTime: number;
  duration: number;
  speed: number;
  startedAt: number;
  accumulatedTime: number;
}

export type TimelineEvent =
  | { type: "START" }
  | { type: "STOP" }
  | { type: "PAUSE" }
  /**
   * Like PAUSE, but stops where the clock really is and reports it with a last TICK.
   * PAUSE stops at the last pulse, which is what the viewer was shown; pulses come from
   * drawn frames, so in a hidden tab the last one is as old as the tab's last frame
   * while the count went on. A stop made without the viewer (a hold for the narration)
   * can come then, and stopping at that pulse would wind the lesson back to it.
   */
  | { type: "HOLD" }
  | { type: "SEEK"; time: number }
  | { type: "SET_DURATION"; duration: number }
  | { type: "SET_SPEED"; speed: number };

/** Moves the playhead to `time`, clamped to the timeline; the clock counts on from there. */
const seekTimeline = (context: TimelineContext, time: number) => {
  const currentTime = normalizeTimelineTime(time, context.duration, context.currentTime);
  return { currentTime, accumulatedTime: currentTime };
};

const setTimelineSpeed = (context: TimelineContext, speed: number) => ({
  speed: normalizePlaybackSpeed(speed, context.speed),
});

/** Where a running clock is right now: the count so far plus the time since it last restarted. */
const clockPosition = (context: TimelineContext) =>
  normalizeTimelineTime(
    context.accumulatedTime + (performance.now() - context.startedAt) * context.speed,
    context.duration,
    context.currentTime,
  );

export const timelineMachine = setup({
  types: {
    context: {} as TimelineContext,
    events: {} as TimelineEvent | { type: "PULSE" },
    input: {} as { duration: number; speed: number; startPosition: number },
  },
  actors: {
    ticker: fromCallback(({ sendBack }) => {
      let animationFrameId: number | null = null;
      let active = true;
      const tick = () => {
        animationFrameId = null;
        if (!active) return;

        sendBack({ type: "PULSE" });
        // `sendBack` can synchronously make the parent leave `running`, which
        // disposes this callback actor before it returns. Never schedule from a
        // callback that was stopped by the pulse it just delivered.
        if (active) {
          animationFrameId = requestAnimationFrame(tick);
        }
      };
      animationFrameId = requestAnimationFrame(tick);
      return () => {
        active = false;
        if (animationFrameId !== null) {
          cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
      };
    }),
  },
  actions: {
    readClock: assign(({ context }) => ({ currentTime: clockPosition(context) })),
    emitTick: sendParent(({ context }) => ({
      type: "TICK",
      currentTime: context.currentTime,
    })),
    emitFinished: sendParent({ type: "FINISHED" }),
  },
}).createMachine({
  id: "timeline",
  initial: "stopped",
  context: ({ input }) => {
    const duration = normalizeTimelineDuration(input.duration);
    const currentTime = normalizeTimelineTime(input.startPosition, duration);
    return {
      currentTime,
      duration,
      speed: normalizePlaybackSpeed(input.speed),
      startedAt: 0,
      accumulatedTime: currentTime,
    };
  },
  on: {
    SEEK: {
      actions: assign(({ context, event }) => seekTimeline(context, event.time)),
    },
    SET_DURATION: {
      actions: assign(({ context, event }) => ({
        duration: Math.max(
          context.currentTime,
          normalizeTimelineDuration(event.duration, context.duration),
        ),
      })),
    },
    SET_SPEED: {
      actions: assign(({ context, event }) => setTimelineSpeed(context, event.speed)),
    },
  },
  states: {
    stopped: {
      on: {
        START: "running",
      },
    },
    running: {
      entry: assign({
        startedAt: () => performance.now(),
      }),
      // Leaving running (PAUSE, or a STOP, including the one raised at the end) freezes the
      // count at the playhead, so the next START counts on from there.
      exit: assign({
        accumulatedTime: ({ context }) => context.currentTime,
      }),
      invoke: {
        src: "ticker",
      },
      on: {
        PULSE: {
          actions: [
            { type: "readClock" },
            { type: "emitTick" },
            enqueueActions(({ context, enqueue }) => {
              if (context.currentTime >= context.duration) {
                enqueue.raise({ type: "STOP" });
                enqueue({ type: "emitFinished" });
              }
            }),
          ],
        },
        PAUSE: "paused",
        // Read the clock while still running (the exit below freezes the count at
        // `currentTime`), report it, then leave: paused, or finished when the count
        // reached the end while no pulse came to say so.
        HOLD: {
          actions: [
            { type: "readClock" },
            { type: "emitTick" },
            enqueueActions(({ context, enqueue }) => {
              if (context.currentTime >= context.duration) {
                enqueue.raise({ type: "STOP" });
                enqueue({ type: "emitFinished" });
              } else {
                enqueue.raise({ type: "PAUSE" });
              }
            }),
          ],
        },
        STOP: "stopped",
        // While running, a seek or a speed change also restarts the clock's count, so
        // the next pulse measures from here at the new rate.
        SEEK: {
          actions: assign(({ context, event }) => ({
            ...seekTimeline(context, event.time),
            startedAt: performance.now(),
          })),
        },
        SET_SPEED: {
          actions: assign(({ context, event }) => ({
            ...setTimelineSpeed(context, event.speed),
            accumulatedTime: context.currentTime,
            startedAt: performance.now(),
          })),
        },
      },
    },
    paused: {
      on: {
        START: "running",
        STOP: "stopped",
      },
    },
  },
});
