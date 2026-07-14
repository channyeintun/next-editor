import type { FileKind } from "../rcp/types";
import { RcpConnection } from "./connection";

export interface RemoteDirEnt<T extends string | Uint8Array = string> {
  name: T;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface WatchOptions { recursive?: boolean }
export type WatchCallback = (event: "rename" | "change", filename: string) => void;

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

export class RemoteFs {
  private nextWatchId = 1;

  constructor(private readonly connection: RcpConnection) {}

  async readFile(path: string, encoding?: string | null): Promise<string | Uint8Array> {
    const { ch } = await this.connection.request("fs.readFile", { path });
    const bytes = await collect(this.connection.channels.readable(ch));
    if (!encoding) return bytes;
    return new TextDecoder(encoding === "utf-8" ? "utf-8" : encoding).decode(bytes);
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    _options?: string | { encoding?: string | null } | null,
  ): Promise<void> {
    const ch = this.connection.channels.allocate();
    const { response } = this.connection.beginRequest("fs.writeFile", { path, ch });
    const writer = this.connection.channels.writable(ch).getWriter();
    await writer.write(typeof data === "string" ? new TextEncoder().encode(data) : data);
    await writer.close();
    await response;
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<string | undefined> {
    const result = await this.connection.request("fs.mkdir", { path, recursive: options.recursive ?? false });
    return result.created;
  }

  async readdir(
    path: string,
    options?: { withFileTypes?: false } | string | null,
  ): Promise<string[]>;
  async readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<RemoteDirEnt<string>[]>;
  async readdir(
    path: string,
    options?: { withFileTypes?: boolean } | string | null,
  ): Promise<string[] | RemoteDirEnt<string>[]> {
    const withFileTypes = typeof options === "object" && options?.withFileTypes === true;
    const { entries } = await this.connection.request("fs.readdir", { path, withFileTypes });
    if (!withFileTypes) return entries.map(({ name }) => name);
    return entries.map(({ name, kind }) => this.dirEnt(name, kind));
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

  watch(path: string, options: WatchOptions | WatchCallback = {}, callback?: WatchCallback): { close(): void } {
    const listener = typeof options === "function" ? options : callback;
    const recursive = typeof options === "object" ? options.recursive ?? false : false;
    const watchId = this.nextWatchId++;
    let closed = false;
    const unsubscribe = this.connection.on("fs.watch", (event) => {
      if (event.watchId === watchId) listener?.(event.event, event.filename);
    });
    void this.connection.request("fs.watch", { watchId, path, recursive }).catch(() => close());
    const close = () => {
      if (closed) return;
      closed = true; unsubscribe();
      void this.connection.request("fs.unwatch", { watchId }).catch(() => {});
    };
    return { close };
  }

  private dirEnt(name: string, kind: FileKind): RemoteDirEnt<string> {
    return { name, isFile: () => kind === "file", isDirectory: () => kind === "dir" };
  }
}
