// `crypto.createHash`, `crypto.createHmac`, `crypto.hash` and `getHashes`: the
// Hash and Hmac classes (Transform streams, as in Node) over @noble/hashes.
import { hmac as nobleHmac } from "@noble/hashes/hmac.js";
import type { Buffer } from "buffer/";
import { Transform } from "readable-stream";
import { createState, findDigest, supportedHashNames } from "./digests";
import type { Digest, HashState } from "./digests";
import { byteSource, dataBytes, normalizeEncoding, toOutput } from "./encoding";
import {
  codedError,
  invalidArgType,
  invalidArgValue,
  opensslError,
  validateString,
  validateUint32,
} from "./errors";
import { secretKeyBytes } from "./keys";

type StreamCallback = (error?: Error | null) => void;

/** Options for `createHash` / `Hash#copy`: Transform options plus `outputLength`. */
export interface HashOptions {
  outputLength?: number;
  [option: string]: unknown;
}

function hashFinalized(): Error {
  return codedError(Error, "ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
}

function transformOptions(options: unknown): Record<string, unknown> | undefined {
  return options !== null && typeof options === "object"
    ? (options as Record<string, unknown>)
    : undefined;
}

/** The digest for `algorithm`, or Node's "Digest method not supported" error. */
function digestForHash(algorithm: string): Digest {
  const digest = findDigest(algorithm);
  if (!digest) {
    throw new Error("Digest method not supported");
  }
  return digest;
}

/** The output length a Hash produces, validating `options.outputLength`. */
function resolveOutputLength(digest: Digest, options: HashOptions | undefined): number {
  const requested = options?.outputLength;
  if (requested === undefined) {
    return digest.outputLength;
  }
  validateUint32(requested, "options.outputLength");
  if (!digest.xof && requested !== digest.outputLength) {
    throw opensslError(
      "030000B2",
      "digital envelope routines",
      "not XOF or invalid length",
      "EVP_",
    );
  }
  return requested;
}

/** `crypto.Hash`: a running message digest, usable as a Transform stream. */
export class Hash extends Transform {
  #digest: Digest;
  #state: HashState;
  #outputLength: number;
  #finalized = false;

  constructor(algorithm: string | Hash, options?: HashOptions) {
    super(transformOptions(options));
    if (algorithm instanceof Hash) {
      if (algorithm.#finalized) {
        throw hashFinalized();
      }
      this.#digest = algorithm.#digest;
      this.#state = algorithm.#state.clone();
      this.#outputLength =
        options?.outputLength === undefined
          ? algorithm.#outputLength
          : resolveOutputLength(algorithm.#digest, options);
      return;
    }
    validateString(algorithm, "algorithm");
    if (options?.outputLength !== undefined) {
      validateUint32(options.outputLength, "options.outputLength");
    }
    this.#digest = digestForHash(algorithm);
    this.#outputLength = resolveOutputLength(this.#digest, options);
    this.#state = createState(this.#digest);
  }

  /** A new Hash with a copy of this one's state. */
  copy(options?: HashOptions): Hash {
    return new Hash(this, options);
  }

  /** Adds `data` (a string in `inputEncoding`, utf8 by default, or an ArrayBufferView). */
  update(data: unknown, inputEncoding?: string): this {
    if (this.#finalized) {
      throw hashFinalized();
    }
    this.#state.update(dataBytes(data, inputEncoding));
    return this;
  }

  /** The digest as a Buffer, or a string in `outputEncoding`. Finalizes the hash. */
  digest(outputEncoding?: string): Buffer | string {
    if (this.#finalized) {
      throw hashFinalized();
    }
    this.#finalized = true;
    return toOutput(finishDigest(this.#digest, this.#state, this.#outputLength), outputEncoding);
  }

  override _transform(chunk: unknown, encoding: string, callback: StreamCallback): void {
    try {
      this.update(chunk, encoding);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: StreamCallback): void {
    try {
      this.push(this.digest());
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

function finishDigest(digest: Digest, state: HashState, outputLength: number): Uint8Array {
  if (digest.xof) {
    if (outputLength === 0) {
      return new Uint8Array(0);
    }
    return state.xof!(outputLength);
  }
  return state.digest();
}

/** Options for `createHmac`: Transform options plus the key's string `encoding`. */
export interface HmacOptions {
  encoding?: string;
  [option: string]: unknown;
}

/** The digest for an HMAC/KDF: anything but an XOF, else `ERR_CRYPTO_INVALID_DIGEST`. */
export function digestForMac(algorithm: string): Digest {
  const digest = findDigest(algorithm);
  if (!digest || digest.xof) {
    throw codedError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", `Invalid digest: ${algorithm}`);
  }
  return digest;
}

/** `crypto.Hmac`: a keyed-hash message authentication code, usable as a Transform stream. */
export class Hmac extends Transform {
  #state: HashState;
  #finalized = false;

  constructor(hmac: string, key: unknown, options?: HmacOptions) {
    super(transformOptions(options));
    validateString(hmac, "hmac");
    const keyBytes = secretKeyBytes(key, "key", options?.encoding);
    const digest = digestForMac(hmac);
    this.#state = nobleHmac.create(digest.hash, keyBytes) as unknown as HashState;
  }

  /** Adds `data` (a string in `inputEncoding`, utf8 by default, or an ArrayBufferView). */
  update(data: unknown, inputEncoding?: string): this {
    if (this.#finalized) {
      throw hashFinalized();
    }
    this.#state.update(dataBytes(data, inputEncoding));
    return this;
  }

  /**
   * The HMAC as a Buffer, or a string in `outputEncoding`. A second call
   * returns an empty result, as in Node.
   */
  digest(outputEncoding?: string): Buffer | string {
    if (this.#finalized) {
      return toOutput(new Uint8Array(0), outputEncoding);
    }
    this.#finalized = true;
    return toOutput(this.#state.digest(), outputEncoding);
  }

  override _transform(chunk: unknown, encoding: string, callback: StreamCallback): void {
    try {
      this.update(chunk, encoding);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: StreamCallback): void {
    this.push(this.digest());
    callback();
  }
}

/** `crypto.createHash(algorithm[, options])`. */
export function createHash(algorithm: string, options?: HashOptions): Hash {
  return new Hash(algorithm, options);
}

/** `crypto.createHmac(algorithm, key[, options])`. */
export function createHmac(algorithm: string, key: unknown, options?: HmacOptions): Hmac {
  return new Hmac(algorithm, key, options);
}

/** `crypto.hash(algorithm, data[, outputEncoding])`: a one-shot digest, hex by default. */
export function hash(
  algorithm: unknown,
  data: unknown,
  outputEncoding: unknown = "hex",
): Buffer | string {
  validateString(algorithm, "algorithm");
  if (typeof data !== "string" && !ArrayBuffer.isView(data)) {
    throw invalidArgType(
      "input",
      "of type string or an instance of Buffer, TypedArray, or DataView",
      data,
    );
  }
  let encoding: string | undefined;
  if (outputEncoding !== "buffer") {
    validateString(outputEncoding, "outputEncoding");
    if (normalizeEncoding(outputEncoding) === undefined) {
      throw invalidArgValue("outputEncoding", outputEncoding);
    }
    encoding = outputEncoding;
  }
  const digest = findDigest(algorithm);
  if (!digest) {
    throw new Error(`Digest method ${algorithm} is not supported`);
  }
  const state = createState(digest);
  state.update(byteSource(data, "input"));
  return toOutput(finishDigest(digest, state, digest.outputLength), encoding);
}

/** `crypto.getHashes()`: the digest names this runtime supports. */
export function getHashes(): string[] {
  return supportedHashNames();
}
