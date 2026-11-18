// The order of work in a `node` process's event loop: `process.nextTick`, the
// macrotasks, and the reports of rejections nobody handled. It needs only the
// process runtime and the platform's own task APIs, so every source of
// macrotasks (the kernel link, timers, fs completions, ports, sockets) uses it
// without the `process` object.
//
// After each macrotask's callback Node runs every queued tick (and the ticks
// those queue), then every promise job, and repeats until both queues are
// empty, before the next macrotask. A browser runs the promise jobs as each
// task ends and tells nobody when they are done. So:
//  - the macrotasks webnode delivers (timers, immediates, kernel messages, fs
//    completions, port messages, WebSocket events) run their callback through
//    `runMacrotask`, which runs the ticks it queued as it returns, before the
//    browser runs the promise jobs;
//  - a tick queued anywhere else (from a promise job, or from a browser
//    callback webnode does not wrap) waits for the turn: a task posted at
//    once, at the highest priority the platform has, so it comes before the
//    tasks already queued, the `node` program's exit check included. The turn
//    continues in one message with many listeners: the browser runs the
//    promise jobs after each listener, so each listener is one more "ticks,
//    then promise jobs" round of Node's loop, without a task per round;
//  - a macrotask that arrives while such ticks still wait runs them, and its
//    own callback in a later round, after the promise jobs they queue;
//  - a macrotask that comes as an event of the runtime's own
//    (`addMacrotaskListener`; `macrotaskSource` for immediates and fs
//    completions) has such rounds in its own task, after its callback, so the
//    ticks its promise jobs queue need no task at all.
import { runtime, type ProcessRuntime } from "../runtime";
import { bindToCurrentContext } from "./async_hooks";

type AnyFunction = (...args: never[]) => unknown;

interface Tick {
  callback: AnyFunction;
  args: unknown[] | undefined;
}

interface PlatformScheduler {
  postTask(callback: () => void, options: { priority: string }): Promise<unknown>;
}

// Captured now: a program may replace these globals.
const platformScheduler = (globalThis as { scheduler?: Partial<PlatformScheduler> }).scheduler;
const platformPostTask =
  typeof platformScheduler?.postTask === "function"
    ? (platformScheduler.postTask.bind(platformScheduler) as PlatformScheduler["postTask"])
    : null;
const platformReportError =
  typeof (globalThis as { reportError?: unknown }).reportError === "function"
    ? ((globalThis as unknown as { reportError: (error: unknown) => void }).reportError.bind(
        globalThis,
      ) as (error: unknown) => void)
    : null;
const PlatformMessageChannel = MessageChannel;
const platformQueueMicrotask = queueMicrotask.bind(globalThis);
const nativeAddEventListener = EventTarget.prototype.addEventListener;
const nativeStopImmediatePropagation = Event.prototype.stopImmediatePropagation;
// A program's test spy may replace these on the prototype and not call through.
const nativePostMessage = MessagePort.prototype.postMessage as (
  this: MessagePort,
  message: unknown,
) => void;
const nativeStart = MessagePort.prototype.start;
/** Ahead of every task already queued: timers, messages, the kernel's replies. */
const TURN_PRIORITY = { priority: "user-blocking" };
/**
 * The turn starts ahead of every other task, so what waits for it needs no
 * hold on the process when it is queued. A hold then would be wrong: ticks
 * are not pending work in Node, and a tick a 'beforeExit' listener queues (any
 * stream write does) would end in another 'beforeExit'.
 */
const turnHasPriority = platformPostTask !== null && platformReportError !== null;
/** Rounds per task: one per listener of a continuation message, or after a macrotask's own listener. */
const ROUNDS_PER_TASK = 64;

