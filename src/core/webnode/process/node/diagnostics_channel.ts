// The `diagnostics_channel` builtin, ported from Node 22's
// lib/diagnostics_channel.js: named channels that swap between an inactive and
// an active prototype as subscribers and stores come and go, held weakly while
// nobody listens, plus `TracingChannel`. A store is anything with
// `run(store, fn)` (`AsyncLocalStorage`).
import { invalidArgType, validateFunction } from "./internalErrors";

type Subscriber = (message: unknown, name: string | symbol) => void;
type Transform = (message: unknown) => unknown;

/** What `bindStore` accepts: an `AsyncLocalStorage` or anything with its `run`. */
export interface RunStore {
  run<R>(store: unknown, fn: () => R): R;
}

/** Reports a subscriber's error the way Node does: as an uncaught exception, later. */
function reportLater(error: unknown): void {
  const nextTick = (globalThis as { process?: { nextTick?: (fn: () => void) => void } }).process
    ?.nextTick;
  const thrower = () => {
    throw error;
  };
  if (typeof nextTick === "function") {
    nextTick(thrower);
  } else {
    queueMicrotask(thrower);
  }
}

/** Channels by name: weak while unused, strong while they have subscribers or stores. */
class WeakRefMap {
  private readonly refs = new Map<string | symbol, WeakRef<Channel>>();
  private readonly strong = new Map<string | symbol, { channel: Channel; count: number }>();
  private readonly registry = new FinalizationRegistry<string | symbol>((name) => {
    const ref = this.refs.get(name);
    if (ref !== undefined && ref.deref() === undefined) {
      this.refs.delete(name);
    }
  });

  get(name: string | symbol): Channel | undefined {
    return this.refs.get(name)?.deref();
  }

  set(name: string | symbol, channel: Channel): void {
    this.refs.set(name, new WeakRef(channel));
    this.registry.register(channel, name);
  }

  incRef(name: string | symbol): void {
    const held = this.strong.get(name);
    if (held !== undefined) {
      held.count++;
      return;
    }
    const channel = this.get(name);
    if (channel !== undefined) {
      this.strong.set(name, { channel, count: 1 });
    }
  }

  decRef(name: string | symbol): void {
    const held = this.strong.get(name);
    if (held !== undefined && --held.count === 0) {
      this.strong.delete(name);
    }
  }
}

const channels = new WeakRefMap();

interface ChannelState {
  _subscribers: Subscriber[] | undefined;
  _stores: Map<RunStore, Transform | undefined> | undefined;
  readonly name: string | symbol;
}

function defaultTransform(data: unknown): unknown {
  return data;
}

function wrapStoreRun(
  store: RunStore,
  data: unknown,
  next: () => unknown,
  transform: Transform = defaultTransform,
): () => unknown {
  return () => {
    let newStore: unknown;
    try {
      newStore = transform(data);
    } catch (error) {
      reportLater(error);
      return next();
    }
    return store.run(newStore, next);
  };
}

function markActive(channel: Channel): void {
  Object.setPrototypeOf(channel, ActiveChannel.prototype);
  const state = channel as unknown as ChannelState;
  state._subscribers = [];
  state._stores = new Map();
}

function maybeMarkInactive(channel: ChannelState): void {
  if (!channel._subscribers?.length && !channel._stores?.size) {
    Object.setPrototypeOf(channel, Channel.prototype);
    channel._subscribers = undefined;
    channel._stores = undefined;
  }
}

/** A channel with subscribers or bound stores (the prototype an active `Channel` takes). */
class ActiveChannel implements ChannelState {
  _subscribers: Subscriber[] | undefined;
  _stores: Map<RunStore, Transform | undefined> | undefined;
  declare readonly name: string | symbol;

  subscribe(subscription: Subscriber): void {
    validateFunction(subscription, "subscription");
    this._subscribers = [...(this._subscribers ?? []), subscription];
    channels.incRef(this.name);
  }

  unsubscribe(subscription: Subscriber): boolean {
    const subscribers = this._subscribers ?? [];
    const index = subscribers.indexOf(subscription);
    if (index === -1) {
      return false;
    }
    this._subscribers = [...subscribers.slice(0, index), ...subscribers.slice(index + 1)];
    channels.decRef(this.name);
    maybeMarkInactive(this);
    return true;
  }

  bindStore(store: RunStore, transform?: Transform): void {
    const stores = this._stores as Map<RunStore, Transform | undefined>;
    if (!stores.has(store)) {
      channels.incRef(this.name);
    }
    stores.set(store, transform);
  }

