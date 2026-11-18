// Node's `worker_threads`. A worker thread is another worker the kernel starts
// for this process: it shares the process's pid and file descriptors and
// talks to its parent over a MessagePort. Browser MessagePorts are taught
// Node's `on("message", value => …)` interface, so a port received in a
// message works like one created here. A message, and a peer's close, is a
// macrotask (eventLoop.ts): the nextTick callbacks its listeners queue run as
// they return. BroadcastChannel gets the same interface and, as in Node,
// reaches only the threads of its own process.
import { watchReportMessage, watchReportsIn, watchReportsWanted } from "../programs/watchReport";
import { runtime, type ThreadHandle } from "../runtime";
import {
  addMacrotaskListener,
  dispatchFromProgram,
  holdProcess,
  inMacrotaskOf,
  isMacrotaskHandler,
  macrotaskHandler,
  macrotaskSource,
  reportUncaughtError,
  runEventListener,
  runMacrotask,
  runBeforeQueuedTasks,
  runNextTicks,
} from "./eventLoop";
import EventEmitter from "./events";
import type { EventEmitter as EventEmitterInstance } from "./events";
import { processBroadcast, type BroadcastHub } from "./internal/broadcastHub";
import { invalidArgType, missingArgs } from "./internalErrors";
import path from "./path";
import type { NodeProcess } from "./process";
import type { Readable, Writable } from "./stream";
import { connectThreadStdio, createWorkerStdio, type KeptStdio } from "./threadStdio";

type Listener = (...args: unknown[]) => void;

interface NodePort extends MessagePort {
  on(event: string, listener: Listener): this;
  once(event: string, listener: Listener): this;
  off(event: string, listener: Listener): this;
  addListener(event: string, listener: Listener): this;
  removeListener(event: string, listener: Listener): this;
  removeAllListeners(event?: string): this;
  emit(event: string, ...args: unknown[]): boolean;
  listenerCount(event: string): number;
  ref(): void;
  unref(): void;
}

/** A program's 'message' listener on a port. */
interface MessageListener {
  /** Added with `on`/`once` (called with the data), `addEventListener` (with the event), or `onmessage`. */
  kind: "node" | "event" | "handler";
  listener: unknown;
  once: boolean;
  /** Removed since: a message that arrived before is not given to it. */
  removed: boolean;
}

interface PortState {
  /** Node-style listeners of events other than 'message'. */
  listeners: Map<string, { listener: Listener; native: EventListener }[]>;
  /**
   * The program's 'message' listeners of every kind, in the order they were
   * added: one listener of the platform's calls them all, so that a message
   * is one macrotask, as in Node.
   */
  messageListeners: MessageListener[];
  reffed: boolean;
  /**
   * The port holds the process open. A MessagePort: set by `ref()` and by its
   * first message listener of any kind, cleared by `unref()` and when its last
   * one goes. A BroadcastChannel: from its construction until `unref()`.
   */
  wantsRef: boolean;
  /** `onmessage` as it was set, when it was set through Node's interface. */
  onmessage: { value: unknown } | null;
  /** This end, or the one it is entangled with, was closed. */
  closed: boolean;
  /** The 'close' event this port dispatched to its listeners. */
  closeEvent: Event | null;
  /** The platform's listeners that deliver messages and notice the other end closing are installed. */
  watching: boolean;
  /**
   * The port carries a protocol of its user's own: `onmessage` was set, or
   * the platform listens on it (a socket, IPC, a thread's control port). Its
   * peer reads every message as its own, so closing it posts nothing.
   */
  raw: boolean;
  /**
   * Messages that came while the port had no listener after its last one
   * went: as in Node, where the port stops then, they wait for the next
   * listener. Null while the port delivers as messages come.
   */
  backlog: MessageEvent[] | null;
  /** The backlog is being delivered, a message a macrotask. */
  flushing: boolean;
  /** The 'message' event a listener stopped: the listeners after it are not called. */
  stopped: Event | null;
  /**
   * The last message given to the program's listeners: while its macrotask is
   * in progress (eventLoop.ts `inMacrotaskOf`), they are delivering.
   */
  delivering: Event | null;
  /**
   * Closed while delivering a message: as in Node, the messages it had
   * received by then still reach its listeners, and the platform's port
   * closes behind them.
   */
  draining: boolean;
  /** The platform's port was started: by a message listener, by `start()`, or to hear its peer close. */
  started: boolean;
  /**
   * The other end closed while messages waited for a listener: as in Node,
   * this end closes and emits 'close' once they are delivered or dropped.
   */
  peerClosed: boolean;
}

const portStates = new WeakMap<object, PortState>();

function stateOf(port: object): PortState {
  let state = portStates.get(port);
  if (!state) {
    state = {
      listeners: new Map(),
      messageListeners: [],
      reffed: false,
      wantsRef: false,
      onmessage: null,
      closed: false,
      closeEvent: null,
      watching: false,
      raw: false,
      backlog: null,
      flushing: false,
      stopped: null,
      delivering: null,
      draining: false,
      started: false,
      peerClosed: false,
    };
    portStates.set(port, state);
  }
  return state;
}

/**
 * Holds or releases the process for `port`. As in Node, a port holds it after
 * `ref()` or while it has a message listener, until `unref()` or the port closes.
 */
function updateRef(port: object): void {
  const state = stateOf(port);
  const wanted = state.wantsRef && !state.closed;
  if (wanted !== state.reffed) {
    state.reffed = wanted;
    try {
      if (wanted) {
        runtime().ref();
      } else {
        runtime().unref();
      }
    } catch {
      // No runtime: nothing to keep alive.
    }
  }
}

// The platform's own, captured now: a program may replace the global, and its
// test spy may replace `start` on the prototype and not call through.
const PlatformMessagePort = MessagePort;
const platformStructuredClone = structuredClone;
const nativeStart = PlatformMessagePort.prototype.start;

/**
 * Listens to `port`, which carries one of the platform's own protocols (a
 * thread's control port, an IPC channel), with `handler`. Each message is a
 * macrotask. Unlike a program's listener it does not hold the process: its
 * owner decides that. Closing the port posts nothing to the other end.
 */