/** Queued nextTick callbacks, run from the front. */
const ticks: Tick[] = [];
/** A pass drops the ticks it has run once they are this many and at least half the queue. */
const TICKS_TRIM = 1024;
/** `startEventLoop` ran in this worker: there is a `process.nextTick` to keep in order. */
let ticksEnabled = false;
/** How many macrotask callbacks are running (a nested one runs as part of the outer). */
let macrotaskDepth = 0;
/** `runTicks` is running: a tick queued now runs in the same pass. */
let runningTicks = false;
/** How many `dispatchEvent` calls made by program code are running. */
let programDispatches = 0;
/** Macrotasks that arrived while ticks queued outside a macrotask waited, in order. */
const waitingMacrotasks: (() => void)[] = [];
/** The entries of `waitingMacrotasks` that are reports of rejections (`runReport`). */
const waitingReports = new WeakSet<() => void>();
/** The turn is posted or running: what waits now is picked up without posting again. */
let turnPosted = false;
/** How many of the turn's tasks (each continuation listener, each round in a macrotask's task) have run (`afterTurn`). */
let turnTasksRun = 0;
/** The runtime that holds the process open while a continuation message is on its way. */
let turnHold: ProcessRuntime | null = null;
let turnPort: MessagePort | null = null;
/** A round left work for the next listener, and the promise jobs it queued have not run yet. */
let awaitingPromiseJobs = false;
/** The promise jobs after the turn's first round are running: a tick queued now continues it. */
let turnFollowing = false;
let followHops = 0;
/** How many promise-job generations after the first round still count as following it. */
const FOLLOW_HOPS = 4;
/** A later listener of the event being dispatched runs a round: a tick queued now waits for it. */
let roundAhead = false;
/**
 * The platform event whose macrotask was the last to start (`runEventListener`
 * with an event, `addMacrotaskListener`). It stays while the ticks and promise
 * jobs after it run, and goes when another macrotask starts or when a tick is
 * queued from a later task.
 */
let followedEvent: Event | null = null;
const EVENT_NONE = 0;

const MACROTASK_HANDLER = Symbol("webnode.macrotaskHandler");

/**
 * Starts keeping `process.nextTick` and the reports of unhandled rejections
 * in Node's order in this worker. `createProcess` calls it; before that (the
 * shell, npm) a macrotask is just its callback and `nextTick` a microtask.
 */
export function startEventLoop(): void {
  ticksEnabled = true;
  watchRejections();
}

/**
 * Reports an error a macrotask or a tick threw as the browser reports an
 * uncaught one (the `node` program emits 'uncaughtException'), and returns, so
 * the caller carries on as Node does. Where the platform cannot report one,
 * it is thrown.
 */
function reportThrown(error: unknown): void {
  if (platformReportError === null) {
    throw error;
  }
  platformReportError(error);
}

function holdForTurn(held: boolean): void {
  if (held && turnHold === null) {
    try {
      turnHold = runtime();
      turnHold.ref();
    } catch {
      turnHold = null;
    }
  } else if (!held && turnHold !== null) {
    const rt = turnHold;
    turnHold = null;
    rt.unref();
  }
}

/** Ticks or macrotasks are waiting for a round. */
function turnWork(): boolean {
  return ticks.length > 0 || waitingMacrotasks.length > 0;
}

/** A turn is posted, or work waits for one. */
function turnRunning(): boolean {
  return turnPosted || turnWork();
}

/** Starts the turn, unless it is posted or running already. */
function postTurn(): void {
  if (turnPosted) {
    return;
  }
  turnPosted = true;
  if (turnHasPriority && !turnFollowing) {
    // startTurn never throws (errors are reported), so the promise never rejects.
    void platformPostTask!(startTurn, TURN_PRIORITY);
  } else {
    postContinuation();
  }
}

/**
 * The turn's first round, at priority. Ticks that the promise jobs after it
 * queue continue the turn in a message (`turnFollowing`), where a round costs
 * far less than a task.
 */
function startTurn(): void {
  turnPosted = false;
  turnTasksRun += 1;
  if (!turnWork()) {
    // Run meanwhile (`runNextTicks`, a round in a macrotask's own task).
    turnEnded();
    return;
  }
  try {
    runRound();
  } finally {
    if (turnWork()) {
      // More waits already (macrotasks): after this round's promise jobs.
      postTurn();
    } else {
      turnFollowing = true;
      followHops = FOLLOW_HOPS;
      platformQueueMicrotask(followHop);
    }
  }
}