  unbindStore(store: RunStore): boolean {
    const stores = this._stores as Map<RunStore, Transform | undefined>;
    if (!stores.has(store)) {
      return false;
    }
    stores.delete(store);
    channels.decRef(this.name);
    maybeMarkInactive(this);
    return true;
  }

  get hasSubscribers(): boolean {
    return true;
  }

  isBoundToStore(store: RunStore): boolean {
    return this._stores?.has(store) ?? false;
  }

  publish(data?: unknown): void {
    const subscribers = this._subscribers;
    for (let i = 0; i < (subscribers?.length ?? 0); i++) {
      try {
        const onMessage = (subscribers as Subscriber[])[i];
        onMessage(data, this.name);
      } catch (error) {
        reportLater(error);
      }
    }
  }

  runStores<R>(
    data: unknown,
    fn: (...args: unknown[]) => R,
    thisArg?: unknown,
    ...args: unknown[]
  ): R {
    let run = (): unknown => {
      this.publish(data);
      return Reflect.apply(fn, thisArg, args);
    };
    for (const [store, transform] of this._stores ?? []) {
      run = wrapStoreRun(store, data, run, transform);
    }
    return run() as R;
  }
}

/** `diagnostics_channel.Channel`: a named channel, inactive until someone subscribes. */
export class Channel implements ChannelState {
  _subscribers: Subscriber[] | undefined;
  _stores: Map<RunStore, Transform | undefined> | undefined;
  readonly name: string | symbol;

  constructor(name: string | symbol) {
    this._subscribers = undefined;
    this._stores = undefined;
    this.name = name;
    channels.set(name, this);
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    if (instance === null || (typeof instance !== "object" && typeof instance !== "function")) {
      return false;
    }
    const prototype: unknown = Object.getPrototypeOf(instance);
    return prototype === Channel.prototype || prototype === ActiveChannel.prototype;
  }

  subscribe(subscription: Subscriber): void {
    markActive(this);
    this.subscribe(subscription);
  }

  unsubscribe(_subscription?: Subscriber): boolean {
    return false;
  }

  bindStore(store: RunStore, transform?: Transform): void {
    markActive(this);
    this.bindStore(store, transform);
  }

  unbindStore(_store?: RunStore): boolean {
    return false;
  }

  isBoundToStore(_store?: RunStore): boolean {
    return false;
  }

  get hasSubscribers(): boolean {
    return false;
  }

  publish(_data?: unknown): void {}

  runStores<R>(
    _data: unknown,
    fn: (...args: unknown[]) => R,
    thisArg?: unknown,
    ...args: unknown[]
  ): R {
    return Reflect.apply(fn, thisArg, args);
  }
}

/** `diagnostics_channel.channel(name)`: the one channel for `name`. */
export function channel(name: string | symbol): Channel {
  const existing = channels.get(name);
  if (existing !== undefined) {
    return existing;
  }
  if (typeof name !== "string" && typeof name !== "symbol") {
    throw invalidArgType("channel", ["string", "symbol"], name);
  }
  return new Channel(name);
}

/** `diagnostics_channel.subscribe(name, onMessage)`. */
export function subscribe(name: string | symbol, subscription: Subscriber): void {
  channel(name).subscribe(subscription);
}

/** `diagnostics_channel.unsubscribe(name, onMessage)`. */
export function unsubscribe(name: string | symbol, subscription: Subscriber): boolean {
  return channel(name).unsubscribe(subscription);
}

/** `diagnostics_channel.hasSubscribers(name)`. */
export function hasSubscribers(name: string | symbol): boolean {
  const existing = channels.get(name);
  return existing === undefined ? false : existing.hasSubscribers;
}

const traceEvents = ["start", "end", "asyncStart", "asyncEnd", "error"] as const;
type TraceEvent = (typeof traceEvents)[number];

/** Handlers for `TracingChannel.subscribe`. */
export type TracingHandlers = Partial<Record<TraceEvent, Subscriber>>;

type TraceContext = Record<string, unknown>;

/** `diagnostics_channel.TracingChannel`: five channels around a traced operation. */
export class TracingChannel {
  declare readonly start: Channel;
  declare readonly end: Channel;
  declare readonly asyncStart: Channel;
  declare readonly asyncEnd: Channel;
  declare readonly error: Channel;

