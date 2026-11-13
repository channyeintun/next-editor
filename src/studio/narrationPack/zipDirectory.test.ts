import { strToU8, Zip, ZipDeflate, ZipPassThrough, zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { readZipDirectory, readZipEntry } from "./zipDirectory";

const blobOf = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>]);

/** A zip as a streaming zipper writes it: sizes after each entry's data, not in its header. */
function streamedZip(entries: Record<string, Uint8Array>, deflate: boolean): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, bytes] of Object.entries(entries)) {
    const entry = deflate ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    zip.add(entry);
    entry.push(bytes, true);
  }
  zip.end();
  const whole = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.length;
  }
  return whole;
}

/** Bytes that hold the signatures a forward reader takes for the end of an entry. */
function withSignatures(length: number): Uint8Array {
  const bytes = Uint8Array.from({ length }, (_, index) => (index * 131 + 7) & 0xff);
  bytes.set([0x50, 0x4b, 0x07, 0x08], 100); // a data descriptor's
  bytes.set([0x50, 0x4b, 0x03, 0x04], 300); // a local header's
  bytes.set([0x50, 0x4b, 0x01, 0x02], 500); // a directory entry's
  return bytes;
}

/**
 * The same archive with a zip64 end of directory: the plain record's numbers
 * are all-ones markers, and the real ones sit in a zip64 record a locator
 * points at, as in an archive past 4 GB or 65,535 entries.
 */
function asZip64(zip: Uint8Array): Uint8Array {
  const end = zip.length - 22;
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  const record = new Uint8Array(56);
  const recordView = new DataView(record.buffer);
  recordView.setUint32(0, 0x06064b50, true);
  recordView.setBigUint64(4, 44n, true);
  recordView.setBigUint64(24, BigInt(count), true);
  recordView.setBigUint64(32, BigInt(count), true);
  recordView.setBigUint64(40, BigInt(size), true);
  recordView.setBigUint64(48, BigInt(offset), true);
  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setBigUint64(8, BigInt(end), true);
  locatorView.setUint32(16, 1, true);
  const plain = zip.slice(end);
  const plainView = new DataView(plain.buffer);
  plainView.setUint16(8, 0xffff, true);
  plainView.setUint16(10, 0xffff, true);
  plainView.setUint32(12, 0xffffffff, true);
  plainView.setUint32(16, 0xffffffff, true);
  const whole = new Uint8Array(end + 56 + 20 + 22);
  whole.set(zip.subarray(0, end));
  whole.set(record, end);
  whole.set(locator, end + 56);
  whole.set(plain, end + 76);
  return whole;
}

async function readAll(zip: Uint8Array): Promise<Record<string, Uint8Array>> {
  const file = blobOf(zip);
  const read: Record<string, Uint8Array> = {};
  for (const entry of await readZipDirectory(file)) {
    read[entry.name] = await readZipEntry(file, entry);
  }
  return read;
}

describe("readZipDirectory and readZipEntry", () => {
  const files = { "a/one.bin": withSignatures(2000), "two.txt": strToU8("hello ".repeat(400)) };

  it("reads stored and deflated entries by the directory", async () => {
    for (const level of [0, 6] as const) {
      const read = await readAll(zipSync(files, { level }));
      expect(Object.keys(read)).toEqual(["a/one.bin", "two.txt"]);
      expect(Array.from(read["a/one.bin"])).toEqual(Array.from(files["a/one.bin"]));
      expect(new TextDecoder().decode(read["two.txt"])).toBe("hello ".repeat(400));
    }
  });

  // Finder's Compress and most folder downloads write zips this way. A reader
  // that splits entries from the front ends one at the signature inside it.
  it.each([
    ["stored", false],
    ["deflated", true],
  ])("reads a streamed %s zip whose data holds zip signatures", async (_kind, deflate) => {
    const zip = streamedZip(files, deflate);
    // The entry's header does carry the "sizes follow the data" flag.
    expect(new DataView(zip.buffer).getUint16(6, true) & 0x08).toBe(0x08);

    const read = await readAll(zip);

    expect(Array.from(read["a/one.bin"])).toEqual(Array.from(files["a/one.bin"]));
    expect(read["two.txt"]).toHaveLength(2400);
  });

  it("reads a zip64 directory", async () => {
    const read = await readAll(asZip64(zipSync(files, { level: 0 })));

    expect(Object.keys(read)).toEqual(["a/one.bin", "two.txt"]);
    expect(Array.from(read["a/one.bin"])).toEqual(Array.from(files["a/one.bin"]));
  });

  it("lists sizes without reading any entry", async () => {
    const entries = await readZipDirectory(blobOf(zipSync(files, { level: 6 })));

    expect(
      entries.map(({ name, size, method, encrypted }) => ({ name, size, method, encrypted })),
    ).toEqual([
      { name: "a/one.bin", size: 2000, method: 8, encrypted: false },
      { name: "two.txt", size: 2400, method: 8, encrypted: false },
    ]);
    expect(entries[1].compressedSize).toBeLessThan(100);
  });

  it("refuses a file that is not a zip, or one cut short", async () => {
    await expect(readZipDirectory(blobOf(strToU8("PK not a zip at all")))).rejects.toThrow(
      "it has no zip directory",
    );
    const zip = zipSync(files, { level: 0 });
    await expect(readZipDirectory(blobOf(zip.subarray(0, zip.length - 30)))).rejects.toThrow(
      "it has no zip directory",
    );
    await expect(readZipDirectory(blobOf(zip.subarray(60)))).rejects.toThrow(
      "its zip directory is damaged",
    );
  });

  it("refuses an entry whose bytes are not the ones the directory vouches for", async () => {
    const zip = zipSync(files, { level: 0 });
    const file = blobOf(zip);
    const [first] = await readZipDirectory(file);
    const damaged = zip.slice();
    damaged[first.headerOffset + 30 + first.name.length + 10] ^= 0xff;

    await expect(readZipEntry(blobOf(damaged), first)).rejects.toThrow(
      "its checksum does not match",
    );
    await expect(readZipEntry(file, { ...first, method: 14 })).rejects.toThrow(
      "its compression (method 14) is not supported",
    );
    await expect(readZipEntry(file, { ...first, encrypted: true })).rejects.toThrow(
      "it is encrypted",
    );
    await expect(readZipEntry(file, { ...first, headerOffset: 5 })).rejects.toThrow(
      "the zip is damaged where it starts",
    );
  });
});