/**
 * Ends `turnFollowing` a few promise-job generations after the round: always
 * within this task's promise jobs, so a later task (the exit check's) never
 * starts a continuation, which holds the process. A turn nothing continued is
 * over here.
 */
function followHop(): void {
  followHops -= 1;
  if (followHops > 0) {
    platformQueueMicrotask(followHop);
    return;
  }
  turnFollowing = false;
  if (!turnPosted && !turnWork()) {
    turnEnded();
  }
}

/**
 * Posts the message that carries the turn on. It has no priority, so it holds
 * the process open until it runs: the exit check must not come first.
 */
function postContinuation(): void {
  if (turnPort === null) {
    const channel = new PlatformMessageChannel();
    turnPort = channel.port1;
    // The platform's own listeners, unwrapped: each is one round.
    for (let index = 0; index < ROUNDS_PER_TASK; index += 1) {
      const last = index === ROUNDS_PER_TASK - 1;
      nativeAddEventListener.call(channel.port2, "message", (event: Event) =>
        continueTurn(event, last),
      );
    }
    nativeStart.call(channel.port2);
    // Under Node (tests) a port with a listener would keep the loop alive.
    (channel.port2 as unknown as { unref?: () => void }).unref?.();
  }
  holdForTurn(true);
  nativePostMessage.call(turnPort, null);
}

/** One listener of a continuation message: one round, or the end of the turn. */
function continueTurn(event: Event, last: boolean): void {
  turnTasksRun += 1;
  if (!turnWork()) {
    nativeStopImmediatePropagation.call(event);
    turnPosted = false;
    holdForTurn(false);
    turnEnded();
    return;
  }
  if (awaitingPromiseJobs) {
    // No promise jobs ran since the last round (a platform that runs them only
    // between tasks, as Node does for a port's listeners): go on in a task.
    nativeStopImmediatePropagation.call(event);
    postContinuation();
    return;
  }
  try {
    runRound();
  } finally {
    if (last) {
      postContinuation();
    } else if (turnWork()) {
      // The next listener has work at once; it may start only after the
      // promise jobs this round queued.
      expectPromiseJobs();
    }
  }
}

/** Marks that the next round must come after the promise jobs queued so far. */
function expectPromiseJobs(): void {
  if (!awaitingPromiseJobs) {
    awaitingPromiseJobs = true;
    platformQueueMicrotask(promiseJobsRan);
  }
}

function promiseJobsRan(): void {
  awaitingPromiseJobs = false;
}

/**
 * One round: the waiting ticks, or else the oldest waiting macrotask. The
 * browser runs the promise jobs they queue before the next round.
 */
function runRound(): void {
  if (ticks.length > 0) {
    runTicks();
    return;
  }
  const next = waitingMacrotasks.shift();
  if (next === undefined) {
    return;
  }
  if (waitingReports.has(next)) {
    runCallback(next, undefined, undefined);
  } else {
    enterMacrotask(next, undefined, undefined);
  }
}

/** Runs the queued ticks, and the ticks they queue, in order. */
function runTicks(): void {
  if (runningTicks || ticks.length === 0) {
    return;
  }
  runningTicks = true;
  let index = 0;
  try {
    while (index < ticks.length) {
      const tick = ticks[index];
      index += 1;
      if (index >= TICKS_TRIM && index * 2 >= ticks.length) {
        // A long chain of ticks, each queueing the next, must not keep them all.
        ticks.splice(0, index);
        index = 0;
      }
      try {
        if (tick.args === undefined) {
          (tick.callback as () => unknown)();
        } else {
          (tick.callback as (...args: unknown[]) => unknown)(...tick.args);
        }
      } catch (error) {
        // Node reports it ('uncaughtException') and goes on with the next tick.
        reportThrown(error);
      }
    }
  } finally {
    ticks.splice(0, index);
    runningTicks = false;
    if (ticks.length > 0 && macrotaskDepth === 0) {
      // A tick threw and nothing could report it: the rest wait for the turn.
      postTurn();
    }
  }
}