  constructor(nameOrChannels: string | Partial<Record<TraceEvent, Channel>>) {
    if (typeof nameOrChannels === "string") {
      for (const eventType of traceEvents) {
        Object.defineProperty(this, eventType, {
          value: channel(`tracing:${nameOrChannels}:${eventType}`),
        });
      }
    } else if (typeof nameOrChannels === "object" && nameOrChannels !== null) {
      for (const eventType of traceEvents) {
        const ch = nameOrChannels[eventType];
        if (!(ch instanceof Channel)) {
          throw invalidArgType(`nameOrChannels.${eventType}`, ["Channel"], ch);
        }
        Object.defineProperty(this, eventType, { value: ch });
      }
    } else {
      throw invalidArgType(
        "nameOrChannels",
        ["string", "object", "TracingChannel"],
        nameOrChannels,
      );
    }
  }

  get hasSubscribers(): boolean {
    return (
      this.start.hasSubscribers ||
      this.end.hasSubscribers ||
      this.asyncStart.hasSubscribers ||
      this.asyncEnd.hasSubscribers ||
      this.error.hasSubscribers
    );
  }

  subscribe(handlers: TracingHandlers): void {
    for (const name of traceEvents) {
      const handler = handlers[name];
      if (handler) {
        this[name].subscribe(handler);
      }
    }
  }

  unsubscribe(handlers: TracingHandlers): boolean {
    let done = true;
    for (const name of traceEvents) {
      const handler = handlers[name];
      if (handler && !this[name].unsubscribe(handler)) {
        done = false;
      }
    }
    return done;
  }

  traceSync<R>(
    fn: (...args: unknown[]) => R,
    context: TraceContext = {},
    thisArg?: unknown,
    ...args: unknown[]
  ): R {
    if (!this.hasSubscribers) {
      return Reflect.apply(fn, thisArg, args);
    }
    const { start, end, error } = this;
    return start.runStores(context, () => {
      try {
        const result = Reflect.apply(fn, thisArg, args);
        context.result = result;
        return result;
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }

  tracePromise<R>(
    fn: (...args: unknown[]) => PromiseLike<R> | R,
    context: TraceContext = {},
    thisArg?: unknown,
    ...args: unknown[]
  ): Promise<R> {
    if (!this.hasSubscribers) {
      return Reflect.apply(fn, thisArg, args) as Promise<R>;
    }
    const { start, end, asyncStart, asyncEnd, error } = this;
    const reject = (err: unknown): Promise<never> => {
      context.error = err;
      error.publish(context);
      asyncStart.publish(context);
      asyncEnd.publish(context);
      return Promise.reject(err);
    };
    const resolve = (result: R): R => {
      context.result = result;
      asyncStart.publish(context);
      asyncEnd.publish(context);
      return result;
    };
    return start.runStores(context, () => {
      try {
        let promise = Reflect.apply(fn, thisArg, args) as Promise<R>;
        if (!(promise instanceof Promise)) {
          promise = Promise.resolve(promise);
        }
        return promise.then(resolve, reject);
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }

  traceCallback<R>(
    fn: (...args: unknown[]) => R,
    position = -1,
    context: TraceContext = {},
    thisArg?: unknown,
    ...args: unknown[]
  ): R {
    if (!this.hasSubscribers) {
      return Reflect.apply(fn, thisArg, args);
    }
    const { start, end, asyncStart, asyncEnd, error } = this;
    const callback = args.at(position);
    validateFunction(callback, "callback");
    function wrappedCallback(this: unknown, ...callbackArgs: unknown[]): void {
      const [err, res] = callbackArgs;
      if (err) {
        context.error = err;
        error.publish(context);
      } else {
        context.result = res;
      }
      asyncStart.runStores(context, () => {
        try {
          return Reflect.apply(callback as (...a: unknown[]) => unknown, this, callbackArgs);
        } finally {
          asyncEnd.publish(context);
        }
      });
    }
    args.splice(position, 1, wrappedCallback);
    return start.runStores(context, () => {
      try {
        return Reflect.apply(fn, thisArg, args);
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }
}

/** `diagnostics_channel.tracingChannel(nameOrChannels)`. */
export function tracingChannel(
  nameOrChannels: string | Partial<Record<TraceEvent, Channel>>,
): TracingChannel {
  return new TracingChannel(nameOrChannels);
}

const diagnosticsChannel = {
  channel,
  hasSubscribers,
  subscribe,
  tracingChannel,
  unsubscribe,
  Channel,
};

export default diagnosticsChannel;
