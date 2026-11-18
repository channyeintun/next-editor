// How the BroadcastChannels of one process reach each other. Node's channel
// reaches every thread of its process and nothing else. The browser's own
// reaches every worker of the origin, and it joins a new channel to its name
// asynchronously: a message another worker posts right after the new channel's
// thread said (on another port) that it was open can come before the join and
// is lost. So the messages travel here instead: a worker knows its own
// channels at once, and each thread is linked to the thread that started it by
// a MessagePort of its own. A message goes to the other channels of its name in
// this worker and along every link, and each worker passes it on along its
// other links, so it crosses the process's tree of threads once.

/** A channel as the hub sees it: the object its messages are dispatched to. */
export type BroadcastTarget = EventTarget;

/** What one link carries: a message for the channels of `name`. */
interface Relayed {
  name: string;
  data: unknown;
}

// The platform's own, captured now: a program may replace them, and the port
// interface (worker_threads.ts) replaces the MessagePort ones on the prototype.
const PlatformMessageChannel = MessageChannel;
const platformStructuredClone = structuredClone;
const nativeAddEventListener = EventTarget.prototype.addEventListener;
const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
const nativePostMessage = MessagePort.prototype.postMessage as (
  this: MessagePort,
  message: unknown,
) => void;
const nativeStart = MessagePort.prototype.start;
const nativeClose = MessagePort.prototype.close;

/** Starts `port` for `listener` without letting it hold a Node process (the unit tests run under Node). */
function listen(port: MessagePort, listener: (event: MessageEvent) => void): void {
  nativeAddEventListener.call(port, "message", listener as EventListener);
  nativeStart.call(port);
  (port as unknown as { unref?: () => void }).unref?.();
}

export interface BroadcastHub {
  /** `channel` gets the messages posted to `name` from now on. */
  join(channel: BroadcastTarget, name: string): void;
  /** `channel` gets nothing more, not even what is on its way. */
  leave(channel: BroadcastTarget): void;
  /**
   * Sends `data` to every other channel of `name` in the process. It is
   * cloned now, so a value that cannot be cloned throws DataCloneError here.
   */
  post(sender: BroadcastTarget, name: string, data: unknown): void;
  /** A link to a thread this worker starts: the returned port goes to the thread. */
  linkChild(): { port: MessagePort; unlink(): void };
  /** Links this worker, a thread, to the thread that started it with `port`. */
  linkParent(port: MessagePort): void;
}

/** A hub for one worker. Each worker has one (`processBroadcast`); tests make several. */
export function createBroadcastHub(): BroadcastHub {
  const channels = new Map<string, Set<BroadcastTarget>>();
  const names = new WeakMap<BroadcastTarget, string>();
  const links = new Set<MessagePort>();

  // Each delivery is a message on this worker's own channel, so each is a
  // task of its own, in the order they were sent, as a platform message is.
  // The channel each one is for waits here in the same order.
  let loop: MessagePort | null = null;
  const recipients: BroadcastTarget[] = [];

  const isOpen = (channel: BroadcastTarget, name: string) =>
    channels.get(name)?.has(channel) === true;

  const sendLocal = (channel: BroadcastTarget, data: unknown) => {
    if (loop === null) {
      const pair = new PlatformMessageChannel();
      loop = pair.port1;
      listen(pair.port2, (event) => {
        const channel = recipients.shift();
        const name = channel === undefined ? undefined : names.get(channel);
        if (channel !== undefined && name !== undefined && isOpen(channel, name)) {
          // As the platform dispatches a message: the port interface runs
          // its listeners as a macrotask (worker_threads.ts).
          nativeDispatchEvent.call(channel, new MessageEvent("message", { data: event.data }));
        }
      });
    }
    nativePostMessage.call(loop, data);
    recipients.push(channel);
  };

  /** Gives `data` to the channels of `name` here other than `sender`; true when it was cloned. */
  const deliverHere = (name: string, data: unknown, sender: BroadcastTarget | null) => {
    let sent = false;
    for (const channel of channels.get(name) ?? []) {
      if (channel !== sender) {
        sendLocal(channel, data);
        sent = true;
      }
    }
    return sent;
  };

  /** Passes `relayed` along every link but `from`; true when it was cloned. */
  const relay = (relayed: Relayed, from: MessagePort | null) => {
    let sent = false;
    for (const link of links) {
      if (link !== from) {
        nativePostMessage.call(link, relayed);
        sent = true;
      }
    }
    return sent;
  };

  const addLink = (port: MessagePort) => {
    links.add(port);
    listen(port, (event) => {
      const relayed = event.data as Relayed;
      deliverHere(relayed.name, relayed.data, null);
      relay(relayed, port);
    });
  };

  return {
    join(channel, name) {
      names.set(channel, name);
      let open = channels.get(name);
      if (open === undefined) {
        open = new Set();
        channels.set(name, open);
      }
      open.add(channel);
    },
    leave(channel) {
      const name = names.get(channel);
      const open = name === undefined ? undefined : channels.get(name);
      if (name !== undefined && open !== undefined) {
        open.delete(channel);
        if (open.size === 0) {
          channels.delete(name);
        }
      }
    },
    post(sender, name, data) {
      const here = deliverHere(name, data, sender);
      const along = relay({ name, data }, null);
      if (!here && !along) {
        // Nobody to send it to: it is still cloned, as Node serializes it.
        platformStructuredClone(data);
      }
    },
    linkChild() {
      const pair = new PlatformMessageChannel();
      addLink(pair.port1);
      return {
        port: pair.port2,
        unlink() {
          links.delete(pair.port1);
          nativeClose.call(pair.port1);
        },
      };
    },
    linkParent(port) {
      addLink(port);
    },
  };
}

/** This worker's hub. */
export const processBroadcast = createBroadcastHub();