/** Runs `callback` now: an error it throws is reported, then the ticks it queued run. */
function runCallback<T, A>(callback: (this: T, arg: A) => void, thisArg: T, arg: A): void {
  let failure: { error: unknown } | null = null;
  macrotaskDepth += 1;
  try {
    callback.call(thisArg, arg);
  } catch (error) {
    failure = { error };
  } finally {
    macrotaskDepth -= 1;
  }
  if (failure !== null) {
    if (platformReportError === null) {
      // It propagates; the ticks the callback queued wait for the turn.
      if (ticks.length > 0) {
        postTurn();
      }
      throw failure.error;
    }
    // Node emits 'uncaughtException' before it runs the callback's ticks.
    platformReportError(failure.error);
  }
  runTicks();
}

// ---------------------------------------------------------------------------
// The gate: what the `node` program's exit check asks before the next macrotask.

/** Asked as the next macrotask is about to start (`gateNextMacrotask`). */
let macrotaskGate: (() => boolean) | null = null;
/** Macrotasks kept back since the gate refused one, in order. */
let heldMacrotasks: (() => void)[] | null = null;

/**
 * How many of the process's refs the event loop itself holds: for a turn's
 * message on its way, and for rejections waiting to be reported. They keep
 * the exit check from coming first; none of them is work of the program's.
 */
export function eventLoopHolds(): number {
  return (turnHold === null ? 0 : 1) + (rejectionHold === null ? 0 : 1);
}

/**
 * Asks `goOn` once, as the next macrotask is about to start: the ticks and
 * the promise jobs of everything before it are done by then, so what holds
 * the process at that moment (beyond `eventLoopHolds`) is work still pending.
 * When `goOn` answers false, that macrotask and every later one wait: Node,
 * once it has found the loop empty after 'beforeExit', runs none either. The
 * returned function withdraws the question and lets the macrotasks that
 * waited run, in order.
 */
export function gateNextMacrotask(goOn: () => boolean): () => void {
  macrotaskGate = goOn;
  return () => {
    if (macrotaskGate === goOn) {
      macrotaskGate = null;
    }
    const held = heldMacrotasks;
    if (held === null) {
      return;
    }
    heldMacrotasks = null;
    if (held.length > 0) {
      for (const entry of held) {
        waitingMacrotasks.push(entry);
      }
      postTurn();
    }
  };
}

/** Runs `callback` as a macrotask now, unless the gate keeps it back. */
function enterMacrotask<T, A>(callback: (this: T, arg: A) => void, thisArg: T, arg: A): void {
  if (macrotaskGate !== null) {
    const goOn = macrotaskGate;
    macrotaskGate = null;
    if (!goOn()) {
      // The reports of rejections that wait are no macrotasks: they stay.
      const waiting = waitingMacrotasks.splice(0);
      heldMacrotasks = [() => callback.call(thisArg, arg)];
      for (const entry of waiting) {
        (waitingReports.has(entry) ? waitingMacrotasks : heldMacrotasks).push(entry);
      }
      return;
    }
  }
  followedEvent = null;
  runCallback(callback, thisArg, arg);
}

/** Runs `this(event)` as the macrotask of the platform's `event`. */
function runForEvent(this: (event: Event) => void, event: Event): void {
  followedEvent = event;
  this(event);
}

/**
 * True while the macrotask of the platform's `event` is in progress, as Node
 * counts it: its listeners are being dispatched (the browser runs the promise
 * jobs after each one before the dispatch ends), or the event loop is running
 * the ticks, and the promise jobs between them, that its task queued.
 */
export function inMacrotaskOf(event: Event): boolean {
  if (event.eventPhase !== EVENT_NONE) {
    return true;
  }
  return (
    event === followedEvent && (macrotaskDepth > 0 || runningTicks || turnPosted || turnFollowing)
  );
}

/**
 * Runs `callback` as one macrotask of Node's event loop. Ticks it queues run
 * as it returns, before promise jobs; an error it throws is reported as
 * uncaught first. When ticks queued from promise jobs are still waiting, those
 * run now and the callback waits, behind any macrotask waiting already, for
 * the promise jobs they queue. Called inside another macrotask or a tick, it
 * just runs the callback.
 */