export function listenOnPlatformPort(
  port: MessagePort,
  handler: (event: MessageEvent) => void,
): void {
  const state = stateOf(port);
  state.raw = true;
  state.wantsRef = false;
  updateRef(port);
  addMacrotaskListener(port, "message", (event) => {
    // A port the program transferred through it may carry what it held.
    receiveCarried(event);
    handler(event as MessageEvent);
  });
  startPlatformPort(port);
}

/** Starts `port` with the platform's own `start`, where it is the platform's kind of port. */
function startPlatformPort(port: { start(): void }): void {
  if (port instanceof PlatformMessagePort) {
    nativeStart.call(port);
  } else {
    port.start();
  }
}

/**
 * What a closing port posts to the other end first, so that end emits 'close'
 * and lets the process go, as in Node. Browsers have no reliable close event.
 */
const PORT_CLOSE_KEY = "__webnodePortClose__";

/** True for the message a port's peer posts as it closes. */
export function isPortCloseMessage(data: unknown): boolean {
  return (
    data !== null &&
    typeof data === "object" &&
    (data as Record<string, unknown>)[PORT_CLOSE_KEY] === true
  );
}

/** What waits for the event loop: held messages, and the close of a peer that waited behind them. */
const deferred: (() => void)[] = [];
const runDeferred = macrotaskSource(() => {
  // Everything queued by now, in order. The platform gives a port's second
  // message a task behind the messages other ports have got meanwhile, so a
  // job left for it would run after events that were queued later.
  const jobs = deferred.splice(0);
  for (let index = 0; index < jobs.length; index += 1) {
    if (index > 0) {
      runNextTicks();
    }
    jobs[index]();
  }
});

/** Runs `job` from the event loop, behind the macrotasks queued already. */
function defer(job: () => void): void {
  deferred.push(job);
  runDeferred();
}

/**
 * Throws Node's DataCloneError when `transfer` (a transfer list, or options
 * with one) holds a port that was closed: the platform would move it, and a
 * port closed while delivering still has an open platform port.
 */
function refuseClosedPorts(transfer: unknown): void {
  refuseClosedPortsIn(
    transfer !== null && typeof transfer === "object" && !Array.isArray(transfer)
      ? (transfer as { transfer?: unknown }).transfer
      : transfer,
  );
}

/** `refuseClosedPorts` for `structuredClone(value, options)`, whose options carry the transfer list. */
export function refuseClosedPortsToClone(options: unknown): void {
  if (options !== null && typeof options === "object") {
    refuseClosedPortsIn((options as { transfer?: unknown }).transfer);
  }
}

function refuseClosedPortsIn(list: unknown): void {
  if (!Array.isArray(list)) {
    return;
  }
  for (const item of list) {
    if (item !== null && typeof item === "object" && portStates.get(item)?.closed === true) {
      throw new DOMException("MessagePort in transfer list is already detached", "DataCloneError");
    }
  }
}

/** The transfer list `transfer` names: the list itself, or the one its options carry. */
function transferListOf(transfer: unknown): unknown[] {
  const list =
    transfer !== null && typeof transfer === "object" && !Array.isArray(transfer)
      ? (transfer as { transfer?: unknown }).transfer
      : transfer;
  return Array.isArray(list) ? list : [];
}

/** A message a port holds for its next listener, as it crosses with the port. */
interface CarriedMessage {
  data: unknown;
  ports: readonly MessagePort[];
}

/**
 * What a transferred port held in JS for its next listener (`backlog`): as in
 * Node, where those messages wait in the port itself, they go where the port
 * goes, ahead of what the platform's port still has.
 */
interface CarriedBacklog {
  port: MessagePort;
  messages: CarriedMessage[];
  /** Its peer had closed behind them. */
  peerClosed: boolean;
}

/** Marks a message that carries the backlogs of the ports it transfers. */
const CARRIED_KEY = "__webnodeCarriedBacklogs__";

interface CarryingMessage {
  [CARRIED_KEY]: true;
  value: unknown;
  backlogs: CarriedBacklog[];
}

/**
 * The backlogs of the ports in `list` that hold messages, and the ports those
 * messages carry (they must be transferred too), or null when none holds any.
 * Nothing is taken: `dropCarried` does that once the transfer succeeded.
 */
function backlogsIn(list: unknown[]): { backlogs: CarriedBacklog[]; ports: MessagePort[] } | null {
  let found: { backlogs: CarriedBacklog[]; ports: MessagePort[] } | null = null;
  for (const item of list) {
    const state = item !== null && typeof item === "object" ? portStates.get(item) : undefined;
    if (state === undefined || state.backlog === null || state.backlog.length === 0) {
      continue;
    }
    found ??= { backlogs: [], ports: [] };
    const messages = state.backlog.map((event) => ({ data: event.data, ports: event.ports }));
    for (const message of messages) {
      found.ports.push(...message.ports);
    }
    found.backlogs.push({ port: item as MessagePort, messages, peerClosed: state.peerClosed });
  }
  return found;
}

/** The ports of `backlogs` left: what they held went with them. */
function dropCarried(backlogs: CarriedBacklog[]): void {
  for (const { port } of backlogs) {
    const state = stateOf(port);
    state.backlog = null;
    state.peerClosed = false;
  }
}

/** Gives the ports that arrived in a message the backlogs they carried, for their next listener. */
function adoptBacklogs(backlogs: CarriedBacklog[]): void {
  for (const { port, messages, peerClosed } of backlogs) {
    const state = stateOf(port);
    const held = messages.map(
      ({ data, ports }) => new MessageEvent("message", { data, ports: [...ports] }),
    );
    state.backlog = state.backlog === null ? held : [...held, ...state.backlog];
    state.peerClosed ||= peerClosed;
  }
}

function isCarrying(data: unknown): data is CarryingMessage {
  return (
    data !== null &&
    typeof data === "object" &&
    (data as Record<string, unknown>)[CARRIED_KEY] === true
  );
}

/**
 * Unwraps `event` when it carries the backlogs of the ports it transferred:
 * the ports get them and the event's data becomes the program's value.
 */
function receiveCarried(event: Event): void {
  const data = (event as MessageEvent).data;
  if (isCarrying(data)) {
    adoptBacklogs(data.backlogs);
    Object.defineProperty(event, "data", { configurable: true, value: data.value });
  }
}

/**
 * Sends `message` with `transfer` through `send`. The ports transferred take
 * the messages they hold with them: the message then carries them, and the
 * port that receives it unwraps it (`receiveCarried`).
 */
