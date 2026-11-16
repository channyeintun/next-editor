// `crypto.createCipheriv` / `createDecipheriv` for AES-128/192/256 in CBC
// (PKCS#7 padding), CTR and GCM, plus `getCiphers` and `getCipherInfo`. The
// Cipheriv/Decipheriv classes are Transform streams, as in Node, and raise
// Node's (and OpenSSL's) errors.
import type { Buffer } from "buffer/";
import { Transform } from "readable-stream";
import { AesKey, Ghash } from "./aes";
import {
  OutputDecoder,
  byteSource,
  concatBytes,
  dataBytes,
  normalizeEncoding,
  toBuffer,
} from "./encoding";
import {
  codedError,
  invalidArgType,
  invalidArgValue,
  opensslError,
  validateInt32,
  validateObject,
  validateString,
} from "./errors";
import { secretKeyBytes } from "./keys";

type Mode = "cbc" | "ctr" | "gcm";

interface CipherSpec {
  /** The name `getCipherInfo` reports (OpenSSL's canonical short name). */
  readonly name: string;
  readonly nid: number;
  readonly mode: Mode;
  readonly keyLength: number;
  readonly ivLength: number;
  readonly blockSize: number;
}

function spec(bits: 128 | 192 | 256, mode: Mode, nid: number): CipherSpec {
  return {
    name: mode === "gcm" ? `id-aes${bits}-gcm` : `aes-${bits}-${mode}`,
    nid,
    mode,
    keyLength: bits / 8,
    ivLength: mode === "gcm" ? 12 : 16,
    blockSize: mode === "cbc" ? 16 : 1,
  };
}

const SPECS: readonly CipherSpec[] = [
  spec(128, "cbc", 419),
  spec(192, "cbc", 423),
  spec(256, "cbc", 427),
  spec(128, "ctr", 904),
  spec(192, "ctr", 905),
  spec(256, "ctr", 906),
  spec(128, "gcm", 895),
  spec(192, "gcm", 898),
  spec(256, "gcm", 901),
];

/** Every name OpenSSL accepts for the supported ciphers (lowercase), to its spec. */
const CIPHER_NAMES = new Map<string, CipherSpec>();
for (const cipher of SPECS) {
  const bits = cipher.keyLength * 8;
  CIPHER_NAMES.set(`aes-${bits}-${cipher.mode}`, cipher);
  if (cipher.mode === "gcm") {
    CIPHER_NAMES.set(`id-aes${bits}-gcm`, cipher);
  }
  if (cipher.mode === "cbc") {
    CIPHER_NAMES.set(`aes${bits}`, cipher);
  }
}

function findCipher(name: string): CipherSpec | undefined {
  return CIPHER_NAMES.get(name.toLowerCase());
}

/** `crypto.getCiphers()`: the cipher names this runtime supports. */
export function getCiphers(): string[] {
  return [...CIPHER_NAMES.keys()].sort();
}

/** `crypto.getCipherInfo(nameOrNid[, options])`. */
export function getCipherInfo(
  nameOrNid: unknown,
  options?: unknown,
):
  | {
      mode: Mode;
      name: string;
      nid: number;
      keyLength: number;
      blockSize: number;
      ivLength: number;
    }
  | undefined {
  if (typeof nameOrNid !== "string" && typeof nameOrNid !== "number") {
    throw invalidArgType("nameOrNid", "of type string or number", nameOrNid);
  }
  if (typeof nameOrNid === "number") {
    validateInt32(nameOrNid, "nameOrNid");
  }
  let keyLength: unknown;
  let ivLength: unknown;
  if (options !== undefined) {
    validateObject(options, "options");
    ({ keyLength, ivLength } = options as { keyLength?: unknown; ivLength?: unknown });
    if (keyLength !== undefined) {
      validateInt32(keyLength, "options.keyLength");
    }
    if (ivLength !== undefined) {
      validateInt32(ivLength, "options.ivLength");
    }
  }
  const cipher =
    typeof nameOrNid === "number"
      ? SPECS.find((candidate) => candidate.nid === nameOrNid)
      : findCipher(nameOrNid);
  if (!cipher) {
    return undefined;
  }
  if (keyLength !== undefined && keyLength !== cipher.keyLength) {
    return undefined;
  }
  let iv = cipher.ivLength;
  if (ivLength !== undefined) {
    if (cipher.mode === "gcm" ? (ivLength as number) < 1 : ivLength !== cipher.ivLength) {
      return undefined;
    }
    iv = ivLength as number;
  }
  return {
    mode: cipher.mode,
    name: cipher.name,
    nid: cipher.nid,
    keyLength: cipher.keyLength,
    blockSize: cipher.blockSize,
    ivLength: iv,
  };
}