export function runMacrotask(callback: () => void): void {
  runMacrotaskWith(callback, undefined, undefined);
}

/** `runMacrotask` for `callback.call(thisArg, arg)`, with no closure on the common path. */
function runMacrotaskWith<T, A>(callback: (this: T, arg: A) => void, thisArg: T, arg: A): void {
  if (!ticksEnabled || macrotaskDepth > 0 || runningTicks) {
    callback.call(thisArg, arg);
    return;
  }
  if (heldMacrotasks !== null) {
    heldMacrotasks.push(() => callback.call(thisArg, arg));
    return;
  }
  if (turnWork()) {
    waitingMacrotasks.push(() => callback.call(thisArg, arg));
    runTicks();
    // A round later in this task comes after the promise jobs of those ticks.
    expectPromiseJobs();
    postTurn();
    return;
  }
  enterMacrotask(callback, thisArg, arg);
}

/**
 * `runMacrotask` for an event listener: the listeners of a `dispatchEvent`
 * call made by program code (`dispatchFromProgram`) run as part of their
 * caller, as in Node; only an event the platform dispatched is a macrotask.
 * Given that `event`, the macrotask is its own (`inMacrotaskOf`).
 */
export function runEventListener(callback: () => void, event?: Event): void {
  if (programDispatches > 0) {
    callback();
  } else if (event === undefined) {
    runMacrotask(callback);
  } else {
    runMacrotaskWith(runForEvent, callback, event);
  }
}

/** Runs `dispatch`, a program's own `dispatchEvent`: its listeners are not macrotasks. */
export function dispatchFromProgram<T>(dispatch: () => T): T {
  programDispatches += 1;
  try {
    return dispatch();
  } finally {
    programDispatches -= 1;
  }
}

/**
 * `handler` for a port's `onmessage`, run as a macrotask. Ports recognise it
 * (`isMacrotaskHandler`) and set it as it is, without wrapping it again or
 * counting it as a program's listener.
 */
export function macrotaskHandler<E>(
  handler: (this: unknown, event: E) => void,
): (event: E) => void {
  const wrapped = function (this: unknown, event: E): void {
    runMacrotaskWith(handler, this, event);
  };
  (wrapped as unknown as Record<symbol, boolean>)[MACROTASK_HANDLER] = true;
  return wrapped;
}

/** True for a handler from `macrotaskHandler`. */
export function isMacrotaskHandler(handler: unknown): boolean {
  return (
    typeof handler === "function" &&
    (handler as unknown as Record<symbol, unknown>)[MACROTASK_HANDLER] === true
  );
}

/**
 * Listens on `target`, an object of the runtime's own, for the platform's
 * `type` events: each is a macrotask that runs `listener`. More listeners
 * follow it on the same event. The browser runs the promise jobs after each
 * listener, so each of those is a round for the ticks the jobs queued, and
 * such a tick costs no task. An event a program dispatched itself
 * (`dispatchFromProgram`) just runs `listener`, as part of its caller.
 */
export function addMacrotaskListener(
  target: EventTarget,
  type: string,
  listener: (event: Event) => void,
): void {
  nativeAddEventListener.call(target, type, (event: Event) => {
    if (programDispatches > 0) {
      listener(event);
      return;
    }
    roundAhead = ticksEnabled;
    runMacrotaskWith(runForEvent, listener, event);
  });
  for (let index = 0; index < ROUNDS_PER_TASK; index += 1) {
    const last = index === ROUNDS_PER_TASK - 1;
    nativeAddEventListener.call(target, type, (event: Event) => roundInMacrotask(event, last));
  }
}

/**
 * A source of the runtime's own macrotasks. The returned function queues one
 * run of `callback`, in a task of its own behind the tasks already queued: a
 * MessageChannel message (the browser does not clamp it as it does a timer),
 * listened to with `addMacrotaskListener`.
 */
