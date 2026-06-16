import { setup, assign, fromCallback, sendParent, enqueueActions, type ActorRefFrom } from "xstate";

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
      let animationFrameId: number;
      const tick = () => {
        sendBack({ type: "PULSE" });
        animationFrameId = requestAnimationFrame(tick);
      };
      animationFrameId = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(animationFrameId);
    }),
  },
  actions: {
    emitTick: sendParent(({ context }) => ({
      type: "TICK",
      currentTime: context.currentTime,
    })),
    emitFinished: sendParent({ type: "FINISHED" }),
  },
}).createMachine({
  id: "timeline",
  initial: "stopped",
  context: ({ input }) => ({
    currentTime: input.startPosition,
    duration: input.duration,
    speed: input.speed,
    startedAt: 0,
    accumulatedTime: input.startPosition,
  }),
  states: {
    stopped: {
      on: {
        START: "running",
        SEEK: {
          actions: assign(({ event }) => ({
            currentTime: event.time,
            accumulatedTime: event.time,
          })),
        },
        SET_DURATION: {
          actions: assign(({ context, event }) => ({
            duration: Math.max(context.currentTime, event.duration),
          })),
        },
        SET_SPEED: {
          actions: assign(({ event }) => ({
            speed: event.speed,
          })),
        },
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
              const position = Math.min(context.accumulatedTime + elapsed, context.duration);
              return { currentTime: position };
            }),
            { type: "emitTick" },
            enqueueActions(({ context, enqueue }) => {
              if (context.currentTime >= context.duration) {
                enqueue.raise({ type: "STOP" });
                enqueue.sendParent({ type: "FINISHED" });
              }
            }),
          ],
        },
        PAUSE: "paused",
        STOP: "stopped",
        SEEK: {
          actions: assign(({ event }) => ({
            currentTime: event.time,
            accumulatedTime: event.time,
            startedAt: performance.now(),
          })),
        },
        SET_DURATION: {
          actions: assign(({ context, event }) => ({
            duration: Math.max(context.currentTime, event.duration),
          })),
        },
        SET_SPEED: {
          actions: assign(({ context, event }) => ({
            speed: event.speed,
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
        SEEK: {
          actions: assign(({ event }) => ({
            currentTime: event.time,
            accumulatedTime: event.time,
          })),
        },
        SET_DURATION: {
          actions: assign(({ context, event }) => ({
            duration: Math.max(context.currentTime, event.duration),
          })),
        },
        SET_SPEED: {
          actions: assign(({ event }) => ({
            speed: event.speed,
          })),
        },
      },
    },
  },
});

export type TimelineActorRef = ActorRefFrom<typeof timelineMachine>;
