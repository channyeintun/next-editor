// How the answer to a blocking call is laid out in a sync buffer. A value is
// raw bytes, nothing, or JSON; byte arrays inside a JSON value travel after it
// as blobs, so a `spawnSync` result or a directory listing costs one copy.
import {
  PAYLOAD_BYTES,
  PAYLOAD_JSON,
  PAYLOAD_VOID,
  SYNC_ERROR,
  SYNC_HEADER_BYTES,
  SYNC_KIND,
  SYNC_LENGTH,
  SYNC_OK,
  SYNC_STATE,
  SYNC_TOO_SMALL,
} from "../protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface EncodedPayload {
  kind: number;
  bytes: Uint8Array;
}

const NO_BYTES = new Uint8Array(0);

/** Encodes `value` for a sync buffer. */
export function encodePayload(value: unknown): EncodedPayload {
  if (value === undefined) {
    return { kind: PAYLOAD_VOID, bytes: NO_BYTES };
  }
  if (value instanceof Uint8Array) {
    return { kind: PAYLOAD_BYTES, bytes: value };
  }

  const blobs: Uint8Array[] = [];
  const json = encoder.encode(
    JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof Uint8Array) {
        blobs.push(item);
        return { $blob: blobs.length - 1 };
      }
      return item;
    }),
  );

  let length = 4 + json.byteLength;
  for (const blob of blobs) {
    length += 4 + blob.byteLength;
  }
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, json.byteLength);
  bytes.set(json, 4);
  let offset = 4 + json.byteLength;
  for (const blob of blobs) {
    view.setUint32(offset, blob.byteLength);
    bytes.set(blob, offset + 4);
    offset += 4 + blob.byteLength;
  }
  return { kind: PAYLOAD_JSON, bytes };
}

/** Decodes what `encodePayload` produced. `bytes` must not be shared memory. */
export function decodePayload(kind: number, bytes: Uint8Array): unknown {
  if (kind === PAYLOAD_VOID) {
    return undefined;
  }
  if (kind === PAYLOAD_BYTES) {
    return bytes;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(0);
  const blobs: Uint8Array[] = [];
  let offset = 4 + jsonLength;
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset);
    blobs.push(bytes.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return JSON.parse(decoder.decode(bytes.subarray(4, 4 + jsonLength)), (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && "$blob" in item) {
      return blobs[(item as { $blob: number }).$blob];
    }
    return item;
  });
}

/**
 * Writes an answer into `buffer` and wakes the waiting worker. Returns false,
 * having told the worker how many bytes it needs, when the answer does not fit.
 */
export function writeSyncAnswer(
  buffer: SharedArrayBuffer,
  ok: boolean,
  payload: EncodedPayload,
): boolean {
  const header = new Int32Array(buffer, 0, SYNC_HEADER_BYTES / 4);
  const capacity = buffer.byteLength - SYNC_HEADER_BYTES;
  header[SYNC_LENGTH] = payload.bytes.byteLength;
  header[SYNC_KIND] = payload.kind;

  const fits = payload.bytes.byteLength <= capacity;
  if (fits) {
    new Uint8Array(buffer, SYNC_HEADER_BYTES, payload.bytes.byteLength).set(payload.bytes);
  }
  Atomics.store(header, SYNC_STATE, fits ? (ok ? SYNC_OK : SYNC_ERROR) : SYNC_TOO_SMALL);
  Atomics.notify(header, SYNC_STATE);
  return fits;
}

/** Copies the answer out of `buffer`: the payload kind and its bytes, unshared. */
export function readSyncAnswer(buffer: SharedArrayBuffer): { kind: number; bytes: Uint8Array } {
  const header = new Int32Array(buffer, 0, SYNC_HEADER_BYTES / 4);
  const length = header[SYNC_LENGTH];
  // A copy, because TextDecoder refuses a view of shared memory.
  const bytes = new Uint8Array(length);
  bytes.set(new Uint8Array(buffer, SYNC_HEADER_BYTES, length));
  return { kind: header[SYNC_KIND], bytes };
}