export function macrotaskSource(callback: () => void): () => void {
  let port: MessagePort | null = null;
  return () => {
    if (port === null) {
      const channel = new PlatformMessageChannel();
      addMacrotaskListener(channel.port1, "message", callback);
      nativeStart.call(channel.port1);
      // Under Node (tests) a port with a listener would keep the loop alive.
      (channel.port1 as unknown as { unref?: () => void }).unref?.();
      port = channel.port2;
    }
    nativePostMessage.call(port, null);
  };
}

/** The jobs of `runBeforeQueuedTasks` where the platform has no task priorities, in order. */
const aheadJobs: (() => void)[] = [];
const postAheadJob = macrotaskSource(() => aheadJobs.shift()?.());

/**
 * Runs `job` as a macrotask once the current task, its ticks and its promise
 * jobs are done, ahead of the tasks already queued (messages, immediates), as
 * Node runs a closed handle's callback before the I/O that follows. Jobs run
 * in the order they were given. A platform without task priorities runs it
 * behind the tasks queued so far.
 */
export function runBeforeQueuedTasks(job: () => void): void {
  if (platformPostTask === null) {
    aheadJobs.push(job);
    postAheadJob();
    return;
  }
  // `runMacrotask` reports what `job` throws, so the promise never rejects.
  void platformPostTask(() => runMacrotask(job), TURN_PRIORITY);
}

/**
 * Counts one hold on the process and returns what lets it go, once; nothing
 * where there is no runtime (a module used outside a process).
 */
export function holdProcess(): () => void {
  let rt: ProcessRuntime;
  try {
    rt = runtime();
  } catch {
    return () => {};
  }
  rt.ref();
  let held = true;
  return () => {
    if (held) {
      held = false;
      rt.unref();
    }
  };
}

/** A listener after a macrotask's own, in the same task: one round, if anything waits. */
function roundInMacrotask(event: Event, last: boolean): void {
  if (programDispatches > 0) {
    return;
  }
  roundAhead = false;
  if (!turnWork() || awaitingPromiseJobs) {
    // Nothing to run; or no promise jobs ran since the last listener (a
    // platform that runs them only between tasks, as Node does for a port's
    // listeners), and then what waits needs a task.
    nativeStopImmediatePropagation.call(event);
    if (turnWork()) {
      postTurn();
    }
    return;
  }
  turnTasksRun += 1;
  roundAhead = !last;
  try {
    runRound();
  } finally {
    if (turnWork()) {
      if (last) {
        postTurn();
      } else {
        expectPromiseJobs();
      }
    }
  }
}

/**
 * Runs the queued `process.nextTick` callbacks now. A caller that runs a
 * macrotask's callback itself (the `node` program, after the entry module)
 * calls this as the callback returns, so ticks run before promise jobs.
 */
export function runNextTicks(): void {
  runTicks();
}

/** Queues `callback(...args)` for `process.nextTick`, in the async context current now. */
export function queueTick(callback: AnyFunction, args: unknown[]): void {
  ticks.push({
    callback: bindToCurrentContext(callback),
    args: args.length === 0 ? undefined : args,
  });
  if (macrotaskDepth === 0 && !runningTicks && !roundAhead) {
    // Queued from a promise job (or a callback nobody wrapped): it runs in
    // the turn, once the promise jobs are done.
    if (
      followedEvent !== null &&
      !turnPosted &&
      !turnFollowing &&
      followedEvent.eventPhase === EVENT_NONE
    ) {
      // Not from the promise jobs of that event's task: from a later task.
      followedEvent = null;
    }
    postTurn();
  }
}

/**
 * `process.nextTick` for the runtime's own modules, which defer with it where
 * Node's do. Before there is a process (the shell, npm) it is a microtask.
 */
export function nextTick(callback: AnyFunction, ...args: unknown[]): void {
  if (ticksEnabled) {
    queueTick(callback, args);
  } else {
    platformQueueMicrotask(() => (callback as (...args: unknown[]) => unknown)(...args));
  }
}

/**
 * Reports `error` as uncaught and returns, for a caller that runs several
 * listeners of one event and goes on with the next, as Node's EventTarget does.
 */
