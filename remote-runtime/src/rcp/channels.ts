import { encodeBinaryFrame, type BinaryFrame } from "./frames";
import { RcpError } from "./errors";
import { RCP_LIMITS } from "./types";

export type BinarySender = (frame: Uint8Array) => void | Promise<void>;
export type CreditSender = (channelId: number, bytes: number) => void | Promise<void>;

interface ChannelState {
  controller?: ReadableStreamDefaultController<Uint8Array>;
  credit: number;
  waiters: Array<() => void>;
  closed: boolean;
  pendingCredit: number;
}

export class ChannelMux {
  private nextChannelId: number;
  private readonly channels = new Map<number, ChannelState>();

  constructor(
    private readonly side: "client" | "agent",
    private readonly sendBinary: BinarySender,
    private readonly sendCredit: CreditSender,
  ) {
    this.nextChannelId = side === "client" ? 1 : 2;
  }

  allocate(): number {
    const id = this.nextChannelId;
    this.nextChannelId += 2;
    this.getState(id);
    return id;
  }

  readable(channelId: number): ReadableStream<Uint8Array> {
    const state = this.getState(channelId);
    if (state.controller) throw new RcpError("EPROTO", `channel ${channelId} already has a reader`);
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        state.controller = controller;
      },
      pull: async (controller) => {
        const desired = Math.max(0, controller.desiredSize ?? 1);
        if (desired > 0 && !state.closed && state.pendingCredit > 0) {
          const bytes = state.pendingCredit;
          state.pendingCredit = 0;
          await this.sendCredit(channelId, bytes);
        }
      },
      cancel: () => {
        state.closed = true;
      },
    });
  }

  writable(channelId: number): WritableStream<Uint8Array> {
    const state = this.getState(channelId);
    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          await this.waitForCredit(state);
          const size = Math.min(
            chunk.byteLength - offset,
            state.credit,
            RCP_LIMITS.maxBinaryFrameBytes,
          );
          state.credit -= size;
          await this.sendBinary(
            encodeBinaryFrame(channelId, chunk.subarray(offset, offset + size)),
          );
          offset += size;
        }
      },
      close: async () => {
        if (!state.closed) await this.sendBinary(encodeBinaryFrame(channelId, undefined, true));
        state.closed = true;
      },
      abort: () => {
        state.closed = true;
        this.wakeAll(state);
      },
    });
  }

  receive(frame: BinaryFrame): void {
    const state = this.getState(frame.channelId);
    if (state.closed) return;
    if (frame.payload.byteLength > 0) {
      if (!state.controller)
        throw new RcpError("EPROTO", `channel ${frame.channelId} has no reader`);
      state.controller.enqueue(frame.payload);
      state.pendingCredit += frame.payload.byteLength;
    }
    if (frame.fin) {
      state.closed = true;
      state.controller?.close();
      this.wakeAll(state);
    }
  }

  grantCredit(channelId: number, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new RcpError("EPROTO", "credit must be a positive integer");
    }
    const state = this.getState(channelId);
    if (!Number.isSafeInteger(state.credit + bytes)) {
      throw new RcpError("ELIMIT", "channel credit overflow");
    }
    state.credit += bytes;
    this.wakeAll(state);
  }

  close(channelId: number, error?: unknown): void {
    const state = this.channels.get(channelId);
    if (!state || state.closed) return;
    state.closed = true;
    if (error) state.controller?.error(error);
    else state.controller?.close();
    this.wakeAll(state);
  }

  private getState(channelId: number): ChannelState {
    let state = this.channels.get(channelId);
    if (!state) {
      state = {
        credit: RCP_LIMITS.initialChannelCredit,
        waiters: [],
        closed: false,
        pendingCredit: 0,
      };
      this.channels.set(channelId, state);
    }
    return state;
  }

  private async waitForCredit(state: ChannelState): Promise<void> {
    while (state.credit <= 0) {
      if (state.closed) throw new RcpError("EGONE", "channel closed");
      await new Promise<void>((resolve) => state.waiters.push(resolve));
    }
  }

  private wakeAll(state: ChannelState): void {
    const waiters = state.waiters.splice(0);
    for (const wake of waiters) wake();
  }
}
