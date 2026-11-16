// Package tarballs: gunzip (DecompressionStream, else fflate) and a tar reader
// for what npm packs — ustar with its prefix field, pax extended headers (`x`;
// global `g` records are read past) and GNU long names (`L`). Regular files and directories are
// returned; links and devices are skipped. The leading `package/` component is
// stripped and a path that climbs out with `..` is refused.
import { gunzipSync } from "fflate";
import { PmError } from "./errors";

/** A file or directory in a package tarball. */
export interface TarEntry {
  /** Path inside the package, with the first component stripped (`lib/index.js`). */
  path: string;
  type: "file" | "directory";
  /** Permission bits from the header. */
  mode: number;
  /** The file's bytes, a view into the tar buffer (empty for a directory). */
  data: Uint8Array;
}

const BLOCK = 512;
const decoder = new TextDecoder();

/** Decompresses gzip `bytes`. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const Stream = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (Stream) {
    const body = new Blob([bytes as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new Stream("gzip"));
    return new Uint8Array(await new Response(body).arrayBuffer());
  }
  return gunzipSync(bytes);
}

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) {
    end++;
  }
  return decoder.decode(block.subarray(offset, end));
}

function readNumber(block: Uint8Array, offset: number, length: number): number {
  if (block[offset] & 0x80) {
    // GNU base-256: a big-endian number after the marker bit.
    let value = block[offset] & 0x7f;
    for (let i = 1; i < length; i++) {
      value = value * 256 + block[offset + i];
    }
    return value;
  }
  const text = readString(block, offset, length).trim();
  return text === "" ? 0 : parseInt(text, 8);
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < BLOCK; i++) {
    if (block[i] !== 0) {
      return false;
    }
  }
  return true;
}

/** Parses pax `"<len> key=value\n"` records. */
function parsePax(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    let space = offset;
    while (space < data.length && data[space] !== 0x20) {
      space++;
    }
    const length = parseInt(decoder.decode(data.subarray(offset, space)), 10);
    if (!Number.isFinite(length) || length <= 0) {
      break;
    }
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) {
      records[record.slice(0, equals)] = record.slice(equals + 1);
    }
    offset += length;
  }
  return records;
}

/**
 * The package-relative path for a tar path: first component stripped, `.`
 * and empty parts dropped. Null for the package directory itself. Throws when
 * the path escapes the package.
 */
export function stripPath(raw: string): string | null {
  const parts = raw.replace(/\\/g, "/").split("/").slice(1);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length === 0) {
        throw new PmError("ETAR", `Refusing tar entry that escapes the package: ${raw}`);
      }
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length === 0 ? null : out.join("/");
}

/** Reads every file and directory of an uncompressed tar archive. */
export function parseTar(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let pax: Record<string, string> | null = null;
  let longName: string | null = null;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) {
      break;
    }
    const type = String.fromCharCode(header[156] || 0x30);
    const headerSize = readNumber(header, 124, 12);
    // A pax `size` describes the next real entry, never another extension header.
    const extension = type === "x" || type === "g" || type === "L" || type === "K";
    const size = !extension && pax?.size !== undefined ? Number(pax.size) : headerSize;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new PmError("ETAR", "Invalid tar entry size");
    }
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length) {
      throw new PmError("ETAR", "Truncated tar archive");
    }
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "g") {
      // Global records hold archive-wide defaults (mtime, charset); none of
      // them names an entry's path or size, so there is nothing to keep.
      continue;
    }
    if (type === "L") {
      longName = readString(data, 0, data.length);
      continue;
    }
    if (type === "K") {
      continue;
    }

    let name: string;
    if (pax?.path !== undefined) {
      name = pax.path;
    } else if (longName !== null) {
      name = longName;
    } else {
      const base = readString(header, 0, 100);
      const magic = readString(header, 257, 6);
      const prefix = magic.startsWith("ustar") ? readString(header, 345, 155) : "";
      name = prefix ? `${prefix}/${base}` : base;
    }
    pax = null;
    longName = null;

    const mode = readNumber(header, 100, 8) & 0o7777;
    let kind: TarEntry["type"] | null = null;
    if (type === "0" || type === "\0" || type === "7") {
      kind = name.endsWith("/") ? "directory" : "file";
    } else if (type === "5") {
      kind = "directory";
    }
    if (kind === null) {
      continue;
    }
    const path = stripPath(name);
    if (path === null) {
      continue;
    }
    entries.push({ path, type: kind, mode, data: kind === "file" ? data : new Uint8Array(0) });
  }
  return entries;
}
