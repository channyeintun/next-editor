// `net.Socket`: a Duplex over one `ByteChannel` (process/runtime.ts). There is
// no real network: a connection to this machine goes through
// `runtime().net.connect`, and a server's accepted connection arrives as a
// channel. A socket paces itself on its channel (byteChannel.ts `paceOf`) as
// TCP paces a connection: what arrives is pushed into the stream at once, but
// counts as taken only while the stream wants more, and a write completes
// once the peer has room for it, so a reader that stops holds its writer back.
import { paceOf, type ChannelPace } from "../../../byteChannel";
import { Buffer } from "../buffer";
import {
  AbortError,
  invalidArgType,
  invalidArgValue,
  makeNodeError,
  outOfRange,
  validateNumber,
} from "../internalErrors";
import { Duplex } from "../stream";
import { runtime, type ByteChannel } from "../../runtime";
import { complete } from "../fs/completion";
import { nextTick, runMacrotask } from "../eventLoop";
import { toSystemErrorRecord } from "../../../errors";
import {
  connectCanceled,
  errnoException,
  exceptionWithHostPort,
  socketClosedError,
  startTimer,
  stopTimer,
  unsupported,
  writeAfterFinError,
  type TimerHandle,
} from "./errors";
import { getDefaultAutoSelectFamily } from "./autoSelectFamily";
import { isIP, isIPv4, isLocalHost, loopbackFor, validatePort } from "./ip";

/** `new net.Socket(options)`. */
export interface SocketOptions {
  allowHalfOpen?: boolean;
  readable?: boolean;
  writable?: boolean;
  signal?: AbortSignal;
  fd?: number;
  handle?: unknown;
  noDelay?: boolean;
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
  highWaterMark?: number;
  readableHighWaterMark?: number;
  writableHighWaterMark?: number;
  pauseOnCreate?: boolean;
  objectMode?: boolean;
  readableObjectMode?: boolean;
  writableObjectMode?: boolean;
  blockList?: unknown;
  [key: string]: unknown;
}

/** `socket.connect(options)`. */
export interface SocketConnectOptions {
  port?: number | string;
  host?: string;
  path?: string;
  family?: number;
  hints?: number;
  localAddress?: string;
  localPort?: number;
  lookup?: (
    hostname: string,
    options: { family?: number; hints?: number; all?: boolean },
    callback: (error: Error | null, address: string, family: number) => void,
  ) => void;
  timeout?: number;
  noDelay?: boolean;
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
  autoSelectFamily?: boolean;
  [key: string]: unknown;
}

/** Where a connected channel leads, as `remoteAddress` and friends report it. */
export interface PeerInfo {
  remoteAddress: string;
  remotePort: number;
  remoteFamily: "IPv4" | "IPv6";
  localAddress: string;
  localPort: number | undefined;
  localFamily: "IPv4" | "IPv6";
}

/** Attaches an accepted channel to a fresh socket; the net server's private entry point. */
export const kAttach = Symbol("kAttach");
/** Marks an argument list that `normalizeArgs` already normalised. */
export const kNormalizedArgs = Symbol("normalizedArgs");

type NormalizedArgs = [SocketConnectOptions, ((...args: unknown[]) => void) | null] & {
  [kNormalizedArgs]?: true;
};

function toNumber(value: unknown): number | false {
  const number = Number(value);
  return number >= 0 ? number : false;
}

/** Whether `value` is a pipe name rather than a port. */
export function isPipeName(value: unknown): value is string {
  return typeof value === "string" && toNumber(value) === false;
}