function sendCarrying(
  message: unknown,
  transfer: unknown,
  send: (message: unknown, transfer: unknown) => void,
): void {
  const found = backlogsIn(transferListOf(transfer));
  if (found === null) {
    send(message, transfer);
    return;
  }
  const carrying: CarryingMessage = {
    [CARRIED_KEY]: true,
    value: message,
    backlogs: found.backlogs,
  };
  const list = [...transferListOf(transfer), ...found.ports];
  send(
    carrying,
    transfer !== null && typeof transfer === "object" && !Array.isArray(transfer)
      ? { ...transfer, transfer: list }
      : list,
  );
  dropCarried(found.backlogs);
}

/**
 * `structuredClone(value, options)` as Node has it for ports: a closed one in
 * the transfer list is refused, and one that holds messages keeps them.
 */
export function cloneWithPorts(
  clone: (value: unknown, options?: StructuredSerializeOptions) => unknown,
  value: unknown,
  options?: StructuredSerializeOptions,
): unknown {
  refuseClosedPortsToClone(options);
  let result: unknown;
  sendCarrying(value, options, (message, transfer) => {
    result = clone(message, transfer as StructuredSerializeOptions | undefined);
  });
  if (isCarrying(result)) {
    adoptBacklogs(result.backlogs);
    return result.value;
  }
  return result;
}

/** Jobs that wait behind the messages ports have received, one a message of their own. */
const behindJobs: (() => void)[] = [];
const runBehindJob = macrotaskSource(() => behindJobs.shift()?.());

/**
 * Runs `job` in a task of its own once the messages every port of this
 * worker has received by now are delivered. The platform gives a port's
 * first message a task alone and queues the ones that came with it after the
 * tasks posted meanwhile; a message posted from a task behind those comes
 * after them all. So the job waits two messages of its own.
 */
export function behindReceivedMessages(job: () => void): void {
  behindJobs.push(() => {
    behindJobs.push(job);
    runBehindJob();
  });
  runBehindJob();
}

const platformQueueMicrotask = queueMicrotask.bind(globalThis);

let messageEventsShielded = false;

/**
 * Every program listener of a port's 'message' is called by one listener of
 * the platform's, so `stopImmediatePropagation()` on such an event stops the
 * program's later listeners and nothing else: the platform's listeners behind
 * ours carry the event loop on (eventLoop.ts `addMacrotaskListener`).
 */
function shieldPortMessageEvents(): void {
  if (messageEventsShielded || typeof MessageEvent === "undefined") {
    return;
  }
  messageEventsShielded = true;
  const native = MessageEvent.prototype.stopImmediatePropagation;
  Object.defineProperty(MessageEvent.prototype, "stopImmediatePropagation", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: function stopImmediatePropagation(this: MessageEvent): void {
      const state =
        this.type === "message" && this.target !== null ? portStates.get(this.target) : undefined;
      if (state?.watching) {
        state.stopped = this;
      } else {
        native.call(this);
      }
    },
  });
}

/** The class of the 'close' event a port emits, by Node's name. */
class MessagePortCloseEvent extends Event {}

/** How many messages a port delivers before its listener becomes the event loop's own kind (`watch`). */
const MESSAGES_BEFORE_ROUNDS = 16;

/** How a kind of port differs: a MessagePort has one other end, a BroadcastChannel has none. */
type PortKind = "paired" | "broadcast";

/**
 * Gives the ports made from `prototype` (an EventTarget with `postMessage`
 * and `close`) Node's interface: every listener of a message runs in one
 * macrotask, and `ref`/`unref`/`close` decide whether the port holds the
 * process.
 *
 * A paired port (a MessagePort) also gets Node's `on`/`once`/`off`/`emit`.
 * Its first 'message' listener of any kind starts it and holds the process,
 * its last one to go stops it and lets go; closing it tells the other end,
 * and both emit 'close'. A broadcast port is an EventTarget only, as Node's
 * BroadcastChannel is; it tells nobody of its close and emits no 'close'.
 */
