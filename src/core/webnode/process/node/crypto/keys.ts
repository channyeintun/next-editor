// Secret-key input for the crypto builtin (Node's `prepareSecretKey`): the raw
// bytes of a string, ArrayBuffer or ArrayBufferView key. KeyObject and
// CryptoKey keys are refused with a named error: webnode has no KeyObject, and
// a CryptoKey's bytes cannot be read synchronously.
import { byteSource, isAnyArrayBuffer } from "./encoding";
import { codedError, invalidArgType } from "./errors";

/** The bytes of a secret `key` argument; a string key is decoded with `encoding`. */
export function secretKeyBytes(key: unknown, name: string, encoding?: unknown): Uint8Array {
  if (typeof key === "string" || ArrayBuffer.isView(key) || isAnyArrayBuffer(key)) {
    return byteSource(key, name, encoding);
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