/** Node's `net._normalizeArgs`: `(port, host, cb)` / `(path, cb)` / `(options, cb)` → `[options, cb]`. */
export function normalizeArgs(args: readonly unknown[]): NormalizedArgs {
  let result: NormalizedArgs;
  if (args.length === 0) {
    result = [{}, null];
    result[kNormalizedArgs] = true;
    return result;
  }
  const first = args[0];
  let options: SocketConnectOptions = {};
  if (typeof first === "object" && first !== null) {
    options = first as SocketConnectOptions;
  } else if (isPipeName(first)) {
    options.path = first;
  } else {
    options.port = first as number;
    if (args.length > 1 && typeof args[1] === "string") {
      options.host = args[1];
    }
  }
  const cb = args[args.length - 1];
  result = [options, typeof cb === "function" ? (cb as (...a: unknown[]) => void) : null];
  result[kNormalizedArgs] = true;
  return result;
}

/** Node's `getTimerDuration`: a non-negative finite number of milliseconds. */
export function timerDuration(msecs: unknown, name: string): number {
  validateNumber(msecs, name);
  if (msecs < 0 || !Number.isFinite(msecs)) {
    throw outOfRange(name, "a non-negative finite number", msecs);
  }
  return Math.min(msecs, 2 ** 31 - 1);
}

function family(address: string): "IPv4" | "IPv6" {
  return isIPv4(address) ? "IPv4" : "IPv6";
}

type WriteChunk = { chunk: unknown; encoding: string };

/** A write partly sent: `bytes` from `sent` on wait for the peer to have room. */
interface WaitingWrite {
  bytes: Uint8Array;
  sent: number;
  callback: (error?: Error | null) => void;
}

function toBytes(chunks: readonly WriteChunk[]): Uint8Array {
  const parts = chunks.map(({ chunk, encoding }) =>
    typeof chunk === "string"
      ? Buffer.from(chunk, (encoding === "buffer" ? "utf8" : encoding) as BufferEncoding)
      : (chunk as Uint8Array),
  );
  if (parts.length === 1) {
    return parts[0];
  }
  return Buffer.concat(parts);
}

interface ServerLike {
  _connections: number;
  _emitCloseIfDrained(): void;
}

/** `net.Socket`. */
export class Socket extends Duplex {
  connecting = false;
  /** Set by `http` when an error was already reported for this socket. */
  _hadError = false;
  _host: string | null = null;
  /** The `net.Server` that accepted this socket. */
  server: unknown = null;
  _server: ServerLike | null = null;
  /** The milliseconds `setTimeout` set; undefined until then. */
  timeout: number | undefined = undefined;
  /** The HTTP message using this socket (`http` sets it). */
  _httpMessage: unknown = null;
  /** The HTTP parser reading this socket (`http` sets it). */
  parser: unknown = null;

  #channel: ByteChannel | null = null;
  /** The channel's flow control; undefined for a channel that has none (a test's). */
  #pace: ChannelPace | undefined = undefined;
  /** Bytes pushed into a stream that wanted no more: taken once it reads again. */
  #untaken = 0;
  /** The write that waits for the peer to have room. */
  #waitingWrite: WaitingWrite | null = null;
  /** The kernel's answer to the connect in flight. */
  #pendingConnect: Promise<ByteChannel> | null = null;
  /**
   * Where the connect in flight goes, when it started from a lookup of a
   * name on its own attempt (Node's autoSelectFamily): a second such connect
   * cancels it.
   */
  #pendingLookedUp: { address: string; port: number } | null = null;
  /** `connect()`'s `autoSelectFamily`: false makes a lookup's connect use the socket's one handle. */
  #ownAttempts = true;
  /**
   * The socket has what Node calls its handle: from `connect()` (or the
   * accepted connection) until it is destroyed.
   */
  #open = false;
  #peer: PeerInfo | null = null;
  #peerEnded = false;
  #channelClosed = false;
  #peerEndReceived = false;
  #reset = false;
  /** What `close` reports; undefined for a socket destroyed before it was ever opened, as in Node. */
  #hadError: boolean | undefined = undefined;
  #bytesRead = 0;
  #bytesDispatched = 0;
  #timer: TimerHandle | null = null;
  #refWanted = true;
  /** The runtime holding this object's ref, so it is released where it was taken. */
  #refHeld: { unref(): void } | null = null;
  #noDelay: boolean;
  #keepAlive: boolean;