export function addNodePortInterface(prototype: object, kind: PortKind = "paired"): void {
  shieldPortMessageEvents();
  const paired = kind === "paired";
  const nativeClose = (prototype as { close: () => void }).close;
  const nativePostMessage = (
    prototype as { postMessage: (message: unknown, transfer?: unknown) => void }
  ).postMessage;
  const nativeAddEventListener = (prototype as EventTarget).addEventListener;
  const nativeRemoveEventListener = (prototype as EventTarget).removeEventListener;
  const nativeDispatchEvent = (prototype as EventTarget).dispatchEvent;
  // A BroadcastChannel has no `start`: it delivers from its construction.
  const start = (prototype as { start?: () => void }).start;

  /**
   * A paired port's first message listener, of whichever kind, holds the
   * process and the last one to go releases it; `unref()` in between wins.
   */
  const messageListenersChanged = (port: object, before: number) => {
    const state = stateOf(port);
    const after = state.messageListeners.length;
    if (paired) {
      if (before === 0 && after > 0) {
        state.wantsRef = true;
      } else if (before > 0 && after === 0) {
        state.wantsRef = false;
        // Stopped: what comes now waits for the next listener.
        state.backlog ??= [];
      }
    }
    updateRef(port);
  };

  const addMessageListener = (port: NodePort, entry: MessageListener) => {
    const state = stateOf(port);
    const before = state.messageListeners.length;
    watch(port);
    state.messageListeners.push(entry);
    messageListenersChanged(port, before);
    // A listener of any kind starts the port, as in Node.
    state.started = true;
    start?.call(port);
    flushBacklog(port);
  };

  const removeMessageListener = (port: object, entry: MessageListener) => {
    const state = stateOf(port);
    const index = state.messageListeners.indexOf(entry);
    if (index >= 0) {
      const before = state.messageListeners.length;
      entry.removed = true;
      state.messageListeners.splice(index, 1);
      messageListenersChanged(port, before);
    }
  };

  /** The program's listener `listener` of `kind`, if it is on `port`. */
  const findMessageListener = (port: object, kind: MessageListener["kind"], listener: unknown) =>
    stateOf(port).messageListeners.find(
      (entry) => entry.kind === kind && (kind === "handler" || entry.listener === listener),
    );

  const callMessageListener = (port: NodePort, entry: MessageListener, event: MessageEvent) => {
    if (entry.once) {
      removeMessageListener(port, entry);
    }
    const { listener } = entry;
    try {
      if (entry.kind === "node") {
        (listener as Listener).call(port, event.data);
      } else if (typeof listener === "function") {
        (listener as (event: Event) => void).call(port, event);
      } else {
        (listener as EventListenerObject).handleEvent(event);
      }
    } catch (error) {
      // Reported, and the next listener still runs, as in Node.
      reportUncaughtError(error);
    }
  };

  /**
   * Gives one message to every listener the program has on `port` now. It may
   * run later than the message came, after ticks that were waiting
   * (eventLoop.ts `runMacrotask`): a listener they removed gets nothing, as
   * in Node. Nor does a port they closed, unless they closed it while it
   * was delivering (`draining`).
   */
  const deliverMessage = (port: NodePort, state: PortState, event: MessageEvent) => {
    if (state.closed && !state.draining) {
      return;
    }
    state.delivering = event;
    const listeners = state.messageListeners;
    if (listeners.length === 1) {
      callMessageListener(port, listeners[0], event);
      return;
    }
    state.stopped = null;
    for (const entry of listeners.slice()) {
      if (state.stopped === event) {
        break;
      }
      if (entry.removed) {
        continue;
      }
      callMessageListener(port, entry, event);
    }
    state.stopped = null;
  };

  /** One held message to the listeners, in a macrotask; the rest follow it while there is a listener. */
  const flushStep = (port: NodePort) => {
    const state = stateOf(port);
    const backlog = state.backlog;
    if (backlog === null || state.closed || state.messageListeners.length === 0) {
      // Closed, or stopped again: what is left waits, or is never delivered.
      state.flushing = false;
      return;
    }
    const event = backlog.shift();
    if (event !== undefined) {
      deliverMessage(port, state, event);
    }
    if (state.messageListeners.length === 0) {
      state.flushing = false;
    } else if (backlog.length === 0) {
      state.backlog = null;
      state.flushing = false;
      if (state.peerClosed) {
        // A macrotask of its own, after the ticks of the last message.
        defer(() => closedByPeer(port));
      }
    } else {
      defer(() => flushStep(port));
    }
  };

  /** Starts delivering what `port` held while it had no listener. */
  const flushBacklog = (port: NodePort) => {
    const state = stateOf(port);
    if (state.backlog === null || state.flushing) {
      return;
    }
    if (state.backlog.length === 0) {
      state.backlog = null;
      return;
    }
    state.flushing = true;
    defer(() => flushStep(port));
  };

  if (paired) {
    Object.assign(prototype, {
      postMessage(this: NodePort, message: unknown, transfer?: unknown) {
        if (arguments.length < 2) {
          nativePostMessage.call(this, message);
          return;
        }
        refuseClosedPorts(transfer);
        sendCarrying(message, transfer, (carried, list) =>
          nativePostMessage.call(this, carried, list),
        );
      },
    });
  }

  // A program's own dispatchEvent runs the listeners as part of its caller.
  Object.assign(prototype, {
    dispatchEvent(this: EventTarget, event: Event) {
      return dispatchFromProgram(() => nativeDispatchEvent.call(this, event));
    },
  });

  if (start !== undefined) {
    Object.assign(prototype, {
      start(this: NodePort) {
        const state = stateOf(this);
        state.started = true;
        if (state.messageListeners.length === 0) {
          // Started with nobody listening: what waited is dropped, as in Node,
          // and a close of the other end that waited behind it comes.
          state.backlog = null;
          if (state.peerClosed) {
            defer(() => closedByPeer(this));
          }
        }
        start.call(this);
      },
    });
  }

  const onmessage = Object.getOwnPropertyDescriptor(prototype, "onmessage");
  if (onmessage?.set && onmessage.get && onmessage.configurable) {
    const { get, set } = onmessage;
    Object.defineProperty(prototype, "onmessage", {
      configurable: true,
      enumerable: onmessage.enumerable,
      get(this: object) {
        const assigned = portStates.get(this)?.onmessage;
        return assigned ? assigned.value : get.call(this);
      },
      set(this: NodePort, handler: unknown) {
        const state = stateOf(this);
        state.raw = true;
        state.onmessage = { value: handler };
        // The runtime's own handlers (`macrotaskHandler`) run as macrotasks
        // already and do not hold the process: the platform calls them. A
        // program's is one of the port's message listeners.
        const program = typeof handler === "function" && !isMacrotaskHandler(handler);
        set.call(this, program ? null : handler);
        const entry = findMessageListener(this, "handler", null);
        if (!program) {
          if (entry !== undefined) {
            removeMessageListener(this, entry);
          }
          return;
        }
        if (entry === undefined) {
          addMessageListener(this, {
            kind: "handler",
            listener: handler,
            once: false,
            removed: false,
          });
        } else {
          // A new handler keeps the old one's place, as an event handler does.
          entry.listener = handler;
        }
      },
    });
  }

  Object.assign(prototype, {
    addEventListener(
      this: NodePort,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type !== "message" || listener === null) {
        if (type === "close") {
          // Ours first: it keeps the platform's own close event to itself.
          watchPeerClose(this);
        }
        nativeAddEventListener.call(this, type, listener, options);
        return;
      }
      const signal = typeof options === "object" ? options.signal : undefined;
      if (findMessageListener(this, "event", listener) !== undefined || signal?.aborted) {
        return;
      }
      const entry: MessageListener = {
        kind: "event",
        listener,
        once: typeof options === "object" && options.once === true,
        removed: false,
      };
      addMessageListener(this, entry);
      signal?.addEventListener("abort", () => removeMessageListener(this, entry), { once: true });
    },
    removeEventListener(
      this: NodePort,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      const entry = type === "message" ? findMessageListener(this, "event", listener) : undefined;
      if (entry === undefined) {
        nativeRemoveEventListener.call(this, type, listener, options);
        return;
      }
      removeMessageListener(this, entry);
    },
  });

  /**
   * Emits 'close' on `port`: an event dispatched to the listeners of both
   * kinds, in the order they were added. A port closes once, so this runs once.
   */
  const emitClose = (port: NodePort) => {
    const event = new MessagePortCloseEvent("close");
    stateOf(port).closeEvent = event;
    nativeDispatchEvent.call(port, event);
  };

  /** The other end closed, or went with its thread: this end closes too and emits 'close'. */
  const closedByPeer = (port: NodePort) => {
    const state = stateOf(port);
    if (state.closed) {
      return;
    }
    nativeClose.call(port);
    state.closed = true;
    state.backlog = null;
    updateRef(port);
    emitClose(port);
  };

  /**
   * Closes `port`, which its own listeners closed while it delivered a
   * message, as Node does then: it sends nothing more and no longer holds the
   * process for its listeners, but what it had received (and what its peer
   * posts before the caller's task ends) still reaches them; then the
   * platform's port closes, the other end is told, and 'close' is emitted.
   */
  const drain = (port: NodePort, state: PortState) => {
    state.closed = true;
    state.draining = true;
    state.wantsRef = false;
    state.backlog = null;
    updateRef(port);
    const release = holdProcess();
    // A closed port's messages go nowhere, as in Node.
    Object.defineProperty(port, "postMessage", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function postMessage(): void {},
    });
    // From a promise job, so what the caller posts after close() comes first too.
    platformQueueMicrotask(() =>
      behindReceivedMessages(() => {
        state.draining = false;
        Reflect.deleteProperty(port, "postMessage");
        try {
          if (!state.raw) {
            try {
              // The other end emits 'close' and stops holding its process.
              nativePostMessage.call(port, { [PORT_CLOSE_KEY]: true });
            } catch {
              // Transferred meanwhile, or detached.
            }
          }
          nativeClose.call(port);
          emitClose(port);
        } finally {
          release();
        }
      }),
    );
  };

  /**
   * The platform's listeners for `port`: one for every message, which notices
   * the other end closing and otherwise calls the program's listeners in one
   * macrotask, and one for the platform's own close event.
   */
  const watch = (port: NodePort) => {
    const state = stateOf(port);
    if (state.watching) {
      return;
    }
    state.watching = true;
    const onMessage = (event: Event) => {
      receiveCarried(event);
      if (paired && isPortCloseMessage((event as MessageEvent).data)) {
        if (state.backlog !== null && state.backlog.length > 0) {
          // Behind the messages that wait for a listener, as in Node.
          state.peerClosed = true;
        } else {
          closedByPeer(port);
        }
      } else if (state.backlog !== null) {
        state.backlog.push(event as MessageEvent);
      } else if (state.messageListeners.length > 0) {
        deliverMessage(port, state, event as MessageEvent);
      }
    };
    // A port's first messages are plain macrotasks. One that carries more
    // gets the event loop's own listeners, which run the ticks a message's
    // promise jobs queue without a task each; they cost too much to set up
    // for a port that lives for a few messages, as a connection's often does.
    let plainMessages = MESSAGES_BEFORE_ROUNDS;
    const plain = (event: Event) => {
      plainMessages -= 1;
      if (plainMessages === 0) {
        nativeRemoveEventListener.call(port, "message", plain);
        addMacrotaskListener(port, "message", onMessage);
      }
      runEventListener(() => onMessage(event), event);
    };
    nativeAddEventListener.call(port, "message", plain);
    if (paired) {
      // Where the platform has one, its own close event covers a peer that
      // died. The program's listeners get the event this port dispatches.
      nativeAddEventListener.call(port, "close", (event) => {
        if (event !== state.closeEvent) {
          event.stopImmediatePropagation();
          runEventListener(() => closedByPeer(port));
        }
      });
    }
  };

  /**
   * Watches `port` for a 'close' listener. A paired port nobody started is
   * started, so that it hears its peer close as Node's does, and the
   * messages that come meanwhile wait for a listener (`backlog`): a 'close'
   * listener neither delivers them nor holds the process.
   */
  const watchPeerClose = (port: NodePort) => {
    watch(port);
    const state = stateOf(port);
    if (!paired || state.started || state.closed || state.raw) {
      return;
    }
    state.started = true;
    state.backlog ??= [];
    start?.call(port);
  };

  const add = function (this: NodePort, event: string, listener: Listener, once: boolean) {
    if (event === "message") {
      addMessageListener(this, { kind: "node", listener, once, removed: false });
      return this;
    }
    const state = stateOf(this);
    if (event === "close") {
      watchPeerClose(this);
    } else {
      watch(this);
    }
    const native: EventListener = (domEvent) => {
      if (once) {
        remove.call(this, event, listener);
      }
      // A 'messageerror' listener gets what could not be read; any other, the event, as in Node.
      runEventListener(() =>
        listener.call(this, event === "messageerror" ? (domEvent as MessageEvent).data : domEvent),
      );
    };
    const list = state.listeners.get(event) ?? [];
    list.push({ listener, native });
    state.listeners.set(event, list);
    nativeAddEventListener.call(this, event, native);
    return this;
  };

  const remove = function (this: NodePort, event: string, listener: Listener) {
    if (event === "message") {
      const entry = findMessageListener(this, "node", listener);
      if (entry !== undefined) {
        removeMessageListener(this, entry);
      }
      return this;
    }
    const state = stateOf(this);
    const list = state.listeners.get(event);
    const index = list?.findIndex((entry) => entry.listener === listener) ?? -1;
    if (list && index >= 0) {
      nativeRemoveEventListener.call(this, event, list[index].native);
      list.splice(index, 1);
    }
    return this;
  };

  /** The program's Node-style 'message' listeners on `port`. */
  const nodeMessageListeners = (port: object) =>
    stateOf(port).messageListeners.filter((entry) => entry.kind === "node");

  const emitterMethods = {
    on(this: NodePort, event: string, listener: Listener) {
      return add.call(this, event, listener, false);
    },
    addListener(this: NodePort, event: string, listener: Listener) {
      return add.call(this, event, listener, false);
    },
    once(this: NodePort, event: string, listener: Listener) {
      return add.call(this, event, listener, true);
    },
    off: remove,
    removeListener: remove,
    removeAllListeners(this: NodePort, event?: string) {
      const state = stateOf(this);
      for (const [name, list] of state.listeners) {
        if (event === undefined || event === name) {
          for (const entry of list) {
            nativeRemoveEventListener.call(this, name, entry.native);
          }
          state.listeners.delete(name);
        }
      }
      if (event === undefined || event === "message") {
        for (const entry of nodeMessageListeners(this)) {
          removeMessageListener(this, entry);
        }
      }
      return this;
    },
    emit(this: NodePort, event: string, ...args: unknown[]) {
      const listeners =
        event === "message"
          ? nodeMessageListeners(this).map((entry) => entry.listener as Listener)
          : (stateOf(this).listeners.get(event) ?? []).map((entry) => entry.listener);
      for (const listener of listeners) {
        listener.apply(this, args);
      }
      return listeners.length > 0;
    },
    listenerCount(this: NodePort, event: string) {
      return event === "message"
        ? nodeMessageListeners(this).length
        : (stateOf(this).listeners.get(event)?.length ?? 0);
    },
  };
  if (paired) {
    Object.assign(prototype, emitterMethods);
  }

  Object.assign(prototype, {
    ref(this: NodePort) {
      stateOf(this).wantsRef = true;
      updateRef(this);
    },
    unref(this: NodePort) {
      stateOf(this).wantsRef = false;
      updateRef(this);
    },
    /**
     * Closes this end. As in Node the caller goes on first: 'close' is
     * emitted from the event loop, and the process waits for it.
     */
    close(this: NodePort) {
      const state = stateOf(this);
      if (state.closed) {
        return;
      }
      const delivering = state.delivering;
      state.delivering = null;
      if (paired && delivering !== null && inMacrotaskOf(delivering)) {
        drain(this, state);
        return;
      }
      if (paired) {
        // As in Node, this end's 'close' comes before the other end gets what
        // was posted to it (and its close): once the caller's task is done,
        // ahead of the tasks queued meanwhile.
        const release = holdProcess();
        runBeforeQueuedTasks(() => {
          try {
            emitClose(this);
          } finally {
            release();
          }
        });
        if (!state.raw) {
          try {
            // The other end emits 'close' and stops holding its process.
            nativePostMessage.call(this, { [PORT_CLOSE_KEY]: true });
          } catch {
            // Already detached.
          }
        }
      }
      nativeClose.call(this);
      state.closed = true;
      state.wantsRef = false;
      state.backlog = null;
      updateRef(this);
    },
  });
}

