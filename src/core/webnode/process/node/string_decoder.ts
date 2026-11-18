// The `string_decoder` builtin: the npm `string_decoder` package (Node's own
// former implementation, published), imported with a trailing slash so a Node
// test run does not pick Node's builtin. The package assumes a Buffer and
// predates `base64url`; this wrapper gives it what Node's decoder does: any
// ArrayBufferView as input, Node's argument errors, `base64url`, and a fresh
// state after `end()`.
import { StringDecoder as PackageDecoder } from "string_decoder/";
import type { Buffer } from "./buffer";
import { invalidArgType, makeNodeError } from "./internalErrors";

// The Buffer class the package copies partial characters into (its
// `safe-buffer`, which the bundle points at webnode's Buffer); input must be
// of that class for `buf.copy(lastChar)`.
const PackageBuffer = (new PackageDecoder("utf8").lastChar as Buffer).constructor as typeof Buffer;

/** A Buffer over the bytes of `buf`, which Node's decoder takes as any ArrayBufferView. */
function bufferOf(buf: unknown): Buffer {
  if (PackageBuffer.isBuffer(buf)) {
    return buf;
  }
  if (!ArrayBuffer.isView(buf)) {
    throw invalidArgType("buf", ["Buffer", "TypedArray", "DataView"], buf);
  }
  return PackageBuffer.from(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength);
}

/** base64 text in the url alphabet, unpadded, as Node's base64url decoder emits it. */
function toBase64Url(text: string): string {
  return text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The own property a decoder's state sits under: Node's name for the same slot. */
const kNativeDecoder = Symbol("kNativeDecoder");

interface DecoderState {
  readonly inner: PackageDecoder;
  readonly base64url: boolean;
}

type DecoderInput = Uint8Array | ArrayBufferView | string;

/** A `string_decoder.StringDecoder` instance. */
export interface StringDecoder {
  encoding: string;
  /** The text for `buf`, holding back an incomplete trailing character. */
  write(buf: DecoderInput): string;
  /** The text for `buf` (if given) and whatever is held back; the decoder then starts afresh. */
  end(buf?: DecoderInput): string;
  /** Node's `text(buf, offset)`: decodes from `offset`, keeping a partial character. */
  text(buf: Uint8Array | ArrayBufferView, offset: number): string;
  readonly lastChar: Uint8Array;
  readonly lastNeed: number;
  readonly lastTotal: number;
}

/**
 * Node's StringDecoder is a plain function, and packages rely on it: they call
 * it on their own objects (`StringDecoder.call(this, encoding)`, iconv-lite
 * 0.4) and share or inherit its prototype. So it is one here too: called with
 * `new`, or on an object the caller made.
 */
interface StringDecoderConstructor {
  new (encoding?: string): StringDecoder;
  (this: StringDecoder, encoding?: string): void;
  readonly prototype: StringDecoder;
}

/** The state the constructor put on `decoder`, whatever object that is. */
function stateOf(decoder: StringDecoder): DecoderState {
  const state = (decoder as { [kNativeDecoder]?: DecoderState })[kNativeDecoder];
  if (state === undefined) {
    throw makeNodeError(
      "ERR_INVALID_THIS",
      'Value of "this" must be of type StringDecoder',
      TypeError,
    );
  }
  return state;
}

function output(state: DecoderState, text: string): string {
  return state.base64url ? toBase64Url(text) : text;
}

/** `string_decoder.StringDecoder`. */
export const StringDecoder = function StringDecoder(this: StringDecoder, encoding?: string) {
  // The bundle is not a strict script: without this a call with no `this`
  // would write `encoding` onto the global object instead of throwing.
  "use strict";
  const base64url = typeof encoding === "string" && encoding.toLowerCase() === "base64url";
  let inner: PackageDecoder;
  try {
    // base64url output is base64 output in another alphabet, split the same way.
    inner = new PackageDecoder(base64url ? "base64" : encoding);
  } catch {
    throw makeNodeError("ERR_UNKNOWN_ENCODING", `Unknown encoding: ${encoding}`, TypeError);
  }
  // The package allocates it unsafe; Node's starts zeroed.
  inner.lastChar?.fill(0);
  this.encoding = base64url ? "base64url" : inner.encoding;
  const state: DecoderState = { inner, base64url };
  // Not enumerable, so `encoding` stays the only key; replaceable, so a second
  // call on the same object starts it afresh, as in Node.
  Object.defineProperty(this, kNativeDecoder, {
    value: state,
    writable: true,
    configurable: true,
  });
} as unknown as StringDecoderConstructor;

StringDecoder.prototype.write = function write(this: StringDecoder, buf: DecoderInput): string {
  if (typeof buf === "string") {
    return buf;
  }
  const bytes = bufferOf(buf);
  const state = stateOf(this);
  return output(state, state.inner.write(bytes));
};

StringDecoder.prototype.end = function end(this: StringDecoder, buf?: DecoderInput): string {
  const head = buf === undefined ? "" : this.write(buf);
  const state = stateOf(this);
  const tail = output(state, state.inner.end());
  // The package keeps its partial-character state after end(); Node does not.
  state.inner.lastNeed = 0;
  state.inner.lastTotal = 0;
  return head + tail;
};

StringDecoder.prototype.text = function text(
  this: StringDecoder,
  buf: Uint8Array | ArrayBufferView,
  offset: number,
): string {
  const state = stateOf(this);
  return output(state, state.inner.text(bufferOf(buf), offset));
};

Object.defineProperties(StringDecoder.prototype, {
  lastChar: {
    configurable: true,
    enumerable: true,
    get(this: StringDecoder): Uint8Array {
      return stateOf(this).inner.lastChar;
    },
  },
  lastNeed: {
    configurable: true,
    enumerable: true,
    get(this: StringDecoder): number {
      return stateOf(this).inner.lastNeed;
    },
  },
  lastTotal: {
    configurable: true,
    enumerable: true,
    get(this: StringDecoder): number {
      return stateOf(this).inner.lastTotal;
    },
  },
});

/** `require("string_decoder")`. */
export default { StringDecoder };
