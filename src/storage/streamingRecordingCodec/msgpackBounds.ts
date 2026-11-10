// ============================================================================
// What a MessagePack document costs to decode, measured before decoding it.
//
// `@msgpack/msgpack` trusts the lengths a document declares. An array header
// preallocates `new Array(length)` from its 32-bit count before one element is
// read, so a run of nested five-byte `array32` headers asked the engine for
// gigabytes and only then failed, at the end of the input. And every one-byte
// empty array or map becomes a JavaScript object many times its encoded size, so
// a payload well inside the codec's inflated-byte limits still decoded to a heap
// far past what those limits were meant to allow. The decoder's own length
// options do not help: they cap each container separately, and nested headers
// each preallocate up to the cap.
//
// `measureMsgpackDecodedCost` therefore walks the document's structure first,
// allocating nothing per value, and refuses it unless every declared container
// is backed by the bytes that follow. A document that passes decodes to exactly
// the values counted here, so the count is charged against the stream's budget
// before the decoder allocates anything.
// ============================================================================

/**
 * The deepest nesting a writer can produce (the encoder's `maxDepth`), so the
 * deepest a reader accepts. It also bounds every recursive walk over decoded
 * records, which would otherwise exhaust the call stack on a hostile file.
 */
export const MSGPACK_MAX_DEPTH = 1_100;

/**
 * Heap a decoded value takes beyond its encoded bytes: the slot that refers to
 * it, and for an array or a map the object itself. Rough on purpose. They only
 * have to keep a payload of tiny values from decoding to a heap many times the
 * bytes it is charged for.
 */
const VALUE_COST_BYTES = 8;
const CONTAINER_COST_BYTES = 24;

// Items still owed by each open container. One scan runs at a time (it is
// synchronous), so the stack is shared rather than allocated per document.
const owedByDepth = new Float64Array(MSGPACK_MAX_DEPTH);

function malformed(): never {
  throw new Error("Invalid SCR3 stream: malformed record data");
}

/**
 * The bytes a reader charges for decoding `bytes`: their own length plus a fixed
 * cost for every value they hold. Throws, before anything is decoded, when the
 * document is truncated, nests deeper than {@link MSGPACK_MAX_DEPTH}, or declares
 * a container with more items than there are bytes left to hold them.
 *
 * Readers and writers both call this, so a writer knows what its segment will
 * cost a reader.
 */
export function measureMsgpackDecodedCost(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength;
  let offset = 0;
  let depth = 0;
  // Items owed by every open container together. Each takes at least one byte.
  let owed = 0;
  let values = 0;
  let containers = 0;

  const readLength = (size: 1 | 2 | 4): number => {
    if (offset + size > end) malformed();
    const length =
      size === 1
        ? view.getUint8(offset)
        : size === 2
          ? view.getUint16(offset)
          : view.getUint32(offset);
    offset += size;
    return length;
  };

  do {
    if (offset >= end) malformed();
    const head = bytes[offset];
    offset += 1;
    // Payload bytes to step over, or the item count of a container.
    let skip = 0;
    let items = -1;

    if (head < 0x80 || head >= 0xe0) {
      // fixint
    } else if (head < 0x90) {
      items = (head & 0x0f) * 2;
    } else if (head < 0xa0) {
      items = head & 0x0f;
    } else if (head < 0xc0) {
      skip = head & 0x1f;
    } else {
      switch (head) {
        case 0xc0: // nil
        case 0xc2: // false
        case 0xc3: // true
          break;
        case 0xc4: // bin 8
        case 0xd9: // str 8
          skip = readLength(1);
          break;
        case 0xc5: // bin 16
        case 0xda: // str 16
          skip = readLength(2);
          break;
        case 0xc6: // bin 32
        case 0xdb: // str 32
          skip = readLength(4);
          break;
        case 0xc7: // ext 8: length, then a type byte
          skip = readLength(1) + 1;
          break;
        case 0xc8: // ext 16
          skip = readLength(2) + 1;
          break;
        case 0xc9: // ext 32
          skip = readLength(4) + 1;
          break;
        case 0xcc: // uint 8
        case 0xd0: // int 8
          skip = 1;
          break;
        case 0xcd: // uint 16
        case 0xd1: // int 16
        case 0xd4: // fixext 1
          skip = 2;
          break;
        case 0xd5: // fixext 2
          skip = 3;
          break;
        case 0xca: // float 32
        case 0xce: // uint 32
        case 0xd2: // int 32
          skip = 4;
          break;
        case 0xd6: // fixext 4
          skip = 5;
          break;
        case 0xcb: // float 64
        case 0xcf: // uint 64
        case 0xd3: // int 64
          skip = 8;
          break;
        case 0xd7: // fixext 8
          skip = 9;
          break;
        case 0xd8: // fixext 16
          skip = 17;
          break;
        case 0xdc: // array 16
          items = readLength(2);
          break;
        case 0xdd: // array 32
          items = readLength(4);
          break;
        case 0xde: // map 16
          items = readLength(2) * 2;
          break;
        case 0xdf: // map 32
          items = readLength(4) * 2;
          break;
        default: // 0xc1 is never used
          malformed();
      }
    }

    values += 1;
    if (depth > 0) {
      owedByDepth[depth - 1] -= 1;
      owed -= 1;
    }

    if (items < 0) {
      offset += skip;
      if (offset > end) malformed();
    } else {
      containers += 1;
      if (items > 0) {
        if (depth >= MSGPACK_MAX_DEPTH) {
          throw new Error("Invalid SCR3 stream: record data is nested too deeply");
        }
        // The decoder preallocates an array from this count alone, so it must be
        // backed by bytes: every item owed, here and in each enclosing container,
        // needs at least one.
        if (owed + items > end - offset) malformed();
        owedByDepth[depth] = items;
        depth += 1;
        owed += items;
      }
    }

    while (depth > 0 && owedByDepth[depth - 1] === 0) depth -= 1;
  } while (depth > 0);

  return end + values * VALUE_COST_BYTES + containers * CONTAINER_COST_BYTES;
}