  constructor(options?: SocketOptions | number) {
    if (typeof options === "number") {
      throw unsupported("net.Socket({ fd })", "there are no file descriptor sockets");
    }
    const opts: SocketOptions = { ...options };
    if (opts.objectMode) {
      throw invalidArgValue("options.objectMode", opts.objectMode, "is not supported");
    }
    if (opts.readableObjectMode || opts.writableObjectMode) {
      const name = opts.readableObjectMode ? "readableObjectMode" : "writableObjectMode";
      throw invalidArgValue(`options.${name}`, opts[name], "is not supported");
    }
    if (opts.fd !== undefined) {
      throw unsupported("net.Socket({ fd })", "there are no file descriptor sockets");
    }
    if (opts.handle !== undefined) {
      throw unsupported("net.Socket({ handle })", "there are no native socket handles");
    }
    const allowHalfOpen = Boolean(opts.allowHalfOpen);
    const { signal: _signal, ...streamOptions } = opts;
    super({
      ...streamOptions,
      allowHalfOpen,
      emitClose: true,
      autoDestroy: true,
      decodeStrings: false,
    });
    this.#noDelay = Boolean(opts.noDelay);
    this.#keepAlive = Boolean(opts.keepAlive);
    this.on("end", () => {
      this.#peerEnded = true;
    });
    if (opts.signal !== undefined) {
      const signal = opts.signal;
      const abort = () => this.destroy(abortError(signal));
      if (signal.aborted) {
        // As in Node, whose stream constructor destroys the stream at once:
        // 'error' and 'close' come in the next tick, ahead of anything the
        // caller queues. Node's socket constructor then makes the socket
        // ready again, so a connect() that follows still connects.
        abort();
        this.#revive();
      } else {
        signal.addEventListener("abort", abort, { once: true });
        this.once("close", () => signal.removeEventListener("abort", abort));
      }
    }
  }

