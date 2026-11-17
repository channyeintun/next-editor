// Keys for the crypto builtin: `KeyObject` for secret (symmetric) keys, which
// `crypto.createSecretKey` makes, and secret-key input (Node's
// `prepareSecretKey`): the raw bytes of a string, ArrayBuffer, ArrayBufferView
// or secret KeyObject key. Asymmetric KeyObjects do not exist here
// (crypto/unavailable.ts), and a CryptoKey is refused with a named error: its
// bytes cannot be read synchronously.
import type { Buffer } from "buffer/";
import {
  byteSource,
  bytesOf,
  decodeString,
  encodeBytes,
  isAnyArrayBuffer,
  toBuffer,
} from "./encoding";
import { codedError, invalidArgType, invalidArgValue, unavailable, validateObject } from "./errors";

/** Stands in for Node's native key handle; only this module makes one. */
class KeyHandle {
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
}

/** `crypto.KeyObject`. Only secret keys exist in webnode. */
export class KeyObject {
  readonly #type: "secret" | "public" | "private";
  readonly #handle: KeyHandle;

  constructor(type: unknown, handle: unknown) {
    if (type !== "secret" && type !== "public" && type !== "private") {
      throw invalidArgValue("type", type);
    }
    if (!(handle instanceof KeyHandle)) {
      throw invalidArgType("handle", "of type object", handle);
    }
    this.#type = type;
    this.#handle = handle;
  }

  /** `KeyObject.from(cryptoKey)`: a CryptoKey's bytes cannot be read synchronously. */
  static from(key: unknown): never {
    if (typeof CryptoKey === "undefined" || !(key instanceof CryptoKey)) {
      throw invalidArgType("key", "an instance of CryptoKey", key);
    }
    throw unavailable("KeyObject.from");
  }

  get type(): "secret" | "public" | "private" {
    return this.#type;
  }

  /** Making a CryptoKey is asynchronous in the browser; Node's is synchronous. */
  toCryptoKey(): never {
    throw unavailable("KeyObject.prototype.toCryptoKey");
  }

  equals(otherKeyObject: unknown): boolean {
    if (!(otherKeyObject instanceof KeyObject)) {
      throw invalidArgType("otherKeyObject", "an instance of KeyObject", otherKeyObject);
    }
    if (otherKeyObject.type !== this.#type) {
      return false;
    }
    const a = this.#handle.bytes;
    const b = keyBytes(otherKeyObject);
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  }

  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, {
      value: "KeyObject",
      configurable: true,
    });
  }
}

/** The key material behind `key`, for this module and the crypto functions that take a key. */
function keyBytes(key: KeyObject): Uint8Array {
  return SecretKeyObject.bytesOf(key);
}

/** A secret KeyObject, as `crypto.createSecretKey` returns. */
export class SecretKeyObject extends KeyObject {
  readonly #bytes: Uint8Array;

  constructor(handle: KeyHandle) {
    super("secret", handle);
    this.#bytes = handle.bytes;
  }

  static bytesOf(key: KeyObject): Uint8Array {
    return #bytes in key ? (key as SecretKeyObject).#bytes : new Uint8Array(0);
  }

  get symmetricKeySize(): number {
    return this.#bytes.length;
  }

  export(options?: unknown): Buffer | { kty: "oct"; k: string } {
    if (options !== undefined) {
      validateObject(options, "options");
      const format = (options as { format?: unknown }).format;
      if (format === "jwk") {
        return { kty: "oct", k: encodeBytes(this.#bytes, "base64url") };
      }
      if (format !== undefined && format !== "buffer") {
        throw invalidArgValue(
          "options.format",
          format,
          "must be one of: undefined, 'buffer', 'jwk'",
        );
      }
    }
    return toBuffer(this.#bytes.slice());
  }
}

/** `crypto.createSecretKey(key[, encoding])`: a KeyObject over a copy of `key`. */
export function createSecretKey(key: unknown, encoding?: unknown): SecretKeyObject {
  let bytes: Uint8Array;
  if (typeof key === "string") {
    bytes = decodeString(key, encoding);
  } else if (ArrayBuffer.isView(key) || isAnyArrayBuffer(key)) {
    bytes = bytesOf(key).slice();
  } else {
    throw invalidArgType("key", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView", key);
  }
  return new SecretKeyObject(new KeyHandle(bytes));
}

/** The bytes of a secret KeyObject, or undefined for any other value. */
export function secretKeyObjectBytes(key: unknown): Uint8Array | undefined {
  return key instanceof KeyObject && key.type === "secret" ? keyBytes(key) : undefined;
}

/** The bytes of a secret `key` argument; a string key is decoded with `encoding`. */
export function secretKeyBytes(key: unknown, name: string, encoding?: unknown): Uint8Array {
  if (typeof key === "string" || ArrayBuffer.isView(key) || isAnyArrayBuffer(key)) {
    return byteSource(key, name, encoding);
  }
  const fromKeyObject = secretKeyObjectBytes(key);
  if (fromKeyObject) {
    return fromKeyObject;
  }
  if (typeof CryptoKey !== "undefined" && key instanceof CryptoKey) {
    throw codedError(
      Error,
      "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
      `A CryptoKey as the "${name}" argument is not available in webnode`,
    );
  }
  throw invalidArgType(
    name,
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey",
    key,
  );
}
