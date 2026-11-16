// `crypto.timingSafeEqual`: a constant-time byte comparison with Node's checks.
import { bytesOf, isAnyArrayBuffer } from "./encoding";
import { codedError } from "./errors";

function bytesArgument(value: unknown, name: string): Uint8Array {
  if (ArrayBuffer.isView(value) || isAnyArrayBuffer(value)) {
    return bytesOf(value);
  }
  // Node raises this from C++, without the usual "Received ..." tail.
  throw codedError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`,
  );
}

/** Whether `a` and `b` hold the same bytes, in time that depends only on their length. */
export function timingSafeEqual(a: unknown, b: unknown): boolean {
  const left = bytesArgument(a, "buf1");
  const right = bytesArgument(b, "buf2");
  if (left.byteLength !== right.byteLength) {
    throw codedError(
      RangeError,
      "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
      "Input buffers must have the same byte length",
    );
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}