const THREAD_START_KEY = "__webnode_thread_start__";

/**
 * What a Worker hands its thread, as the `workerData` the kernel carries: the
 * program's own `workerData`, which standard streams the Worker keeps, and
 * what a thread takes over from its process.
 */
interface ThreadStart {
  [THREAD_START_KEY]: true;
  workerData: unknown;
  stdio: KeptStdio;
  /** The thread's end of its link to this thread's BroadcastChannels (internal/broadcastHub.ts). */
  broadcast: MessagePort;
  /** What the ports in `transferList` held for their next listener. */
  backlogs: CarriedBacklog[];
  environmentData: Map<unknown, unknown>;
}

/** What the Worker that started this thread handed it; null in a process's main thread. */
function threadStart(): ThreadStart | null {
  const data = runtime().threads.workerData;
  return data !== null &&
    typeof data === "object" &&
    (data as Record<string, unknown>)[THREAD_START_KEY] === true
    ? (data as ThreadStart)
    : null;
}

// The platform's own, captured now: a program may replace the global.
const platformCrypto = globalThis.crypto;

let unheardName: string | null = null;

/**
 * The name this worker's platform channels are opened under: one nobody posts
 * to, so the browser delivers them nothing. The messages of the process's
 * channels travel through the hub instead.
 */
