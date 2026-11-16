// Test support for the preview: two linked in-memory ByteChannels with
// asynchronous delivery, standing in for a kernel connection. Only tests
// import this file.
import type { ByteChannel } from "../process/runtime";

class LinkedChannel implements ByteChannel {
  onData: ((chunk: Uint8Array) => void) | null = null;
  onEnd: (() => void) | null = null;
  onClose: (() => void) | null = null;
  peer: LinkedChannel | null = null;
  /** True once this side sent end of stream. */
  ended = false;
  /** True once the other side's end of stream arrived. */
  peerEnded = false;
  closed = false;
  /** Everything this side wrote, in order. */
  readonly written: Uint8Array[] = [];

  write(chunk: Uint8Array): void {
    if (this.closed || this.ended) {
      return;
    }
    const copy = chunk.slice();
    this.written.push(copy);
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer && !peer.closed) {
        peer.onData?.(copy);
      }
    });
  }

  end(): void {
    if (this.closed || this.ended) {
      return;
    }
    this.ended = true;
    const peer = this.peer;
    queueMicrotask(() => {
      if (!peer || peer.closed) {
        return;
      }
      peer.peerEnded = true;
      peer.onEnd?.();
      if (peer.ended) {
        peer.#closeLocal();
        this.#closeLocal();
      }
    });
  }

  destroy(): void {
    if (this.closed) {
      return;
    }
    const peer = this.peer;
    this.#closeLocal();
    queueMicrotask(() => {
      if (peer) {
        peer.#closeLocal();
      }
    });
  }

  #closeLocal(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    queueMicrotask(() => this.onClose?.());
  }
}

/** Two connected channel ends: what one writes, the other receives (asynchronously, in order). */
export function createChannelPair(): [LinkedChannel, LinkedChannel] {
  const a = new LinkedChannel();
  const b = new LinkedChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

export type { LinkedChannel };
