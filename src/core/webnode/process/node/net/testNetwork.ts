// For tests: makes a fake runtime's network deliver as the kernel's does. The
// fake's own channels hand everything over in microtasks; here each
// connection, connect answer, chunk, end and close arrives in a task of its
// own and runs as a macrotask (eventLoop.ts `runMacrotask`), so the ticks a
// listener queues run before its promise jobs, as they do in a process.
import type { ByteChannel, NetBackend } from "../../runtime";
import { runMacrotask } from "../eventLoop";

const deliveries: (() => void)[] = [];

/** Runs `deliver` as a macrotask in a task of its own, after the ones already posted. */
function post(deliver: () => void): void {
  deliveries.push(deliver);
  setImmediate(() => {
    const next = deliveries.shift();
    if (next !== undefined) {
      runMacrotask(next);
    }
  });
}

/** `channel`, with what it delivers posted as macrotasks. */
function inTasks(channel: ByteChannel): ByteChannel {
  let onData: ByteChannel["onData"] = null;
  let onEnd: ByteChannel["onEnd"] = null;
  let onClose: ByteChannel["onClose"] = null;
  return {
    write: (chunk) => channel.write(chunk),
    end: () => channel.end(),
    destroy: () => channel.destroy(),
    localPort: channel.localPort,
    get onData() {
      return onData;
    },
    set onData(listener) {
      onData = listener;
      channel.onData = listener === null ? null : (chunk) => post(() => onData?.(chunk));
    },
    get onEnd() {
      return onEnd;
    },
    set onEnd(listener) {
      onEnd = listener;
      channel.onEnd = listener === null ? null : () => post(() => onEnd?.());
    },
    get onClose() {
      return onClose;
    },
    set onClose(listener) {
      onClose = listener;
      channel.onClose = listener === null ? null : () => post(() => onClose?.());
    },
  };
}

/**
 * Makes `net` (a fake runtime's) deliver in macrotasks from now on. As in a
 * process, a server hears of a connection before its client hears it connected.
 */
export function deliverInMacrotasks(net: NetBackend): void {
  const { listen, connect } = net;
  net.listen = (port, host, onConnection) =>
    listen(port, host, (channel, remote) => post(() => onConnection(inTasks(channel), remote)));
  net.connect = (port, host) =>
    new Promise((resolve, reject) => {
      connect(port, host).then(
        (channel) => post(() => resolve(inTasks(channel))),
        (error: unknown) => post(() => reject(error)),
      );
    });
}
