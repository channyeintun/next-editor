import { setup, assign, fromCallback, sendParent, enqueueActions, type ActorRefFrom } from "xstate";
import {
  normalizePlaybackSpeed,
  normalizeTimelineDuration,
  normalizeTimelineTime,
} from "./playbackValues";

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
  | { type: "TICK"; currentTime: number }
  | { type: "SEEK"; time: number }
  | { type: "SET_DURATION"; duration: number }
  | { type: "SET_SPEED"; speed: number };

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
    emitTick: sendParent(({ context }) => ({
      type: "TICK",
      timestamp: performance.now(),
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
      actions: assign(({ context, event }) => {
        const currentTime = normalizeTimelineTime(
          event.time,
          context.duration,
          context.currentTime,
        );
        return { currentTime, accumulatedTime: currentTime };
      }),
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
      actions: assign(({ context, event }) => ({
        speed: normalizePlaybackSpeed(event.speed, context.speed),
      })),
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
      invoke: {
        src: "ticker",
      },
      on: {
        PULSE: {
          actions: [
            assign(({ context }) => {
              const now = performance.now();
              const elapsed = (now - context.startedAt) * context.speed;
              const position = normalizeTimelineTime(
                context.accumulatedTime + elapsed,
                context.duration,
                context.currentTime,
              );
              return { currentTime: position };
            }),
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
        STOP: "stopped",
        SEEK: {
          actions: assign(({ context, event }) => {
            const currentTime = normalizeTimelineTime(
              event.time,
              context.duration,
              context.currentTime,
            );
            return {
              currentTime,
              accumulatedTime: currentTime,
              startedAt: performance.now(),
            };
          }),
        },
        SET_SPEED: {
          actions: assign(({ context, event }) => ({
            speed: normalizePlaybackSpeed(event.speed, context.speed),
            accumulatedTime: context.currentTime,
            startedAt: performance.now(),
          })),
        },
      },
    },
    paused: {
      entry: assign({
        accumulatedTime: ({ context }) => context.currentTime,
      }),
      on: {
        START: "running",
        STOP: "stopped",
      },
    },
  },
});

export type TimelineActorRef = ActorRefFrom<typeof timelineMachine>;