export function reportUncaughtError(error: unknown): void {
  reportThrown(error);
}

// ---------------------------------------------------------------------------
// After the turn.
//
// Some work waits until no turn is running: until every round of ticks and
// promise jobs is done, and the tasks the browser queued meanwhile (its
// 'rejectionhandled' events) have run. Such work runs in a task posted at the
// end of the turn, or, when no turn is running, posted after the last of the
// turn's tasks had run. Other work (the report of rejections) waits only for
// the turn in flight: it runs in a task posted as that turn ends, whatever
// turns later macrotasks have started by then.

const afterTurnCallbacks: (() => void)[] = [];
/** What waits for the turn in flight to end, and for no later one. */
const turnEndCallbacks: (() => void)[] = [];
/** The message that says a turn has ended, where the others say how many turn tasks had run. */
const TURN_ENDED = -1;
/** An after-turn message is on its way. */
let afterTurnPosted = false;
/** The turn running now posts the after-turn message as it ends. */
let afterTurnAtEnd = false;
let afterTurnPort: MessagePort | null = null;

/**
 * Runs `callback` in a task once no turn is running (see above). Called from
 * a task that is not one of the turn's own.
 */
export function afterTurn(callback: () => void): void {
  afterTurnCallbacks.push(callback);
  if (!afterTurnPosted && !afterTurnAtEnd) {
    postAfterTurn();
  }
}

/** Runs `callback` in a task once the turn in flight is over. Called while one is. */
function afterThisTurn(callback: () => void): void {
  turnEndCallbacks.push(callback);
}

function postAfterTurnMessage(message: number): void {
  if (afterTurnPort === null) {
    const channel = new PlatformMessageChannel();
    afterTurnPort = channel.port1;
    nativeAddEventListener.call(channel.port2, "message", (event: Event) =>
      runAfterTurn((event as MessageEvent<number>).data),
    );
    nativeStart.call(channel.port2);
    // Under Node (tests) a port with a listener would keep the loop alive.
    (channel.port2 as unknown as { unref?: () => void }).unref?.();
  }
  nativePostMessage.call(afterTurnPort, message);
}

function postAfterTurn(): void {
  afterTurnPosted = true;
  postAfterTurnMessage(turnTasksRun);
}

function runCallbacks(callbacks: (() => void)[]): void {
  for (const callback of callbacks.splice(0)) {
    try {
      callback();
    } catch (error) {
      reportThrown(error);
    }
  }
}

/** `postedAt`: how many of the turn's tasks had run when the message was posted, or TURN_ENDED. */
function runAfterTurn(postedAt: number): void {
  if (postedAt === TURN_ENDED) {
    runCallbacks(turnEndCallbacks);
    return;
  }
  afterTurnPosted = false;
  if (turnRunning()) {
    // Every way a turn ends calls `turnEnded`.
    afterTurnAtEnd = true;
    return;
  }
  if (postedAt !== turnTasksRun) {
    // A turn ran after this was posted: what it queued may come after this
    // message, but not after the next.
    postAfterTurn();
    return;
  }
  runCallbacks(afterTurnCallbacks);
}

/** A turn is over: the work waiting for it goes after the tasks it queued. */
function turnEnded(): void {
  if (afterTurnAtEnd) {
    afterTurnAtEnd = false;
    postAfterTurn();
  }
  if (turnEndCallbacks.length > 0) {
    postAfterTurnMessage(TURN_ENDED);
  }
}

// ---------------------------------------------------------------------------
// Unhandled rejections.
//
// Node looks for rejected promises nobody handles once a macrotask's ticks and
// promise jobs are all done, and emits 'unhandledRejection' for all of them
// (or 'rejectionHandled', for one handled after that) as part of that
// macrotask: the ticks its listeners queue run before their promise jobs. The
// browser reports the rejections of a task in a task of its own, one event
// each, after the tasks that were queued before it; and that task can come
// between two rounds of a turn, before a later round handles the promise. So
// the platform's events are stopped here, before any other listener, and
// dispatched again, as copies, together: right after the browser's task when
// no turn is running, else once that turn is over, unless the browser has said
// by then that the promise got a handler.

