import { inflateSync } from "fflate";

/**
 * A zip read by its central directory, one entry at a time, straight from the
 * file. The directory at the end of a zip states where every entry starts and
 * how long it is, so an entry is sliced out exactly: nothing but the entries
 * asked for is read, however large the archive.
 *
 * A zip cannot be split safely from the front. A zipper that streams (Finder's
 * Compress, most folder downloads) leaves the sizes out of each entry's header
 * and writes them after its data, and a reader working forwards then has to
 * guess where an entry ends by looking for the next header's signature — which
 * compressed audio contains by chance about once a gigabyte.
 */

const END_OF_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END_OF_DIRECTORY = 0x06064b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const ZIP64_EXTRA = 0x0001;

const END_OF_DIRECTORY_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const DIRECTORY_ENTRY_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
/** A directory of a hundred thousand entries is a few megabytes. */
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;

const STORED = 0;
const DEFLATED = 8;

export interface ZipDirectoryEntry {
  name: string;
  /** Bytes once read out of the archive. */
  size: number;
  compressedSize: number;
  method: number;
  encrypted: boolean;
  crc32: number;
  headerOffset: number;
}

async function bytesAt(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

const viewOf = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value;
});

function crc32Of(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The entries a zip lists, in its directory's order. Throws when the file has no readable directory. */
export async function readZipDirectory(file: Blob): Promise<ZipDirectoryEntry[]> {
  const tailStart = Math.max(0, file.size - (END_OF_DIRECTORY_BYTES + MAX_COMMENT_BYTES));
  const tail = await bytesAt(file, tailStart, file.size);
  const tailView = viewOf(tail);
  let end = tail.length - END_OF_DIRECTORY_BYTES;
  while (end >= 0 && tailView.getUint32(end, true) !== END_OF_DIRECTORY) end -= 1;
  if (end < 0) {
    throw new Error("it has no zip directory");
  }
  let count = tailView.getUint16(end + 10, true);
  let size = tailView.getUint32(end + 12, true);
  let offset = tailView.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    // A zip64 archive: the real numbers are in a record a locator points at.
    const locator = end - 20;
    if (locator < 0 || tailView.getUint32(locator, true) !== ZIP64_LOCATOR) {
      throw new Error("its zip64 directory is damaged");
    }
    const recordOffset = Number(tailView.getBigUint64(locator + 8, true));
    const record = await bytesAt(file, recordOffset, recordOffset + 56);
    if (record.length < 56 || viewOf(record).getUint32(0, true) !== ZIP64_END_OF_DIRECTORY) {
      throw new Error("its zip64 directory is damaged");
    }
    count = Number(viewOf(record).getBigUint64(32, true));
    size = Number(viewOf(record).getBigUint64(40, true));
    offset = Number(viewOf(record).getBigUint64(48, true));
  }
  if (size > MAX_DIRECTORY_BYTES || offset + size > file.size) {
    throw new Error("its zip directory is damaged");
  }

  const directory = await bytesAt(file, offset, offset + size);
  const view = viewOf(directory);
  const decoder = new TextDecoder();
  const entries: ZipDirectoryEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (
      at + DIRECTORY_ENTRY_BYTES > directory.length ||
      view.getUint32(at, true) !== DIRECTORY_ENTRY
    ) {
      throw new Error("its zip directory is damaged");
    }
    const flags = view.getUint16(at + 8, true);
    let compressedSize = view.getUint32(at + 20, true);
    let entrySize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let headerOffset = view.getUint32(at + 42, true);
    const nameStart = at + DIRECTORY_ENTRY_BYTES;
    const extraEnd = nameStart + nameLength + extraLength;
    if (extraEnd + commentLength > directory.length) {
      throw new Error("its zip directory is damaged");
    }
    // Sizes and offsets past 4 GB are kept in a zip64 extra field, in this order.
    for (let extra = nameStart + nameLength; extra + 4 <= extraEnd;) {
      const id = view.getUint16(extra, true);
      const length = view.getUint16(extra + 2, true);
      if (id === ZIP64_EXTRA) {
        let field = extra + 4;
        const next = () => {
          const value = Number(view.getBigUint64(field, true));
          field += 8;
          return value;
        };
        if (entrySize === 0xffffffff) entrySize = next();
        if (compressedSize === 0xffffffff) compressedSize = next();
        if (headerOffset === 0xffffffff) headerOffset = next();
      }
      extra += 4 + length;
    }
    entries.push({
      name: decoder.decode(directory.subarray(nameStart, nameStart + nameLength)),
      size: entrySize,
      compressedSize,
      method: view.getUint16(at + 10, true),
      encrypted: (flags & 1) !== 0,
      crc32: view.getUint32(at + 16, true),
      headerOffset,
    });
    at = extraEnd + commentLength;
  }
  return entries;
}

/** One entry's bytes, checked against the directory's size and checksum. Throws with the reason. */
export async function readZipEntry(file: Blob, entry: ZipDirectoryEntry): Promise<Uint8Array> {
  if (entry.encrypted) {
    throw new Error("it is encrypted");
  }
  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw new Error(`its compression (method ${entry.method}) is not supported`);
  }
  const header = await bytesAt(file, entry.headerOffset, entry.headerOffset + LOCAL_HEADER_BYTES);
  if (header.length < LOCAL_HEADER_BYTES || viewOf(header).getUint32(0, true) !== LOCAL_HEADER) {
    throw new Error("the zip is damaged where it starts");
  }
  // The entry's own header repeats the name and may carry other extra fields.
  const start =
    entry.headerOffset +
    LOCAL_HEADER_BYTES +
    viewOf(header).getUint16(26, true) +
    viewOf(header).getUint16(28, true);
  const data = await bytesAt(file, start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) {
    throw new Error("the zip ends before it does");
  }
  const bytes =
    entry.method === STORED ? data : inflateSync(data, { out: new Uint8Array(entry.size) });
  if (bytes.length !== entry.size || crc32Of(bytes) !== entry.crc32) {
    throw new Error("it is damaged (its checksum does not match)");
  }
  return bytes;
}
