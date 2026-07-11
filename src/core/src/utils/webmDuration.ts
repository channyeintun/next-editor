/**
 * Inject a Duration element into a MediaRecorder WebM blob.
 *
 * MediaRecorder writes a live (streamed) WebM whose Segment > Info section has NO Duration element
 * (Chromium issue 642012): the length isn't known until recording stops, so players and editors show
 * an unknown/`Infinity` duration and can't build a seek bar until they scan the whole file. Because
 * the screen actor knows the wall-clock length at stop time, we patch the header in place.
 *
 * This is a deliberately minimal EBML editor scoped to exactly this fix — it locates the Info section,
 * inserts (or overwrites) a `Duration` float, and rewrites only the affected size fields. Anything it
 * doesn't understand (non-WebM input, an already-definite Segment size it can't safely widen, any parse
 * error) makes it return the ORIGINAL blob untouched: the guarantee is "never corrupt the file", since
 * this is the user's keep-forever artifact. MP4 output already carries a duration, so callers skip it.
 *
 * EBML primer (see https://www.matroska.org/technical/elements.html):
 *  - Every element is `[ID][size][data]`. The ID's byte length is signalled by the position of the
 *    first set bit in its first byte; the size is a variable-length integer (vint) whose first byte's
 *    leading bit position gives its length, with the remaining bits (plus following bytes) the value.
 *  - A size vint of all-ones data bits means "unknown size" (used for the streamed Segment).
 */

// Element IDs (raw, length-prefixed bytes — compared directly, never decoded).
const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const INFO_ID = [0x15, 0x49, 0xa9, 0x66];
const DURATION_ID = [0x44, 0x89];
const TIMECODE_SCALE_ID = [0x2a, 0xd7, 0xb1];

const DEFAULT_TIMECODE_SCALE_NS = 1_000_000; // 1ms per timecode unit — MediaRecorder's default.

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** Length (1–4 bytes) of the element ID that starts at `firstByte`. */
const idByteLength = (firstByte: number): number => {
  let mask = 0x80;
  let length = 1;
  while (length <= 4 && (firstByte & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 4) throw new Error("Invalid EBML element ID");
  return length;
};

interface VintSize {
  /** Decoded size, or null when the vint encodes the "unknown size" sentinel. */
  size: number | null;
  /** Number of bytes the vint occupies. */
  length: number;
}

const readVintSize = (buf: Uint8Array, pos: number): VintSize => {
  const first = buf[pos];
  if (first === undefined) throw new Error("Truncated EBML size");
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8) throw new Error("Invalid EBML size");

  let value = first & (mask - 1);
  let unknown = value === mask - 1;
  for (let i = 1; i < length; i += 1) {
    const byte = buf[pos + i];
    if (byte === undefined) throw new Error("Truncated EBML size");
    value = value * 256 + byte;
    if (byte !== 0xff) unknown = false;
  }
  return { size: unknown ? null : value, length };
};

/**
 * Encode `value` as a size vint. With `forcedLength` it uses exactly that many bytes (for rewriting a
 * field in place); otherwise it uses the shortest length that holds the value without colliding with
 * the all-ones "unknown" sentinel. Returns null if the value can't fit the requested/available width.
 */
const encodeVintSize = (value: number, forcedLength?: number): Uint8Array | null => {
  let length = forcedLength ?? 1;
  if (forcedLength === undefined) {
    while (value > 2 ** (7 * length) - 2) {
      length += 1;
      if (length > 8) return null;
    }
  } else if (value > 2 ** (7 * length) - 2) {
    return null;
  }

  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    bytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[0] |= 0x80 >> (length - 1);
  return bytes;
};

interface FoundElement {
  /** Offset of the element's first ID byte. */
  idStart: number;
  /** Offset of the element's data (after ID + size). */
  contentStart: number;
  /** Offset just past the element's data. */
  contentEnd: number;
  /** Decoded size, or null for an unknown-size element. */
  size: number | null;
  /** Byte length of the size vint. */
  sizeLength: number;
}

