// A connection between two threads: a `ByteChannel` (process/runtime.ts) carried
// by a MessagePort. Both the kernel's preview gateway and a process's `net`
// sockets speak it. Besides the bytes, "end" and "destroy", each end tells the
// other how many bytes it has taken (a number), so that a writer that paces
// itself (`paceOf`, a `net` socket) is held to its reader, as TCP's window
// holds a sender.
import type { ByteChannel } from "./process/runtime";

type ChannelMessage = Uint8Array | "end" | "destroy" | number;

/**
 * How many bytes a writer that paces itself may be ahead of its reader: the
 * connection's buffer, the size of a pipe's.
 */
export const CHANNEL_WINDOW = 64 * 1024;

/** An end reports what it took once it amounts to this much, so a small exchange costs no message. */
const REPORT_AT = CHANNEL_WINDOW / 2;

/** One end's flow control of a channel made by `createPortChannel`. */
export interface ChannelPace {
  /** How many bytes may be written now before the other end is a window behind. */
  readonly room: number;
  /** Called once when there is room again; a writer sets it when `room` is 0. */
  onRoom: (() => void) | null;
  /** Says that this end took `bytes` of what arrived, which gives the other end that much room. */
  taken(bytes: number): void;
}

const paces = new WeakMap<ByteChannel, () => ChannelPace>();

/**
 * The flow control of this end of `channel`, for an end that paces itself: it
 * writes no more than `room` at a time and says when it has `taken` what
 * arrived. Until an end asks for this, every chunk counts as taken when it is
 * delivered. Undefined for a channel `createPortChannel` did not make.
 */
export function paceOf(channel: ByteChannel): ChannelPace | undefined {
  return paces.get(channel)?.();
}

/**
 * Wraps `port` as one end of a byte channel. `kill` is for when the other
 * end's thread is already gone: this end reads the end of the stream and then
 * the close, as of a peer whose sockets the system closed, and nothing is
 * posted. `onClosed` runs once however the channel closes.
 */
export function createPortChannel(
  port: MessagePort,
  onClosed?: () => void,
): ByteChannel & { kill(): void } {
  let closed = false;
  let endSent = false;
  let endReceived = false;
  /** Bytes written that the other end has not said it took. */
  let outstanding = 0;
  /** Bytes taken here that the other end has not been told about. */
  let unreported = 0;
  /** This end says itself when it takes what arrives (`paceOf`). */
  let paced = false;

  const pace: ChannelPace = {
    get room() {
      return Math.max(0, CHANNEL_WINDOW - outstanding);
    },
    onRoom: null,
    taken(bytes) {
      unreported += bytes;
      if (unreported >= REPORT_AT && !closed) {
        port.postMessage(unreported satisfies ChannelMessage);
        unreported = 0;
      }
    },
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    port.onmessage = null;
    port.close();
    onClosed?.();
    channel.onClose?.();
  };

  const channel: ByteChannel & { kill(): void } = {
    onData: null,
    onEnd: null,
    onClose: null,
    write(chunk) {
      if (closed || endSent) {
        return;
      }
      outstanding += chunk.length;
      // The other end gets a copy of exactly these bytes, made once: the
      // caller may reuse its buffer. The port copies a chunk that is the whole
      // of its (unshared) memory. Part of a larger buffer is copied here and
      // handed over, since posted as it is the port would clone all of the
      // memory behind the view.
      if (
        chunk.buffer instanceof ArrayBuffer &&
        chunk.byteOffset === 0 &&
        chunk.byteLength === chunk.buffer.byteLength
      ) {
        port.postMessage(chunk);
      } else {
        const copy = new Uint8Array(chunk);
        port.postMessage(copy, [copy.buffer]);
      }
    },
    end() {
      if (closed || endSent) {
        return;
      }
      endSent = true;
      port.postMessage("end" satisfies ChannelMessage);
      if (endReceived) {
        close();
      }
    },
    destroy() {
      if (closed) {
        return;
      }
      port.postMessage("destroy" satisfies ChannelMessage);
      close();
    },
    kill() {
      if (closed) {
        return;
      }
      // The system closes the sockets of a process that is gone: its peer
      // reads the end of the stream, not a reset.
      if (!endReceived) {
        endReceived = true;
        channel.onEnd?.();
      }
      close();
    },
  };

  port.onmessage = (event: MessageEvent<ChannelMessage>) => {
    const message = event.data;
    if (message === "destroy") {
      close();
      return;
    }
    if (message === "end") {
      endReceived = true;
      channel.onEnd?.();
      if (endSent) {
        close();
      }
      return;
    }
    if (typeof message === "number") {
      outstanding -= message;
      if (outstanding < CHANNEL_WINDOW) {
        const resume = pace.onRoom;
        pace.onRoom = null;
        resume?.();
      }
      return;
    }
    channel.onData?.(message);
    if (!paced) {
      pace.taken(message.length);
    }
  };
  // In a process a port with a message listener holds the process open
  // (process/node/worker_threads.ts). A connection's port must not: its socket
  // holds the process, and lets it go when the program unrefs the socket. The
  // kernel's ports have no such interface.
  (port as MessagePort & { unref?(): void }).unref?.();

  paces.set(channel, () => {
    paced = true;
    return pace;
  });
  return channel;
}
