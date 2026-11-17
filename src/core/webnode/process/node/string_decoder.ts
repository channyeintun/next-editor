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

/** `string_decoder.StringDecoder`. */
export class StringDecoder {
  readonly encoding: string;
  readonly #inner: PackageDecoder;
  readonly #base64url: boolean;

  constructor(encoding?: string) {
    this.#base64url = typeof encoding === "string" && encoding.toLowerCase() === "base64url";
    try {
      // base64url output is base64 output in another alphabet, split the same way.
      this.#inner = new PackageDecoder(this.#base64url ? "base64" : encoding);
    } catch {
      throw makeNodeError("ERR_UNKNOWN_ENCODING", `Unknown encoding: ${encoding}`, TypeError);
    }
    this.encoding = this.#base64url ? "base64url" : this.#inner.encoding;
    // The package allocates it unsafe; Node's starts zeroed.
    this.#inner.lastChar?.fill(0);
  }

  #out(text: string): string {
    return this.#base64url ? toBase64Url(text) : text;
  }

  /** The text for `buf`, holding back an incomplete trailing character. */
  write(buf: Uint8Array | ArrayBufferView | string): string {
    if (typeof buf === "string") {
      return buf;
    }
    return this.#out(this.#inner.write(bufferOf(buf)));
  }

  /** The text for `buf` (if given) and whatever is held back; the decoder then starts afresh. */
  end(buf?: Uint8Array | ArrayBufferView | string): string {
    const head = buf === undefined ? "" : this.write(buf);
    const tail = this.#out(this.#inner.end());
    // The package keeps its partial-character state after end(); Node does not.
    this.#inner.lastNeed = 0;
    this.#inner.lastTotal = 0;
    return head + tail;
  }

  /** Node's `text(buf, offset)`: decodes from `offset`, keeping a partial character. */
  text(buf: Uint8Array | ArrayBufferView, offset: number): string {
    return this.#out(this.#inner.text(bufferOf(buf), offset));
  }

  get lastChar(): Uint8Array {
    return this.#inner.lastChar;
  }

  get lastNeed(): number {
    return this.#inner.lastNeed;
  }

  get lastTotal(): number {
    return this.#inner.lastTotal;
  }
}

/** `require("string_decoder")`. */
export default { StringDecoder };
