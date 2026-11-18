// `stream.duplexPair()` (Node 22.6+): two Duplex streams wired back to back, so
// what one side writes the other side reads. Ported from Node 22's
// lib/internal/streams/duplexpair.js.
import { nextTick } from "../eventLoop";
import type { Duplex as DuplexStream, DuplexConstructor, DuplexOptions } from "./types";

/** Builds `duplexPair` over the given Duplex class. */
export function createDuplexPair(Duplex: DuplexConstructor) {
  class DuplexSide extends Duplex {
    #otherSide: DuplexSide | null = null;
    pendingCallback: (() => void) | null = null;

    initOtherSide(otherSide: DuplexSide): void {
      if (this.#otherSide !== null) {
        throw new Error("duplexPair: the other side is already set");
      }
      this.#otherSide = otherSide;
    }

    override _read(): void {
      const callback = this.pendingCallback;
      if (callback) {
        this.pendingCallback = null;
        callback();
      }
    }

    override _write(chunk: Uint8Array, _encoding: string, callback: () => void): void {
      const other = this.#otherSide;
      if (other === null) {
        throw new Error("duplexPair: the other side is not set");
      }
      if (chunk.length === 0) {
        nextTick(callback);
      } else {
        other.push(chunk);
        other.pendingCallback = callback;
      }
    }

    override _final(callback: () => void): void {
      const other = this.#otherSide;
      if (other === null) {
        throw new Error("duplexPair: the other side is not set");
      }
      other.on("end", callback);
      other.push(null);
    }
  }

  /** Two connected Duplex streams. */
  return function duplexPair(options?: DuplexOptions): [DuplexStream, DuplexStream] {
    const side0 = new DuplexSide(options);
    const side1 = new DuplexSide(options);
    side0.initOtherSide(side1);
    side1.initOtherSide(side0);
    return [side0, side1];
  };
}