/** First direct child of the container `[start, end)` whose ID equals `targetId`, or null. */
const findChild = (
  buf: Uint8Array,
  start: number,
  end: number,
  targetId: number[],
): FoundElement | null => {
  let pos = start;
  while (pos < end) {
    const idStart = pos;
    const idLen = idByteLength(buf[pos]!);
    let matches = idLen === targetId.length;
    for (let i = 0; matches && i < idLen; i += 1) {
      if (buf[idStart + i] !== targetId[i]) matches = false;
    }
    pos += idLen;

    const { size, length: sizeLength } = readVintSize(buf, pos);
    pos += sizeLength;
    const contentStart = pos;
    const contentEnd = size === null ? end : contentStart + size;
    if (contentEnd > end)
      return matches ? { idStart, contentStart, contentEnd, size, sizeLength } : null;

    if (matches) return { idStart, contentStart, contentEnd, size, sizeLength };
    pos = contentEnd;
  }
  return null;
};

/** Big-endian unsigned integer from `buf[start, end)`. */
const readUint = (buf: Uint8Array, start: number, end: number): number => {
  let value = 0;
  for (let i = start; i < end; i += 1) value = value * 256 + buf[i]!;
  return value;
};

/** A `Duration` element carrying `value` as an 8-byte big-endian double. */
const buildDurationElement = (value: number): Uint8Array => {
  const content = new Uint8Array(8);
  new DataView(content.buffer).setFloat64(0, value, false);
  // 0x88 = size vint for a length-8 payload.
  return concat(Uint8Array.from(DURATION_ID), Uint8Array.of(0x88), content);
};

/**
 * Return a copy of `blob` with a Duration element injected into its WebM header, computed from
 * `durationMs`. Returns the original blob unchanged on any non-WebM input or parse/encoding failure.
 */
export const fixWebmDuration = async (blob: Blob, durationMs: number): Promise<Blob> => {
  try {
    if (!(durationMs > 0)) return blob;

    const buf = new Uint8Array(await blob.arrayBuffer());
    const total = buf.length;

    const segment = findChild(buf, 0, total, SEGMENT_ID);
    if (!segment) return blob;

    const info = findChild(buf, segment.contentStart, segment.contentEnd, INFO_ID);
    // A definite Info size is required — its size field is what we rewrite.
    if (!info || info.size === null) return blob;

    let timecodeScale = DEFAULT_TIMECODE_SCALE_NS;
    const timecodeScaleEl = findChild(buf, info.contentStart, info.contentEnd, TIMECODE_SCALE_ID);
    if (timecodeScaleEl && timecodeScaleEl.size !== null) {
      const scale = readUint(buf, timecodeScaleEl.contentStart, timecodeScaleEl.contentEnd);
      if (scale > 0) timecodeScale = scale;
    }

    const durationValue = (durationMs * DEFAULT_TIMECODE_SCALE_NS) / timecodeScale;
    const durationEl = buildDurationElement(durationValue);

    const existingDuration = findChild(buf, info.contentStart, info.contentEnd, DURATION_ID);
    const newInfoContent = existingDuration
      ? concat(
          buf.subarray(info.contentStart, existingDuration.idStart),
          durationEl,
          buf.subarray(existingDuration.contentEnd, info.contentEnd),
        )
      : concat(buf.subarray(info.contentStart, info.contentEnd), durationEl);

    const newInfoSize = encodeVintSize(newInfoContent.length);
    if (!newInfoSize) return blob;
    const newInfoElement = concat(Uint8Array.from(INFO_ID), newInfoSize, newInfoContent);

    let out = concat(
      buf.subarray(0, info.idStart),
      newInfoElement,
      buf.subarray(info.contentEnd, total),
    );

    // If the Segment size is definite (rare for MediaRecorder — it streams an unknown-size Segment),
    // widen it by the same delta, preserving its original vint byte length. Bail if it won't fit.
    if (segment.size !== null) {
      const delta = out.length - total;
      const segSizeStart = segment.contentStart - segment.sizeLength;
      const reencoded = encodeVintSize(segment.size + delta, segment.sizeLength);
      if (!reencoded) return blob;
      out = out.slice();
      out.set(reencoded, segSizeStart);
    }

    return new Blob([out], { type: blob.type });
  } catch {
    // Never throw and never emit a corrupted file — fall back to the untouched blob.
    return blob;
  }
};
