import type {
  BufferEncoding,
  DirEnt,
  FileSystemAPI,
  FSWatchCallback,
  FSWatchOptions,
  IFSWatcher,
} from "@webcontainer/api";
import type { FileKind } from "../rcp/types";
import { RcpConnection } from "./connection";

export interface RemoteDirEnt<T extends string | Uint8Array = string> {
  name: T;
  isFile(): boolean;
  isDirectory(): boolean;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); length += value.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function decode(bytes: Uint8Array, encoding: BufferEncoding): string {
  switch (encoding) {
    case "utf8":
    case "utf-8":
      return new TextDecoder("utf-8").decode(bytes);
    case "utf16le":
    case "ucs2":
    case "ucs-2":
      return new TextDecoder("utf-16le").decode(bytes);
    case "latin1":
    case "binary":
      return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    case "ascii":
      return Array.from(bytes, (byte) => String.fromCharCode(byte & 0x7f)).join("");
    case "hex":
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    case "base64":
    case "base64url": { // btoa avoids a Node-only Buffer dependency in the browser SDK.
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const encoded = btoa(binary);
      return encoding === "base64url"
        ? encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
        : encoded;
    }
  }
}

function encode(value: string, encoding: string | null | undefined): Uint8Array {
  switch ((encoding ?? "utf8").toLowerCase()) {
    case "utf8":
    case "utf-8":
      return new TextEncoder().encode(value);
    case "utf16le":
    case "ucs2":
    case "ucs-2": {
      const bytes = new Uint8Array(value.length * 2);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < value.length; index += 1) {
        view.setUint16(index * 2, value.charCodeAt(index), true);
      }
      return bytes;
    }
    case "latin1":
    case "binary":
      return Uint8Array.from(value, (character) => character.charCodeAt(0) & 0xff);
    case "ascii":
      return Uint8Array.from(value, (character) => character.charCodeAt(0) & 0x7f);
    case "hex": {
      const pairs = value.match(/[0-9a-f]{2}/gi) ?? [];
      return Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16));
    }
    case "base64":
    case "base64url": {
      const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
      const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    }
    default:
      throw new TypeError(`Unsupported encoding: ${encoding}`);
  }
}

export class RemoteFs implements FileSystemAPI {
  private nextWatchId = 1;
  private readonly watches = new Map<number, { path: string; recursive: boolean }>();

  constructor(private readonly connection: RcpConnection) {
    connection.onReconnect(async () => {
      for (const [watchId, watch] of this.watches) {
        await connection.request("fs.watch", { watchId, ...watch });
      }
    });
  }

  readFile(path: string, encoding?: null): Promise<Uint8Array>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  async readFile(path: string, encoding?: BufferEncoding | null): Promise<string | Uint8Array> {
    const { ch } = await this.connection.request("fs.readFile", { path });
    const bytes = await collect(this.connection.channels.readable(ch));
    if (!encoding) return bytes;
    return decode(bytes, encoding);
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    _options?: string | { encoding?: string | null } | null,
  ): Promise<void> {
    const ch = this.connection.channels.allocate();
    const { response } = this.connection.beginRequest("fs.writeFile", { path, ch });
    const writer = this.connection.channels.writable(ch).getWriter();
    const encoding = typeof _options === "string" ? _options : _options?.encoding;
    await writer.write(typeof data === "string" ? encode(data, encoding) : data);
    await writer.close();
    await response;
  }

  mkdir(path: string, options?: { recursive?: false }): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<string>;
  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<string | void> {
    const result = await this.connection.request("fs.mkdir", { path, recursive: options.recursive ?? false });
    return options.recursive ? result.created ?? path : undefined;
  }

  async readdir(
    path: string,
    options: "buffer" | { encoding: "buffer"; withFileTypes?: false },
  ): Promise<Uint8Array[]>;
  async readdir(
    path: string,
    options?: { encoding?: BufferEncoding | null; withFileTypes?: false } | BufferEncoding | null,
  ): Promise<string[]>;
  async readdir(
    path: string,
    options: { encoding: "buffer"; withFileTypes: true },
  ): Promise<DirEnt<Uint8Array>[]>;
  async readdir(
    path: string,
    options: { encoding?: BufferEncoding | null; withFileTypes: true },
  ): Promise<DirEnt<string>[]>;
  async readdir(
    path: string,
    options?: { encoding?: BufferEncoding | "buffer" | null; withFileTypes?: boolean }
      | BufferEncoding | "buffer" | null,
  ): Promise<string[] | Uint8Array[] | RemoteDirEnt<string>[] | RemoteDirEnt<Uint8Array>[]> {
    const withFileTypes = typeof options === "object" && options?.withFileTypes === true;
    const bufferNames = options === "buffer"
      || (typeof options === "object" && options?.encoding === "buffer");
    const { entries } = await this.connection.request("fs.readdir", { path, withFileTypes });
    if (!withFileTypes) {
      return entries.map(({ name }) => bufferNames ? new TextEncoder().encode(name) : name) as string[] | Uint8Array[];
    }
    return entries.map(({ name, kind }) => this.dirEnt(
      bufferNames ? new TextEncoder().encode(name) : name,
      kind,
    )) as RemoteDirEnt<string>[] | RemoteDirEnt<Uint8Array>[];
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    await this.connection.request("fs.rm", {
      path,
      recursive: options.recursive ?? false,
      force: options.force ?? false,
    });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.connection.request("fs.rename", { from, to });
  }

  watch(path: string, options?: FSWatchOptions, listener?: FSWatchCallback): IFSWatcher;
  watch(path: string, listener?: FSWatchCallback): IFSWatcher;
  watch(
    path: string,
    options: FSWatchOptions | FSWatchCallback = {},
    callback?: FSWatchCallback,
  ): IFSWatcher {
    const listener = typeof options === "function" ? options : callback;
    const recursive = typeof options === "object" && options !== null
      ? options.recursive ?? false
      : false;
    const watchId = this.nextWatchId++;
    this.watches.set(watchId, { path, recursive });
    let closed = false;
    const unsubscribe = this.connection.on("fs.watch", (event) => {
      if (event.watchId === watchId) listener?.(event.event, event.filename);
    });
    void this.connection.request("fs.watch", { watchId, path, recursive }).catch(() => close());
    const close = () => {
      if (closed) return;
      closed = true; this.watches.delete(watchId); unsubscribe();
      void this.connection.request("fs.unwatch", { watchId }).catch(() => {});
    };
    return { close };
  }

  private dirEnt<T extends string | Uint8Array>(name: T, kind: FileKind): RemoteDirEnt<T> {
    return { name, isFile: () => kind === "file", isDirectory: () => kind === "dir" };
  }
}
