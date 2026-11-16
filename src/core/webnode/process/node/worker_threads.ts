// Node's `worker_threads`. A worker thread is another worker the kernel starts
// for this process: it shares the process's stdio and pid and talks to its
// parent over a MessagePort. Browser MessagePorts are taught Node's
// `on("message", value => …)` interface, so a port received in a message works
// like one created here.
import { runtime } from "../runtime";
import EventEmitter from "./events";
import type { EventEmitter as EventEmitterInstance } from "./events";
import { invalidArgType } from "./internalErrors";
import path from "./path";

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

interface PortState {
  listeners: Map<string, { listener: Listener; native: EventListener }[]>;
  reffed: boolean;
  /**
   * The port holds the process open: set by `ref()` and by its first message
   * listener, cleared by `unref()` and when its last message listener goes.
   */
  wantsRef: boolean;
  /** This end, or the one it is entangled with, was closed. */
  closed: boolean;
  /** The internal listeners that notice the other end closing are installed. */
  watching: boolean;
  /**
   * `onmessage` was set: the port carries one of the platform's own protocols
   * (a socket, IPC, a thread's control port), whose peer reads every message
   * as its own, so closing it posts nothing.
   */
  raw: boolean;
}

const portStates = new WeakMap<object, PortState>();

function stateOf(port: object): PortState {
  let state = portStates.get(port);
  if (!state) {
    state = {
      listeners: new Map(),
      reffed: false,
      wantsRef: false,
      closed: false,
      watching: false,
      raw: false,
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

let portsPatched = false;

/** Adds Node's event methods to every MessagePort (and BroadcastChannel) in this worker. */
export function installMessagePortInterface(): void {
  if (portsPatched || typeof MessagePort === "undefined") {
    return;
  }
  portsPatched = true;

  const targets: object[] = [MessagePort.prototype];
  if (typeof BroadcastChannel !== "undefined") {
    targets.push(BroadcastChannel.prototype);
  }
  for (const prototype of targets) {
    addNodePortInterface(prototype);
  }
}

/**
 * Gives the ports made from `prototype` (an EventTarget with `postMessage`
 * and `close`) Node's `on`/`once`/`off`/`emit`/`ref`/`unref`/`close`.
 */
export function addNodePortInterface(prototype: object): void {
  const nativeClose = (prototype as { close: () => void }).close;
  const onmessage = Object.getOwnPropertyDescriptor(prototype, "onmessage");
  if (onmessage?.set && onmessage.get && onmessage.configurable) {
    const { get, set } = onmessage;
    Object.defineProperty(prototype, "onmessage", {
      configurable: true,
      enumerable: onmessage.enumerable,
      get,
      set(this: object, handler: unknown) {
        stateOf(this).raw = true;
        set.call(this, handler);
      },
    });
  }

  /** The port is closed (here or at the other end): drop its ref and emit 'close' once. */
  const markClosed = (port: NodePort) => {
    const state = stateOf(port);
    if (state.closed) {
      return;
    }
    state.closed = true;
    updateRef(port);
    for (const entry of Array.from(state.listeners.get("close") ?? [])) {
      entry.listener.call(port);
    }
  };

  /** Listens, ahead of every Node-style listener, for the other end closing. */
  const watch = (port: NodePort) => {
    const state = stateOf(port);
    if (state.watching) {
      return;
    }
    state.watching = true;
    port.addEventListener("message", (event) => {
      if (isPortCloseMessage((event as MessageEvent).data)) {
        event.stopImmediatePropagation();
        markClosed(port);
        nativeClose.call(port);
      }
    });
    // Where the platform has one, its own close event covers a peer that died.
    port.addEventListener("close", () => markClosed(port));
  };

  const add = function (this: NodePort, event: string, listener: Listener, once: boolean) {
    const state = stateOf(this);
    watch(this);
    const native: EventListener = (domEvent) => {
      if (once) {
        remove.call(this, event, listener);
      }
      if (event === "message" || event === "messageerror") {
        listener.call(this, (domEvent as MessageEvent).data);
      } else {
        listener.call(this);
      }
    };
    const list = state.listeners.get(event) ?? [];
    list.push({ listener, native });
    state.listeners.set(event, list);
    // 'close' is emitted by markClosed, once, whatever told us.
    if (event !== "close") {
      this.addEventListener(event, native);
    }
    if (event === "message") {
      // A Node port starts delivering as soon as it has a listener.
      (this as { start?: () => void }).start?.();
      if (list.length === 1) {
        state.wantsRef = true;
      }
      updateRef(this);
    }
    return this;
  };

  const remove = function (this: NodePort, event: string, listener: Listener) {
    const state = stateOf(this);
    const list = state.listeners.get(event);
    const index = list?.findIndex((entry) => entry.listener === listener) ?? -1;
    if (list && index >= 0) {
      this.removeEventListener(event, list[index].native);
      list.splice(index, 1);
      if (event === "message" && list.length === 0) {
        state.wantsRef = false;
      }
      updateRef(this);
    }
    return this;
  };

  Object.assign(prototype, {
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
            this.removeEventListener(name, entry.native);
          }
          state.listeners.delete(name);
          if (name === "message") {
            state.wantsRef = false;
          }
        }
      }
      updateRef(this);
      return this;
    },
    emit(this: NodePort, event: string, ...args: unknown[]) {
      const list = stateOf(this).listeners.get(event) ?? [];
      for (const entry of Array.from(list)) {
        entry.listener.apply(this, args);
      }
      return list.length > 0;
    },
    listenerCount(this: NodePort, event: string) {
      return stateOf(this).listeners.get(event)?.length ?? 0;
    },
    ref(this: NodePort) {
      stateOf(this).wantsRef = true;
      updateRef(this);
    },
    unref(this: NodePort) {
      stateOf(this).wantsRef = false;
      updateRef(this);
    },
    close(this: NodePort) {
      const state = stateOf(this);
      if (!state.closed && !state.raw) {
        try {
          // Tell the other end first; it emits 'close' and stops holding its process.
          this.postMessage({ [PORT_CLOSE_KEY]: true });
        } catch {
          // Already detached.
        }
      }
      nativeClose.call(this);
      state.wantsRef = false;
      markClosed(this);
    },
  });
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
  stdin: null;
  stdout: null;
  stderr: null;
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
  const handle = rt.threads.spawn({
    filename: script,
    eval: options.eval === true,
    workerData: options.workerData,
    transferList: options.transferList ?? [],
    argv: (options.argv ?? []).map(String),
    execArgv: options.execArgv ?? rt.execArgv,
    env,
    cwd: rt.cwd,
    name: options.name ?? "",
  });

  this.threadId = handle.threadId;
  this.stdin = null;
  this.stdout = null;
  this.stderr = null;
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

  handle.port.onmessage = (event: MessageEvent<unknown>) => {
    if (isPortCloseMessage(event.data)) {
      // The thread closed its parentPort; the thread's exit ends this side.
      return;
    }
    const data = event.data as { type?: string; error?: unknown } | null;
    if (data !== null && typeof data === "object" && data.type === THREAD_ONLINE_MESSAGE) {
      this.emit("online");
      return;
    }
    if (data !== null && typeof data === "object" && data.type === THREAD_ERROR_MESSAGE) {
      const serialized = data.error as { name?: string; message?: string; stack?: string } | null;
      const error =
        serialized !== null && typeof serialized === "object"
          ? Object.assign(new Error(serialized.message ?? ""), serialized)
          : serialized;
      this.emit("error", error);
      return;
    }
    this.emit("message", event.data);
  };
  handle.port.onmessageerror = () =>
    this.emit("messageerror", new Error("Message could not be deserialized"));

  let resolveExit: ((code: number) => void) | null = null;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  handle.onExit((code) => {
    exited = true;
    handle.port.close();
    release();
    this.emit("exit", code);
    resolveExit?.(code);
  });

  this.postMessage = (value, transferList) => {
    if (!exited) {
      handle.port.postMessage(value, transferList ?? []);
    }
  };
  this.terminate = () => {
    if (!exited) {
      handle.terminate();
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

const environmentData = new Map<unknown, unknown>();

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
    return runtime().threads.workerData;
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
  getEnvironmentData: (key: unknown) => environmentData.get(key),
  setEnvironmentData(key: unknown, value?: unknown) {
    if (value === undefined) {
      environmentData.delete(key);
    } else {
      environmentData.set(key, value);
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