const PlatformRejectionEvent = (
  globalThis as { PromiseRejectionEvent?: typeof PromiseRejectionEvent }
).PromiseRejectionEvent;
const platformGlobal = globalThis as unknown as Partial<EventTarget>;
const platformDispatchEvent =
  typeof platformGlobal.dispatchEvent === "function"
    ? platformGlobal.dispatchEvent.bind(globalThis)
    : null;

/** Rejections the browser reported, not handled since, waiting to be reported together. */
const heldRejections: { promise: Promise<unknown>; reason: unknown }[] = [];
/** The copies dispatched here, which the listener below lets through. */
const rejectionCopies = new WeakSet<Event>();
/** `releaseRejections` is on its way. */
let releasePending = false;
/** The runtime held while rejections wait for a turn to end: the exit check must not come first. */
let rejectionHold: ProcessRuntime | null = null;
let rejectionsWatched = false;

function watchRejections(): void {
  if (
    rejectionsWatched ||
    PlatformRejectionEvent === undefined ||
    platformDispatchEvent === null ||
    typeof platformGlobal.addEventListener !== "function"
  ) {
    return;
  }
  rejectionsWatched = true;
  // Capturing: on the global it runs before every other listener.
  platformGlobal.addEventListener("unhandledrejection", onPlatformRejection, true);
  platformGlobal.addEventListener("rejectionhandled", onPlatformRejection, true);
}

function onPlatformRejection(event: Event): void {
  if (rejectionCopies.has(event)) {
    return;
  }
  nativeStopImmediatePropagation.call(event);
  const { promise, reason } = event as PromiseRejectionEvent;
  if (event.type === "rejectionhandled") {
    const index = heldRejections.findIndex((held) => held.promise === promise);
    if (index >= 0) {
      // Handled before it was reported: Node never reports it.
      heldRejections.splice(index, 1);
      return;
    }
    runMacrotask(() => dispatchRejection("rejectionhandled", promise, reason));
    return;
  }
  event.preventDefault();
  heldRejections.push({ promise, reason });
  if (releasePending) {
    return;
  }
  if (turnRunning()) {
    releasePending = true;
    releaseAfterTurn();
  } else if (platformPostTask !== null) {
    // After the other rejections the browser reports in this task, and ahead
    // of the tasks already queued.
    releasePending = true;
    void platformPostTask(releaseRejections, TURN_PRIORITY);
  } else {
    releaseRejections();
  }
}

function releaseAfterTurn(): void {
  if (rejectionHold === null) {
    try {
      rejectionHold = runtime();
      rejectionHold.ref();
    } catch {
      rejectionHold = null;
    }
  }
  afterThisTurn(releaseRejections);
}

/** Reports the held rejections nobody handled meanwhile, in one go, as Node does. */
function releaseRejections(): void {
  releasePending = false;
  const rt = rejectionHold;
  rejectionHold = null;
  const reports = heldRejections.splice(0);
  if (reports.length > 0) {
    runReport(() => {
      for (const { promise, reason } of reports) {
        dispatchRejection("unhandledrejection", promise, reason);
      }
    });
  }
  rt?.unref();
}

/**
 * Runs `report`, the report of rejections: part of the macrotask that
 * rejected them, not a macrotask of its own, so the gate is not asked. The
 * ticks its listeners queue run before their promise jobs. Ticks a later
 * macrotask left waiting come first, with their promise jobs.
 */
function runReport(report: () => void): void {
  if (!turnWork()) {
    runCallback(report, undefined, undefined);
    return;
  }
  waitingReports.add(report);
  waitingMacrotasks.push(report);
  runTicks();
  expectPromiseJobs();
  postTurn();
}

function dispatchRejection(type: string, promise: Promise<unknown>, reason: unknown): void {
  const copy = new PlatformRejectionEvent!(type, { promise, reason, cancelable: true });
  rejectionCopies.add(copy);
  platformDispatchEvent!(copy);
}