// --- mode engines ---------------------------------------------------------

interface Engine {
  update(input: Uint8Array): Uint8Array;
  final(): Uint8Array;
}

function wrongFinalBlockLength(): Error {
  return opensslError("1C80006B", "Provider routines", "wrong final block length");
}

class CbcEngine implements Engine {
  autoPadding = true;
  #aes: AesKey;
  #decrypt: boolean;
  #previous: Uint8Array;
  #pending = new Uint8Array(0);

  constructor(aes: AesKey, iv: Uint8Array, decrypt: boolean) {
    this.#aes = aes;
    this.#decrypt = decrypt;
    this.#previous = iv.slice();
  }

  update(input: Uint8Array): Uint8Array {
    const all = this.#pending.length ? concatBytes([this.#pending, input]) : input;
    let usable = all.length - (all.length % 16);
    if (this.#decrypt && this.autoPadding && usable === all.length && usable > 0) {
      usable -= 16;
    }
    this.#pending = all.slice(usable);
    return this.#process(all.subarray(0, usable));
  }

  final(): Uint8Array {
    const pending = this.#pending;
    this.#pending = new Uint8Array(0);
    if (!this.autoPadding) {
      if (pending.length !== 0) {
        throw wrongFinalBlockLength();
      }
      return new Uint8Array(0);
    }
    if (!this.#decrypt) {
      const pad = 16 - pending.length;
      const block = new Uint8Array(16);
      block.set(pending);
      block.fill(pad, pending.length);
      return this.#process(block);
    }
    if (pending.length !== 16) {
      throw wrongFinalBlockLength();
    }
    const plain = this.#process(pending);
    const pad = plain[15];
    let bad = pad === 0 || pad > 16 ? 1 : 0;
    for (let i = 16 - Math.min(Math.max(pad, 1), 16); i < 16; i++) {
      bad |= plain[i] ^ pad;
    }
    if (bad !== 0) {
      throw opensslError("1C800064", "Provider routines", "bad decrypt");
    }
    return plain.slice(0, 16 - pad);
  }

  #process(blocks: Uint8Array): Uint8Array {
    const out = new Uint8Array(blocks.length);
    const previous = this.#previous;
    if (this.#decrypt) {
      for (let offset = 0; offset < blocks.length; offset += 16) {
        this.#aes.decryptBlock(blocks, offset, out, offset);
        for (let i = 0; i < 16; i++) {
          out[offset + i] ^= previous[i];
        }
        previous.set(blocks.subarray(offset, offset + 16));
      }
    } else {
      const block = new Uint8Array(16);
      for (let offset = 0; offset < blocks.length; offset += 16) {
        for (let i = 0; i < 16; i++) {
          block[i] = blocks[offset + i] ^ previous[i];
        }
        this.#aes.encryptBlock(block, 0, out, offset);
        previous.set(out.subarray(offset, offset + 16));
      }
    }
    return out;
  }
}

/** A keystream from AES over a big-endian counter block (whole 128 bits, or the low 32 for GCM). */
class Keystream {
  #aes: AesKey;
  #counter: Uint8Array;
  #inc32: boolean;
  #block = new Uint8Array(16);
  #used = 16;

  constructor(aes: AesKey, counter: Uint8Array, inc32: boolean) {
    this.#aes = aes;
    this.#counter = counter.slice();
    this.#inc32 = inc32;
  }

  xor(input: Uint8Array): Uint8Array {
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
      if (this.#used === 16) {
        this.#aes.encryptBlock(this.#counter, 0, this.#block, 0);
        this.#increment();
        this.#used = 0;
      }
      out[i] = input[i] ^ this.#block[this.#used++];
    }
    return out;
  }

  #increment(): void {
    const stop = this.#inc32 ? 12 : 0;
    for (let i = 15; i >= stop; i--) {
      this.#counter[i] = (this.#counter[i] + 1) & 0xff;
      if (this.#counter[i] !== 0) {
        return;
      }
    }
  }
}

class CtrEngine implements Engine {
  #stream: Keystream;