function platformChannelName(): string {
  if (unheardName === null) {
    const bytes = platformCrypto.getRandomValues(new Uint8Array(16));
    const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    unheardName = `webnode-unheard:${id}`;
  }
  return unheardName;
}

/**
 * `Native` as Node has BroadcastChannel: its messages reach the channels of
 * its name in this process through `hub`, and it holds the process open from
 * construction until close() or unref().
 */
export function processBroadcastChannel(
  Native: typeof BroadcastChannel,
  hub: BroadcastHub = processBroadcast,
): typeof BroadcastChannel {
  return class BroadcastChannel extends Native {
    readonly #name: string;
    #closed = false;

    constructor(name?: unknown) {
      if (arguments.length === 0) {
        throw missingArgs("name");
      }
      const given = `${name}`;
      super(platformChannelName());
      this.#name = given;
      hub.join(this, given);
      // Until close() or unref(), whether or not anything listens.
      stateOf(this).wantsRef = true;
      updateRef(this);
    }

    override get name(): string {
      return this.#name;
    }

    override postMessage(message?: unknown): void {
      if (arguments.length === 0) {
        throw missingArgs("message");
      }
      if (this.#closed) {
        throw new DOMException("BroadcastChannel is closed.", "InvalidStateError");
      }
      hub.post(this, this.#name, message);
    }

    override close(): void {
      this.#closed = true;
      hub.leave(this);
      super.close();
    }
  };
}

let portsPatched = false;

/**
 * Gives every MessagePort and BroadcastChannel in this worker Node's
 * interface, and makes `BroadcastChannel` the process's own.
 */
export function installMessagePortInterface(): void {
  if (portsPatched) {
    return;
  }
  portsPatched = true;
  addNodePortInterface(PlatformMessagePort.prototype);
  if (typeof BroadcastChannel !== "undefined") {
    addNodePortInterface(BroadcastChannel.prototype, "broadcast");
    globalThis.BroadcastChannel = processBroadcastChannel(BroadcastChannel);
  }
}

/** This worker's `process` object, once there is one. */
let ownProcess: NodeProcess | null = null;

/**
 * Tells this module of the worker's `process`: in a thread, the standard
 * streams its Worker kept become that Worker's; in the main thread, its
 * `send` is how the threads' watch reports reach a supervisor.
 */
export function connectProcess(process: NodeProcess): void {
  ownProcess = process;
  const start = threadStart();
  const port = runtime().threads.parentPort;
  if (start !== null && port !== null) {
    connectThreadStdio(process, start.stdio, port);
  }
  if (start !== null) {
    processBroadcast.linkParent(start.broadcast);
    adoptBacklogs(start.backlogs);
  }
}

interface WorkerOptions {
  argv?: unknown[];
  env?: Record<string, string> | symbol;
  eval?: boolean;
  execArgv?: string[];
  workerData?: unknown;
  transferList?: Transferable[];
  name?: string;
  stdin?: boolean;
  stdout?: boolean;
  stderr?: boolean;
  resourceLimits?: Record<string, number>;
  trackUnmanagedFds?: boolean;
}

export interface Worker extends EventEmitterInstance {
  threadId: number;
  /** A Writable when the Worker was made with `stdin: true`; null otherwise. */
  stdin: Writable | null;
  /** What the thread writes to `process.stdout`, when the Worker was made with `stdout: true`. */
  stdout: Readable;
  stderr: Readable;
  resourceLimits: Record<string, number>;
  postMessage(value: unknown, transferList?: Transferable[]): void;
  terminate(): Promise<number>;
  ref(): void;
  unref(): void;
}

interface WorkerConstructor {
  new (filename: string | URL, options?: WorkerOptions): Worker;
  prototype: Worker;
}

/** Shares the parent's environment with a worker, as `worker_threads.SHARE_ENV`. */
export const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");

/** The message a thread sends its parent about an error nothing caught. */
export const THREAD_ERROR_MESSAGE = "__webnode_thread_error__";
/** The message a thread sends once its entry module has started. */
export const THREAD_ONLINE_MESSAGE = "__webnode_thread_online__";
/**
 * The last message a thread sends as it exits (process/sysClient.ts). Its
 * messages travel on its port, its exit through the kernel: the parent emits
 * 'exit' once this arrives, so nothing posted before the exit is lost.
 */
export const THREAD_EXIT_MESSAGE = "__webnode_thread_exit__";

/** The error classes an uncaught error of a thread is rebuilt as, by name. */
const ERROR_CLASSES: Record<string, ErrorConstructor> = {
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
};

/** An uncaught error of a thread, as it crosses to the parent. */
interface ThrownError {
  /** The nearest class of `ERROR_CLASSES` the error is an instance of. */
  kind: string;
  name: string;
  message: string;
  stack: string | undefined;
  /** Its own enumerable properties that can be cloned. */
  own: Record<string, unknown>;
}

/** A thread's own message to its parent. */
type ThreadMessage =
  | { type: typeof THREAD_ONLINE_MESSAGE | typeof THREAD_EXIT_MESSAGE }
  | { type: typeof THREAD_ERROR_MESSAGE; thrown: ThrownError }
  | { type: typeof THREAD_ERROR_MESSAGE; value: unknown };

function errorKind(error: Error): string {
  for (let proto = Object.getPrototypeOf(error); proto !== null;) {
    const name = (proto as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === "string" && ERROR_CLASSES[name]?.prototype === proto) {
      return name;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return "Error";
}

/**
 * The message that tells a thread's parent of an error nothing in the thread
 * caught. As Node carries it: an error keeps its class among the language's
 * own, its name, message, stack and those of its own properties that can be
 * cloned; any other value goes as it is.
 */
export function threadErrorMessage(error: unknown): ThreadMessage {
  if (!(error instanceof Error)) {
    return { type: THREAD_ERROR_MESSAGE, value: error };
  }
  const own: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    try {
      own[key] = platformStructuredClone(value);
    } catch {
      // Not cloneable (a function, a symbol): Node leaves it behind too.
    }
  }
  return {
    type: THREAD_ERROR_MESSAGE,
    thrown: {
      kind: errorKind(error),
      name: String(error.name),
      message: String(error.message),
      stack: typeof error.stack === "string" ? error.stack : undefined,
      own,
    },
  };
}

/** The error a `threadErrorMessage` carried, rebuilt for the parent's 'error' event. */
function thrownByThread(message: ThreadMessage & { type: typeof THREAD_ERROR_MESSAGE }): unknown {
  if (!("thrown" in message)) {
    return message.value;
  }
  const { kind, name, message: text, stack, own } = message.thrown;
  const error = Object.assign(new (ERROR_CLASSES[kind] ?? Error)(text), own);
  Object.defineProperty(error, "stack", { value: stack, writable: true, configurable: true });
  // A name that was no property of the error's own stays out of its keys.
  if (name !== error.name) {
    Object.defineProperty(error, "name", { value: name, writable: true, configurable: true });
  }
  return error;
}

// The platform's own, taken before a program can replace it: a test's spy on
// `MessagePort.prototype.postMessage` must not swallow a thread's exit.
const platformPostMessage = MessagePort.prototype.postMessage as (
  this: MessagePort,
  message: unknown,
) => void;

/** Posts one of a thread's own messages to its parent on the thread's `port`. */
export function postThreadMessage(port: MessagePort, message: ThreadMessage): void {
  platformPostMessage.call(port, message);
}
/** How long the parent waits for that message from a thread that ended without sending it. */
const THREAD_DRAIN_TIMEOUT_MS = 1000;

/**
 * Watch mode: a thread posts the files it loads on its parentPort
 * (programs/watchReport.ts), and the main thread passes them on to the
 * supervisor over its IPC channel, as Node's lib/internal/worker.js does. The
 * program's own listeners still get the message, as in Node.
 */
function relayWatchReport(message: unknown): void {
  const rt = runtime();
  const process = ownProcess;
  if (
    process === null ||
    !rt.threads.isMainThread ||
    !watchReportsWanted(rt.env) ||
    process.connected !== true ||
    typeof process.send !== "function"
  ) {
    return;
  }
  for (const { kind, files } of watchReportsIn(message)) {
    (process.send as (message: unknown) => boolean)(watchReportMessage(kind, files));
  }
}

const environmentData = new Map<unknown, unknown>();
let environmentInherited = false;

/** This thread's environment data: what its Worker's thread had when it started it, and what was set here. */
function ownEnvironmentData(): Map<unknown, unknown> {
  if (!environmentInherited) {
    environmentInherited = true;
    for (const [key, value] of threadStart()?.environmentData ?? []) {
      environmentData.set(key, value);
    }
  }
  return environmentData;
}

/** The `Worker` class: starts a thread running `filename`. */
export const Worker = function Worker(
  this: Worker,
  filename: string | URL,
  options: WorkerOptions = {},
) {
  EventEmitter.call(this);
  const rt = runtime();
  let script: string;
  if (options.eval) {
    if (typeof filename !== "string") {
      throw invalidArgType("filename", "string", filename);
    }
    script = filename;
  } else if (filename instanceof URL) {
    if (filename.protocol !== "file:" && filename.protocol !== "data:") {
      throw Object.assign(new TypeError("The URL must be of scheme file or data"), {
        code: "ERR_INVALID_URL_SCHEME",
      });
    }
    script = decodeURIComponent(filename.pathname);
  } else if (typeof filename === "string") {
    script = filename.startsWith("file:")
      ? decodeURIComponent(new URL(filename).pathname)
      : path.resolve(filename);
  } else {
    throw invalidArgType("filename", ["string", "URL"], filename);
  }

  const env =
    // A plain copy: `process.env` itself is a proxy, which cannot be sent to another thread.
    options.env === undefined || typeof options.env === "symbol"
      ? { ...rt.env }
      : { ...options.env };
  const kept: KeptStdio = {
    stdin: Boolean(options.stdin),
    stdout: Boolean(options.stdout),
    stderr: Boolean(options.stderr),
  };
  const transferList = options.transferList ?? [];
  const carried = backlogsIn(transferList);
  const broadcast = processBroadcast.linkChild();
  const start: ThreadStart = {
    [THREAD_START_KEY]: true,
    workerData: options.workerData,
    stdio: kept,
    broadcast: broadcast.port,
    backlogs: carried?.backlogs ?? [],
    environmentData: ownEnvironmentData(),
  };
  let handle: ThreadHandle;
  try {
    handle = rt.threads.spawn({
      filename: script,
      eval: options.eval === true,
      workerData: start,
      transferList: [...transferList, ...(carried?.ports ?? []), broadcast.port],
      argv: (options.argv ?? []).map(String),
      execArgv: options.execArgv ?? rt.execArgv,
      env,
      cwd: rt.cwd,
      name: options.name ?? "",
    });
  } catch (error) {
    broadcast.unlink();
    throw error;
  }
  if (carried !== null) {
    dropCarried(carried.backlogs);
  }

  const stdio = createWorkerStdio(kept);
  this.threadId = handle.threadId;
  this.stdin = stdio.stdin;
  this.stdout = stdio.stdout;
  this.stderr = stdio.stderr;
  this.resourceLimits = options.resourceLimits ?? {};

  let reffed = true;
  let exited = false;
  rt.ref();
  const release = () => {
    if (reffed) {
      reffed = false;
      rt.unref();
    }
  };

  // The thread's exit code once the kernel reports it, and whether everything
  // it posted before has arrived.
  let exitCode: number | null = null;
  let drained = false;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveExit: ((code: number) => void) | null = null;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const finishExit = () => {
    if (exited || exitCode === null || !drained) {
      return;
    }
    exited = true;
    if (drainTimer !== null) {
      clearTimeout(drainTimer);
    }
    handle.port.close();
    broadcast.unlink();
    release();
    // Its output streams end with it; their 'end' comes after 'exit', as in Node.
    stdio.end();
    this.emit("exit", exitCode);
    resolveExit?.(exitCode);
  };
  const drain = () => {
    drained = true;
    finishExit();
  };

  listenOnPlatformPort(handle.port, (event: MessageEvent<unknown>) => {
    if (isPortCloseMessage(event.data)) {
      // The thread closed its parentPort: nothing more comes this way.
      drain();
      return;
    }
    const data = event.data as ThreadMessage | { type?: undefined } | null;
    if (data !== null && typeof data === "object" && data.type === THREAD_EXIT_MESSAGE) {
      drain();
      return;
    }
    if (data !== null && typeof data === "object" && data.type === THREAD_ONLINE_MESSAGE) {
      this.emit("online");
      return;
    }
    if (data !== null && typeof data === "object" && data.type === THREAD_ERROR_MESSAGE) {
      this.emit("error", thrownByThread(data));
      return;
    }
    if (stdio.receive(event.data)) {
      return;
    }
    relayWatchReport(event.data);
    this.emit("message", event.data);
  });
  handle.port.onmessageerror = macrotaskHandler(() =>
    this.emit("messageerror", new Error("Message could not be deserialized")),
  );

  let terminating = false;
  handle.onExit((code) => {
    exitCode = code;
    if (terminating) {
      // A terminated thread sends nothing more.
      drain();
      return;
    }
    if (!drained) {
      // One that ended without its last message (killed, or its port was closed raw).
      const nativeSetTimeout =
        (globalThis as { __webnodeNativeSetTimeout?: typeof setTimeout })
          .__webnodeNativeSetTimeout ?? setTimeout;
      drainTimer = nativeSetTimeout(() => runMacrotask(drain), THREAD_DRAIN_TIMEOUT_MS);
    }
    finishExit();
  });

  this.postMessage = (value, transferList) => {
    if (!exited) {
      handle.port.postMessage(value, transferList ?? []);
    }
  };
  this.terminate = () => {
    if (!exited) {
      terminating = true;
      if (exitCode !== null) {
        drain();
      } else {
        handle.terminate();
      }
    }
    return exitPromise;
  };
  this.ref = () => {
    if (!reffed && !exited) {
      reffed = true;
      rt.ref();
    }
  };
  this.unref = release;
} as unknown as WorkerConstructor;
Object.setPrototypeOf(Worker.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Worker, EventEmitter);

function unavailable(name: string): never {
  throw Object.assign(new Error(`worker_threads.${name} is not available in webnode`), {
    code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
  });
}

const workerThreads = {
  Worker,
  SHARE_ENV,
  get isMainThread() {
    return runtime().threads.isMainThread;
  },
  get threadId() {
    return runtime().threads.threadId;
  },
  get workerData() {
    const start = threadStart();
    return start === null ? null : start.workerData;
  },
  get parentPort() {
    return runtime().threads.parentPort;
  },
  get MessageChannel() {
    return globalThis.MessageChannel;
  },
  get MessagePort() {
    return globalThis.MessagePort;
  },
  get BroadcastChannel() {
    return globalThis.BroadcastChannel;
  },
  resourceLimits: {},
  getEnvironmentData: (key: unknown) => ownEnvironmentData().get(key),
  setEnvironmentData(key: unknown, value?: unknown) {
    if (value === undefined) {
      ownEnvironmentData().delete(key);
    } else {
      ownEnvironmentData().set(key, value);
    }
  },
  markAsUntransferable() {},
  isMarkedAsUntransferable: () => false,
  markAsUncloneable() {},
  moveMessagePortToContext: () => unavailable("moveMessagePortToContext"),
  // A browser has no way to take a message from a port without returning to the event loop.
  receiveMessageOnPort: () => unavailable("receiveMessageOnPort"),
  postMessageToThread: () => unavailable("postMessageToThread"),
};

export default workerThreads;