  /** `close` carries `hadError`, as Node's socket does. */
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === "close" && args.length === 0) {
      return super.emit("close", this.#hadError);
    }
    return super.emit(event, ...args);
  }

  // --- connecting ---------------------------------------------------------

  /** `socket.connect(port[, host][, cb])` / `socket.connect(options[, cb])`. */
  connect(...args: unknown[]): this {
    const normalized: NormalizedArgs =
      Array.isArray(args[0]) && (args[0] as NormalizedArgs)[kNormalizedArgs]
        ? (args[0] as NormalizedArgs)
        : normalizeArgs(args);
    const [options, cb] = normalized;
    if (options.path !== undefined && options.path !== null) {
      throw unsupported(
        `net.Socket.connect({ path: ${JSON.stringify(options.path)} })`,
        "there are no Unix domain sockets or named pipes",
      );
    }
    if (this.destroyed) {
      this.#revive();
    }
    const host = options.host ?? "localhost";
    if (typeof host !== "string") {
      throw invalidArgType("options.host", "string", host);
    }
    let port = options.port;
    if (port !== undefined) {
      if (typeof port !== "number" && typeof port !== "string") {
        throw invalidArgType("options.port", ["number", "string"], port);
      }
      port = validatePort(port);
    }
    const portNumber = (port ?? 0) as number;
    if (cb !== null) {
      this.once("connect", cb);
    }
    if (typeof options.noDelay === "boolean") {
      this.#noDelay = options.noDelay;
    }
    if (typeof options.keepAlive === "boolean") {
      this.#keepAlive = options.keepAlive;
    }
    this.#ownAttempts =
      typeof options.autoSelectFamily === "boolean"
        ? options.autoSelectFamily
        : getDefaultAutoSelectFamily();
    this.connecting = true;
    this.#open = true;
    this._host = host;
    this.#updateRef();
    if (isIP(host) !== 0) {
      nextTick(() => this.#connectTo(host, portNumber));
      return this;
    }
    const lookup = options.lookup;
    if (typeof lookup === "function") {
      lookup(
        host,
        { family: options.family, hints: options.hints, all: false },
        (error, ip, fam) => {
          this.emit("lookup", error, ip, fam, host);
          if (!this.connecting) {
            return;
          }
          if (error) {
            this.#failConnect(error);
            return;
          }
          this.#connectTo(ip, portNumber, true);
        },
      );
      return this;
    }
    // Node looks the name up first; its answer comes from the event loop.
    complete(() => {
      if (!this.connecting) {
        return;
      }
      if (!isLocalHost(host)) {
        this.#connectTo(host, portNumber, true);
        return;
      }
      const resolved = loopbackFor(options.family === 6 ? "::1" : host);
      this.emit("lookup", null, resolved.address, resolved.family, host);
      if (this.connecting) {
        this.#connectTo(resolved.address, portNumber, true);
      }
    });
    return this;
  }

  /** Makes a destroyed socket ready for a connection again, as Node's `initSocketHandle` does. */
  #revive(): void {
    (this as unknown as { _undestroy(): void })._undestroy();
    this.#channel = null;
    this.#pace = undefined;
    this.#untaken = 0;
    this.#pendingConnect = null;
    this.#pendingLookedUp = null;
    this.#peer = null;
    this.#peerEnded = false;
    this.#channelClosed = false;
    this.#peerEndReceived = false;
    this.#reset = false;
  }

  /** `lookedUp`: the address came from a lookup of the name `connect()` was given. */
  #connectTo(address: string, port: number, lookedUp = false): void {
    if (!this.connecting || this.destroyed) {
      return;
    }
    const peer = this.#peer;
    const canceled = this.#pendingLookedUp;
    if (canceled !== null && lookedUp && this.#ownAttempts) {
      // As Node's: this attempt takes a handle of its own and closes the one
      // in flight, whose connect fails with ECANCELED and takes the socket.
      this.#failConnect(connectCanceled(canceled.address, canceled.port));
      return;
    }
    if (this.#pendingConnect !== null || peer !== null) {
      // A second connect() on a socket that is connecting or connected fails
      // here, where libuv refuses it in Node, and takes the socket with it.
      this.#failConnect(
        peer === null
          ? exceptionWithHostPort("EALREADY", "connect", address, port)
          : exceptionWithHostPort(
              "EISCONN",
              "connect",
              address,
              port,
              // This end's address, when it has a port, as Node appends it.
              peer.localPort === undefined
                ? undefined
                : `Local (${peer.localAddress}:${peer.localPort})`,
            ),
      );
      return;
    }
    if (!isLocalHost(address)) {
      this.#failConnect(
        exceptionWithHostPort(
          "ENETUNREACH",
          "connect",
          address,
          port,
          "raw TCP connections to hosts outside webnode are unavailable in webnode",
        ),
      );
      return;
    }
    const target = loopbackFor(address);
    let pending: Promise<ByteChannel>;
    try {
      pending = runtime().net.connect(port, target.address);
    } catch (error) {
      this.#failConnect(this.#connectError(error, target.address, port));
      return;
    }
    this.#pendingConnect = pending;
    this.#pendingLookedUp = lookedUp && this.#ownAttempts ? { address, port } : null;
    // The kernel's answer is a macrotask, as in Node: the ticks the 'connect'
    // listeners queue run before their promise jobs. An answer to a connect
    // the socket has given up (destroyed since, or connecting anew) is closed.
    pending.then(
      (channel) =>
        runMacrotask(() => {
          if (this.#pendingConnect !== pending) {
            channel.destroy();
            return;
          }
          this.#pendingConnect = null;
          this.#pendingLookedUp = null;
          this.connecting = false;
          this[kAttach](channel, {
            remoteAddress: target.address,
            remotePort: port,
            remoteFamily: family(target.address),
            localAddress: target.family === 6 ? "::1" : "127.0.0.1",
            // The kernel's label for this end (sysClient puts it on the channel).
            localPort: channel.localPort,
            localFamily: target.family === 6 ? "IPv6" : "IPv4",
          });
          this.emit("connect");
          this.emit("ready");
        }),
      (error: unknown) =>
        runMacrotask(() => {
          if (this.#pendingConnect !== pending) {
            return;
          }
          this.#pendingConnect = null;
          this.#pendingLookedUp = null;
          this.#failConnect(this.#connectError(error, target.address, port));
        }),
    );
  }

  #connectError(error: unknown, address: string, port: number): Error {
    const record = toSystemErrorRecord(error);
    if (record === null) {
      return error instanceof Error ? error : new Error(String(error));
    }
    return exceptionWithHostPort(record.code, "connect", address, port);
  }

  #failConnect(error: Error): void {
    this.connecting = false;
    this.destroy(error);
  }

  /** Takes over `channel` as this socket's connection. */
  [kAttach](channel: ByteChannel, peer: PeerInfo): void {
    this.#channel = channel;
    this.#pace = paceOf(channel);
    this.#open = true;
    this.#peer = peer;
    this.#updateRef();
    channel.onData = (chunk) => {
      if (this.destroyed) {
        return;
      }
      this.#bytesRead += chunk.length;
      this._unrefTimer();
      if (this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
        this.#pace?.taken(chunk.length);
      } else {
        // The stream is full: as a socket that stopped reading, it takes no
        // more until `_read` asks, and the peer's writes wait meanwhile.
        this.#untaken += chunk.length;
      }
    };
    channel.onEnd = () => {
      this.#peerEndReceived = true;
      if (!this.destroyed) {
        this.push(null);
        // As Node's onStreamRead: a stream nobody reads (an upgraded socket
        // before its handler attaches a reader) still emits `end`.
        this.read(0);
      }
    };
    channel.onClose = () => {
      this.#channelClosed = true;
      if (this.destroyed) {
        return;
      }
      if (!this.#peerEndReceived) {
        // The peer went away without ending its side: a reset, as TCP reports it.
        this.destroy(errnoException("ECONNRESET", "read"));
        return;
      }
      // Nobody is left to make room: a write that waited goes nowhere.
      this.#sendWaiting();
    };
  }

  // --- stream implementation ----------------------------------------------

  /** The stream wants more: what was pushed past its high water mark is taken now. */
  override _read(): void {
    if (this.#untaken > 0) {
      const bytes = this.#untaken;
      this.#untaken = 0;
      this.#pace?.taken(bytes);
    }
  }

  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#writeGeneric([{ chunk, encoding }], callback);
  }

  override _writev(
    chunks: Array<{ chunk: unknown; encoding: BufferEncoding }>,
    callback: (error?: Error | null) => void,
  ): void {
    this.#writeGeneric(chunks, callback);
  }

  #writeGeneric(chunks: readonly WriteChunk[], callback: (error?: Error | null) => void): void {
    if (this.connecting) {
      const onClose = () => callback(makeClosedBeforeConnection());
      this.once("connect", () => {
        this.off("close", onClose);
        this.#writeGeneric(chunks, callback);
      });
      this.once("close", onClose);
      return;
    }
    const channel = this.#channel;
    if (channel === null) {
      callback(socketClosedError());
      return;
    }
    const bytes = toBytes(chunks);
    this.#bytesDispatched += bytes.length;
    this._unrefTimer();
    this.#waitingWrite = { bytes, sent: 0, callback };
    this.#sendWaiting();
  }

  /**
   * Hands the waiting write to the channel, as much as the peer has room for,
   * and completes it once all of it is there. With room for all of it that is
   * at once, as Node's synchronous try_write path: a later write in the same
   * tick reaches the channel too, instead of waiting in the stream's buffer
   * where destroy() would drop it. A closed channel takes the rest nowhere.
   */
  #sendWaiting(): void {
    const write = this.#waitingWrite;
    const channel = this.#channel;
    if (write === null || channel === null) {
      return;
    }
    const pace = this.#pace;
    while (write.sent < write.bytes.length && !this.#channelClosed) {
      const room = pace === undefined ? write.bytes.length : pace.room;
      if (pace !== undefined && room === 0) {
        pace.onRoom = () => this.#sendWaiting();
        return;
      }
      const end = Math.min(write.bytes.length, write.sent + room);
      try {
        channel.write(write.bytes.subarray(write.sent, end));
      } catch {
        // The peer is already gone; its close follows and ends this socket.
      }
      write.sent = end;
    }
    this.#waitingWrite = null;
    write.callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.connecting) {
      this.once("connect", () => this._final(callback));
      return;
    }
    if (this.#channel !== null && !this.#channelClosed) {
      this.#channel.end();
    }
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.connecting = false;
    this.#pendingConnect = null;
    this.#pendingLookedUp = null;
    stopTimer(this.#timer);
    this.#timer = null;
    const channel = this.#channel;
    if (channel !== null) {
      this.#channel = null;
      channel.onData = null;
      channel.onEnd = null;
      channel.onClose = null;
      if (this.#pace !== undefined) {
        this.#pace.onRoom = null;
      }
      if (!this.#channelClosed) {
        this.#channelClosed = true;
        // Closing a TCP socket sends FIN first; only a reset skips it.
        if (!this.#reset) {
          channel.end();
        }
        channel.destroy();
      }
    }
    const waiting = this.#waitingWrite;
    if (waiting !== null) {
      // As Node's closing handle cancels the write it had not finished: its
      // callback, and those of the writes queued behind it, get ECANCELED
      // before 'close'.
      this.#waitingWrite = null;
      nextTick(waiting.callback, errnoException("ECANCELED", "write"));
    }
    this.#hadError = this.#open ? Boolean(error) : undefined;
    this.#open = false;
    this.#updateRef();
    callback(error);
    const server = this._server;
    if (server !== null) {
      this._server = null;
      server._connections--;
      server._emitCloseIfDrained();
    }
  }

  /** Writes after the peer ended fail with `EPIPE` unless `allowHalfOpen`. */
  override write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
    if (this.#peerEnded && !this.allowHalfOpen && this.writableEnded) {
      const cb = typeof encoding === "function" ? encoding : callback;
      const error = writeAfterFinError();
      if (typeof cb === "function") {
        nextTick(() => (cb as (e: Error) => void)(error));
      }
      this.destroy(error);
      return false;
    }
    return (super.write as (c: unknown, e?: unknown, cb?: unknown) => boolean)(
      chunk,
      encoding,
      callback,
    );
  }

  override end(...args: unknown[]): this {
    (super.end as (...a: unknown[]) => unknown)(...args);
    return this;
  }

  // --- timeouts, options, refs ---------------------------------------------

  /** Restarts the idle timer; activity calls it. */
  _unrefTimer(): void {
    if (this.timeout === undefined || this.timeout === 0 || this.destroyed) {
      return;
    }
    stopTimer(this.#timer);
    this.#timer = startTimer(() => {
      this.#timer = null;
      if (!this.destroyed) {
        this.emit("timeout");
      }
    }, this.timeout);
  }

  /** `socket.setTimeout(msecs[, callback])`: emits `timeout` after `msecs` idle. */
  setTimeout(msecs: number, callback?: () => void): this {
    const duration = timerDuration(msecs, "msecs");
    this.timeout = duration;
    stopTimer(this.#timer);
    this.#timer = null;
    if (duration === 0) {
      if (callback !== undefined) {
        this.removeListener("timeout", callback);
      }
      return this;
    }
    this._unrefTimer();
    if (callback !== undefined) {
      if (typeof callback !== "function") {
        throw invalidArgType("callback", "Function", callback);
      }
      this.once("timeout", callback);
    }
    return this;
  }

  /** Recorded; a channel has no Nagle algorithm to switch off. */
  setNoDelay(enable?: boolean): this {
    this.#noDelay = enable === undefined ? true : Boolean(enable);
    return this;
  }

  /** Recorded; a channel needs no keep-alive probes. */
  setKeepAlive(enable?: boolean, _initialDelay?: number): this {
    this.#keepAlive = Boolean(enable);
    return this;
  }

  /** Lets the process exit while this socket is open. */
  unref(): this {
    this.#refWanted = false;
    this.#updateRef();
    return this;
  }

  /** Undoes `unref()`. */
  ref(): this {
    this.#refWanted = true;
    this.#updateRef();
    return this;
  }

  #updateRef(): void {
    const want = this.#refWanted && !this.destroyed && (this.connecting || this.#channel !== null);
    if (want && this.#refHeld === null) {
      const current = runtime();
      current.ref();
      this.#refHeld = current;
    } else if (!want && this.#refHeld !== null) {
      const held = this.#refHeld;
      this.#refHeld = null;
      held.unref();
    }
  }

  /** Ends the writable side, then destroys once it has flushed. */
  destroySoon(): void {
    if (this.writable) {
      this.end();
    }
    if (this.writableFinished) {
      this.destroy();
    } else {
      this.once("finish", () => this.destroy());
    }
  }

  /** Closes without FIN: the peer sees `ECONNRESET`. */
  resetAndDestroy(): this {
    if (this.#channel === null && !this.connecting) {
      this.destroy(socketClosedError());
      return this;
    }
    if (this.connecting) {
      this.once("connect", () => {
        this.#reset = true;
        this.destroy();
      });
      return this;
    }
    this.#reset = true;
    this.destroy();
    return this;
  }

  /** `{ address, family, port }` of this end, or `{}` before connecting. */
  address(): { address: string; family: string; port: number | undefined } | Record<string, never> {
    const peer = this.#peer;
    if (peer === null) {
      return {};
    }
    return { address: peer.localAddress, family: peer.localFamily, port: peer.localPort };
  }

  // --- properties ------------------------------------------------------------

  get _connecting(): boolean {
    return this.connecting;
  }

  get pending(): boolean {
    return this.#channel === null || this.connecting;
  }

  get readyState(): "opening" | "open" | "readOnly" | "writeOnly" | "closed" {
    if (this.connecting) {
      return "opening";
    }
    if (this.readable && this.writable) {
      return "open";
    }
    if (this.readable && !this.writable) {
      return "readOnly";
    }
    if (!this.readable && this.writable) {
      return "writeOnly";
    }
    return "closed";
  }

  get bufferSize(): number | undefined {
    return this.#channel !== null ? this.writableLength : undefined;
  }

  get bytesRead(): number {
    return this.#bytesRead;
  }

  get bytesWritten(): number {
    let bytes = this.#bytesDispatched;
    const buffered = (this as unknown as { writableBuffer?: WriteChunk[] }).writableBuffer ?? [];
    for (const entry of buffered) {
      bytes +=
        typeof entry.chunk === "string"
          ? Buffer.byteLength(entry.chunk, entry.encoding as BufferEncoding)
          : (entry.chunk as Uint8Array).length;
    }
    return bytes;
  }

  get remoteAddress(): string | undefined {
    return this.#peer?.remoteAddress;
  }

  get remotePort(): number | undefined {
    return this.#peer?.remotePort;
  }

  get remoteFamily(): string | undefined {
    return this.#peer?.remoteFamily;
  }

  get localAddress(): string | undefined {
    return this.#peer?.localAddress;
  }

  get localPort(): number | undefined {
    return this.#peer?.localPort;
  }

  get localFamily(): string | undefined {
    return this.#peer?.localFamily;
  }

  /** Whether `setNoDelay` asked for no delay. */
  get noDelay(): boolean {
    return this.#noDelay;
  }

  /** Whether `setKeepAlive` asked for keep-alive. */
  get keepAlive(): boolean {
    return this.#keepAlive;
  }
}

function makeClosedBeforeConnection(): Error {
  return makeNodeError(
    "ERR_SOCKET_CLOSED_BEFORE_CONNECTION",
    "Socket closed before the connection was established",
    Error,
  );
}

function abortError(signal: AbortSignal): Error {
  return new AbortError(undefined, { cause: signal.reason });
}