  constructor(aes: AesKey, iv: Uint8Array) {
    this.#stream = new Keystream(aes, iv, false);
  }

  update(input: Uint8Array): Uint8Array {
    return this.#stream.xor(input);
  }

  final(): Uint8Array {
    return new Uint8Array(0);
  }
}

function authFailure(): Error {
  return new Error("Unsupported state or unable to authenticate data");
}

/** Streams whole blocks into GHASH, buffering a partial one. */
class GhashStream {
  readonly ghash: Ghash;
  length = 0;
  #partial = new Uint8Array(16);
  #fill = 0;

  constructor(ghash: Ghash) {
    this.ghash = ghash;
  }

  write(bytes: Uint8Array): void {
    this.length += bytes.length;
    let offset = 0;
    if (this.#fill > 0) {
      const take = Math.min(16 - this.#fill, bytes.length);
      this.#partial.set(bytes.subarray(0, take), this.#fill);
      this.#fill += take;
      offset = take;
      if (this.#fill < 16) {
        return;
      }
      this.ghash.update(this.#partial, 0);
      this.#fill = 0;
    }
    for (; offset + 16 <= bytes.length; offset += 16) {
      this.ghash.update(bytes, offset);
    }
    if (offset < bytes.length) {
      this.#partial.set(bytes.subarray(offset));
      this.#fill = bytes.length - offset;
    }
  }

  /** Zero-pads and absorbs any partial block. */
  pad(): void {
    if (this.#fill > 0) {
      this.#partial.fill(0, this.#fill);
      this.ghash.update(this.#partial, 0);
      this.#fill = 0;
    }
  }
}

function lengthBlock(aadBytes: number, dataBytes: number): Uint8Array {
  const block = new Uint8Array(16);
  const view = new DataView(block.buffer);
  const aadBits = aadBytes * 8;
  const dataBits = dataBytes * 8;
  view.setUint32(0, Math.floor(aadBits / 2 ** 32));
  view.setUint32(4, aadBits >>> 0);
  view.setUint32(8, Math.floor(dataBits / 2 ** 32));
  view.setUint32(12, dataBits >>> 0);
  return block;
}

/** Valid GCM tag lengths, as OpenSSL/Node accept them. */
function isValidGcmTagLength(length: number): boolean {
  return length === 4 || length === 8 || (length >= 12 && length <= 16);
}

class GcmEngine implements Engine {
  tag: Uint8Array | null = null;
  expectedTag: Uint8Array | null = null;
  #aes: AesKey;
  #decrypt: boolean;
  #j0: Uint8Array;
  #stream: Keystream;
  #aad: GhashStream;
  #data: GhashStream | null = null;
  #tagLength: number;

  constructor(aes: AesKey, iv: Uint8Array, decrypt: boolean, tagLength: number) {
    this.#aes = aes;
    this.#decrypt = decrypt;
    this.#tagLength = tagLength;
    const h = new Uint8Array(16);
    aes.encryptBlock(new Uint8Array(16), 0, h, 0);
    const ghash = new Ghash(h);
    if (iv.length === 12) {
      this.#j0 = new Uint8Array(16);
      this.#j0.set(iv);
      this.#j0[15] = 1;
    } else {
      const ivHash = new GhashStream(new Ghash(h));
      ivHash.write(iv);
      ivHash.pad();
      ivHash.ghash.update(lengthBlock(0, iv.length), 0);
      this.#j0 = ivHash.ghash.digest();
    }
    const first = this.#j0.slice();
    for (let i = 15; i >= 12; i--) {
      first[i] = (first[i] + 1) & 0xff;
      if (first[i] !== 0) {
        break;
      }
    }
    this.#stream = new Keystream(aes, first, true);
    this.#aad = new GhashStream(ghash);
  }

  /** Adds additional authenticated data; false once message data has started. */
  addAad(aad: Uint8Array): boolean {
    if (this.#data) {
      return false;
    }
    this.#aad.write(aad);
    return true;
  }

  update(input: Uint8Array): Uint8Array {
    const data = this.#startData();
    const out = this.#stream.xor(input);
    data.write(this.#decrypt ? input : out);
    return out;
  }

  final(): Uint8Array {
    const data = this.#startData();
    data.pad();
    data.ghash.update(lengthBlock(this.#aad.length, data.length), 0);
    const s = data.ghash.digest();
    const ekj0 = new Uint8Array(16);
    this.#aes.encryptBlock(this.#j0, 0, ekj0, 0);
    for (let i = 0; i < 16; i++) {
      s[i] ^= ekj0[i];
    }
    if (!this.#decrypt) {
      this.tag = s.slice(0, this.#tagLength);
      return new Uint8Array(0);
    }
    const expected = this.expectedTag;
    if (!expected) {
      throw authFailure();
    }
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected[i] ^ s[i];
    }
    if (diff !== 0) {
      throw authFailure();
    }
    return new Uint8Array(0);
  }

  #startData(): GhashStream {
    if (!this.#data) {
      this.#aad.pad();
      this.#data = new GhashStream(this.#aad.ghash);
    }
    return this.#data;
  }
}

// --- Cipheriv / Decipheriv ------------------------------------------------

type StreamCallback = (error?: Error | null) => void;

function invalidState(operation?: string): Error {
  return codedError(
    Error,
    "ERR_CRYPTO_INVALID_STATE",
    operation ? `Invalid state for operation ${operation}` : "Invalid state",
  );
}

function stringOption(options: unknown, key: string): string | undefined {
  if (options && typeof options === "object") {
    const value = (options as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) {
      validateString(value, `options.${key}`);
      return value;
    }
  }
  return undefined;
}

function uintOption(options: unknown, key: string): number {
  if (options && typeof options === "object") {
    const value = (options as Record<string, unknown>)[key];
    if (value !== undefined) {
      if (typeof value !== "number" || value >>> 0 !== value) {
        throw invalidArgValue(`options.${key}`, value);
      }
      return value;
    }
  }
  return -1;
}

function transformOptions(options: unknown): Record<string, unknown> | undefined {
  return options !== null && typeof options === "object"
    ? (options as Record<string, unknown>)
    : undefined;
}

/** What Cipheriv and Decipheriv share: a mode engine behind Node's Cipher API. */
abstract class CipherBase extends Transform {
  #engine: Engine | null;
  #decrypt: boolean;
  #decoder: OutputDecoder | null = null;
  #tag: Uint8Array | null = null;
  #tagLength: number;
  #tagSet = false;

  constructor(decrypt: boolean, cipher: unknown, key: unknown, iv: unknown, options: unknown) {
    super(transformOptions(options));
    validateString(cipher, "cipher");
    const keyBytes = secretKeyBytes(key, "key", stringOption(options, "encoding"));
    const ivBytes = iv === null ? null : byteSource(iv, "iv");
    const authTagLength = uintOption(options, "authTagLength");
    const found = findCipher(cipher);
    if (!found) {
      throw codedError(Error, "ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
    }
    this.#decrypt = decrypt;
    if (
      ivBytes === null ||
      ivBytes.length === 0 ||
      (found.mode !== "gcm" && ivBytes.length !== found.ivLength)
    ) {
      throw codedError(TypeError, "ERR_CRYPTO_INVALID_IV", "Invalid initialization vector");
    }
    if (keyBytes.length !== found.keyLength) {
      throw codedError(RangeError, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length");
    }
    if (found.mode === "gcm" && authTagLength !== -1 && !isValidGcmTagLength(authTagLength)) {
      throw codedError(
        TypeError,
        "ERR_CRYPTO_INVALID_AUTH_TAG",
        `Invalid authentication tag length: ${authTagLength}`,
      );
    }
    this.#tagLength = authTagLength;
    const aes = new AesKey(keyBytes);
    switch (found.mode) {
      case "cbc":
        this.#engine = new CbcEngine(aes, ivBytes, decrypt);
        break;
      case "ctr":
        this.#engine = new CtrEngine(aes, ivBytes);
        break;
      case "gcm":
        this.#engine = new GcmEngine(
          aes,
          ivBytes,
          decrypt,
          authTagLength === -1 ? 16 : authTagLength,
        );
        break;
    }
  }

  /**
   * Encrypts/decrypts `data` (a string in `inputEncoding` or an
   * ArrayBufferView); returns a Buffer, or a string in `outputEncoding`.
   */
  update(data: unknown, inputEncoding?: string, outputEncoding?: string): Buffer | string {
    const bytes = dataBytes(data, inputEncoding);
    if (!this.#engine) {
      throw new Error("Trying to add data in unsupported state");
    }
    return this.#output(this.#engine.update(bytes), outputEncoding, false);
  }

  /** The remaining output (padding, for CBC); verifies the tag when decrypting GCM. */
  final(outputEncoding?: string): Buffer | string {
    const engine = this.#engine;
    if (!engine) {
      throw invalidState();
    }
    this.#engine = null;
    const bytes = engine.final();
    if (engine instanceof GcmEngine && engine.tag) {
      this.#tag = engine.tag;
    }
    return this.#output(bytes, outputEncoding, true);
  }

  /** Turns PKCS#7 padding on or off (CBC); a no-op for stream modes. */
  setAutoPadding(autoPadding = true): this {
    if (!this.#engine) {
      throw invalidState("setAutoPadding");
    }
    if (this.#engine instanceof CbcEngine) {
      this.#engine.autoPadding = !!autoPadding;
    }
    return this;
  }

  /** Adds GCM additional authenticated data, before any message data. */
  setAAD(buffer: unknown, options?: unknown): this {
    const encoding = stringOption(options, "encoding");
    uintOption(options, "plaintextLength");
    const bytes = byteSource(buffer, "buffer", encoding);
    const engine = this.#engine;
    if (!(engine instanceof GcmEngine) || !engine.addAad(bytes)) {
      throw invalidState("setAAD");
    }
    return this;
  }

  protected authTag(): Buffer {
    if (this.#engine || this.#decrypt || !this.#tag) {
      throw invalidState("getAuthTag");
    }
    return toBuffer(this.#tag.slice());
  }

  protected acceptAuthTag(tag: unknown, encoding?: string): this {
    const bytes = byteSource(tag, "buffer", encoding);
    const engine = this.#engine;
    if (!(engine instanceof GcmEngine) || !this.#decrypt || this.#tagSet) {
      throw invalidState("setAuthTag");
    }
    if (
      (this.#tagLength !== -1 && this.#tagLength !== bytes.length) ||
      !isValidGcmTagLength(bytes.length)
    ) {
      throw codedError(
        TypeError,
        "ERR_CRYPTO_INVALID_AUTH_TAG",
        `Invalid authentication tag length: ${bytes.length}`,
      );
    }
    this.#tagSet = true;
    engine.expectedTag = bytes.slice();
    return this;
  }

  override _transform(chunk: unknown, encoding: string, callback: StreamCallback): void {
    try {
      this.push(this.update(chunk, encoding));
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: StreamCallback): void {
    try {
      this.push(this.final());
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  #output(bytes: Uint8Array, outputEncoding: string | undefined, end: boolean): Buffer | string {
    if (!outputEncoding || outputEncoding === "buffer") {
      return toBuffer(bytes);
    }
    const normalized = normalizeEncoding(outputEncoding);
    if (normalized === undefined) {
      throw codedError(TypeError, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${outputEncoding}`);
    }
    if (!this.#decoder) {
      this.#decoder = new OutputDecoder(normalized);
    } else if (this.#decoder.encoding !== normalized) {
      throw codedError(Error, "ERR_INTERNAL_ASSERTION", "Cannot change encoding");
    }
    return end ? this.#decoder.end(bytes) : this.#decoder.write(bytes);
  }
}

/** `crypto.Cipheriv`: encryption. */
export class Cipheriv extends CipherBase {
  constructor(cipher: unknown, key: unknown, iv: unknown, options?: unknown) {
    super(false, cipher, key, iv, options);
  }

  /** The GCM authentication tag, after `final()`. */
  getAuthTag(): Buffer {
    return this.authTag();
  }
}

/** `crypto.Decipheriv`: decryption. */
export class Decipheriv extends CipherBase {
  constructor(cipher: unknown, key: unknown, iv: unknown, options?: unknown) {
    super(true, cipher, key, iv, options);
  }

  /** Sets the GCM tag `final()` verifies. */
  setAuthTag(tag: unknown, encoding?: string): this {
    return this.acceptAuthTag(tag, encoding);
  }
}

/** `crypto.createCipheriv(algorithm, key, iv[, options])`. */
export function createCipheriv(
  algorithm: unknown,
  key: unknown,
  iv: unknown,
  options?: unknown,
): Cipheriv {
  return new Cipheriv(algorithm, key, iv, options);
}

/** `crypto.createDecipheriv(algorithm, key, iv[, options])`. */
export function createDecipheriv(
  algorithm: unknown,
  key: unknown,
  iv: unknown,
  options?: unknown,
): Decipheriv {
  return new Decipheriv(algorithm, key, iv, options);
}
