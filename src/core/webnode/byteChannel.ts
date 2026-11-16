// A connection between two threads: a `ByteChannel` (process/runtime.ts) carried
// by a MessagePort. Both the kernel's preview gateway and a process's `net`
// sockets speak it.
import type { ByteChannel } from "./process/runtime";

type ChannelMessage = Uint8Array | "end" | "destroy";

/**
 * Wraps `port` as one end of a byte channel. `kill` closes this end without
 * telling the other, for when the other end's thread is already gone;
 * `onClosed` runs once however the channel closes.
 */
export function createPortChannel(
  port: MessagePort,
  onClosed?: () => void,
): ByteChannel & { kill(): void } {
  let closed = false;
  let endSent = false;
  let endReceived = false;

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
      // A copy: the caller may reuse its buffer, and a view of shared or pooled
      // memory cannot be transferred.
      port.postMessage(chunk.slice());
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
    channel.onData?.(message);
  };

  return channel;
}
