// `net.Server`: listens through `runtime().net.listen` (the kernel's port
// table) and wraps each arriving channel in a `Socket`. A listening server
// holds one `runtime().ref()` until it closes or is unref'd.
import { toSystemErrorRecord } from "../../../errors";
import EventEmitter from "../events";
import {
  invalidArgType,
  invalidArgValue,
  makeNodeError,
  validateAbortSignal,
  validateNumber,
} from "../internalErrors";
import { runtime, type ByteChannel } from "../../runtime";
import { complete } from "../fs/completion";
import { nextTick } from "../eventLoop";
import {
  startTimer,
  stopTimer,
  unsupported,
  uvExceptionWithHostPort,
  type TimerHandle,
} from "./errors";
import { isIP, isIPv4, isIPv6, isLocalHost, validatePort } from "./ip";
import { isPipeName, kAttach, normalizeArgs, Socket, type SocketConnectOptions } from "./socket";

/**
 * How long a connection the server drops is held open for the bytes its
 * client writes as it learns of its connection. Node closes the accepted
 * handle at once, but the client's connect and first write have often
 * already happened by then; here they come a task or so after the
 * connection arrives (about 1 ms from another process).
 */
const DROP_GRACE_MS = 20;

/**
 * Closes a connection the server does not take, as Node closes the accepted
 * handle. Closing a socket whose bytes nobody read sends a reset, on Linux
 * and macOS alike: a client that already sent data reads ECONNRESET, one that
 * sent nothing reads a clean end.
 */
function dropConnection(channel: ByteChannel): void {
  let timer: TimerHandle | null = null;
  const close = (reset: boolean) => {
    stopTimer(timer);
    channel.onData = null;
    channel.onEnd = null;
    if (!reset) {
      channel.end();
    }
    channel.destroy();
  };
  channel.onData = () => close(true);
  channel.onEnd = () => close(false);
  timer = startTimer(() => close(false), DROP_GRACE_MS);
}

/** `net.createServer(options)`. */
export interface ServerOptions {
  allowHalfOpen?: boolean;
  pauseOnConnect?: boolean;
  noDelay?: boolean;
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
  highWaterMark?: number;
  blockList?: unknown;
}

/** `server.listen(options)`. */
export interface ListenOptions {
  port?: number | string | null;
  host?: string;
  path?: string;
  backlog?: number;
  exclusive?: boolean;
  ipv6Only?: boolean;
  reusePort?: boolean;
  signal?: AbortSignal;
  readableAll?: boolean;
  writableAll?: boolean;
  fd?: number;
  handle?: unknown;
  _handle?: unknown;
}

/** What `server.address()` reports. */
export interface AddressInfo {
  address: string;
  family: "IPv4" | "IPv6";
  port: number;
}

const asyncDispose: symbol =
  (Symbol as unknown as { asyncDispose?: symbol }).asyncDispose ??
  Symbol.for("nodejs.asyncDispose");

function alreadyListening(): Error {
  return makeNodeError(
    "ERR_SERVER_ALREADY_LISTEN",
    "Listen method has been called more than once without closing.",
    Error,
  );
}

function notRunning(): Error {
  return makeNodeError("ERR_SERVER_NOT_RUNNING", "Server is not running.", Error);
}

function notFound(hostname: string): Error {
  const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as Error & Record<string, unknown>;
  error.code = "ENOTFOUND";
  error.errno = -3008;
  error.syscall = "getaddrinfo";
  error.hostname = hostname;
  return error;
}

/** `net.Server`. */
export class Server extends EventEmitter {
  _connections = 0;
  allowHalfOpen: boolean;
  pauseOnConnect: boolean;
  noDelay: boolean;
  keepAlive: boolean;
  keepAliveInitialDelay: number;
  highWaterMark: number | undefined;
  /** Connections beyond this are dropped. */
  maxConnections: number | undefined = undefined;
  blockList: unknown;

  #handle: { port: number; close(): void } | null = null;
  #address: AddressInfo | null = null;
  #listeningId = 1;
  #refWanted = true;
  /** The runtime holding this object's ref, so it is released where it was taken. */
  #refHeld: { unref(): void } | null = null;

  constructor(
    options?: ServerOptions | ((socket: Socket) => void) | null,
    connectionListener?: (socket: Socket) => void,
  ) {
    super();
    let opts: ServerOptions;
    if (typeof options === "function") {
      opts = {};
      this.on("connection", options);
    } else if (options === null || options === undefined || typeof options === "object") {
      opts = { ...options };
      if (typeof connectionListener === "function") {
        this.on("connection", connectionListener);
      }
    } else {
      throw invalidArgType("options", "Object", options);
    }
    if (opts.keepAliveInitialDelay !== undefined) {
      validateNumber(opts.keepAliveInitialDelay, "options.keepAliveInitialDelay");
    }
    if (opts.highWaterMark !== undefined) {
      validateNumber(opts.highWaterMark, "options.highWaterMark");
    }
    this.allowHalfOpen = opts.allowHalfOpen || false;
    this.pauseOnConnect = Boolean(opts.pauseOnConnect);
    this.noDelay = Boolean(opts.noDelay);
    this.keepAlive = Boolean(opts.keepAlive);
    this.keepAliveInitialDelay = ~~((opts.keepAliveInitialDelay ?? 0) / 1000);
    this.highWaterMark =
      opts.highWaterMark !== undefined && opts.highWaterMark >= 0 ? opts.highWaterMark : undefined;
    this.blockList = opts.blockList;
  }

  /** The listening handle, as code that peeks at `server._handle` expects; null when not listening. */
  get _handle(): { port: number; close(): void } | null {
    return this.#handle;
  }

  get listening(): boolean {
    return this.#handle !== null;
  }

  /**
   * `listen(port[, host][, backlog][, cb])`, `listen(options[, cb])`,
   * `listen(cb)`. Port 0 (or none) takes an ephemeral port. A host name is
   * resolved first, so `listening` follows asynchronously, as in Node.
   */
  listen(...args: unknown[]): this {
    const [normalized, cb] = normalizeArgs(args);
    if (this.#handle !== null) {
      throw alreadyListening();
    }
    if (cb !== null) {
      this.once("listening", cb);
    }
    const options = normalized as ListenOptions & SocketConnectOptions;
    if (options._handle !== undefined || options.handle !== undefined) {
      throw unsupported("net.Server.listen(handle)", "there are no native socket handles");
    }
    if (typeof options.fd === "number" && options.fd >= 0) {
      throw unsupported("net.Server.listen({ fd })", "there are no file descriptor sockets");
    }
    this.#addAbortSignal(options.signal);
    this.#listeningId++;
    if (
      args.length === 0 ||
      typeof args[0] === "function" ||
      (options.port === undefined && "port" in options) ||
      options.port === null
    ) {
      options.port = 0;
    }
    if (typeof options.port === "number" || typeof options.port === "string") {
      const port = validatePort(options.port, "options.port");
      if (options.host) {
        this.#lookupAndListen(port, options.host);
      } else {
        this.#setup(null, port);
      }
      return this;
    }
    if (options.path && isPipeName(options.path)) {
      throw unsupported(
        `net.Server.listen({ path: ${JSON.stringify(options.path)} })`,
        "there are no Unix domain sockets or named pipes",
      );
    }
    if (!("port" in options || "path" in options)) {
      throw invalidArgValue("options", options, 'must have the property "port" or "path"');
    }
    throw invalidArgValue("options", options);
  }

  #addAbortSignal(signal: unknown): void {
    if (signal === undefined) {
      return;
    }
    validateAbortSignal(signal, "options.signal");
    const abortSignal = signal as AbortSignal;
    const onAborted = () => {
      this.close();
    };
    if (abortSignal.aborted) {
      nextTick(onAborted);
    } else {
      abortSignal.addEventListener("abort", onAborted, { once: true });
      this.once("close", () => abortSignal.removeEventListener("abort", onAborted));
    }
  }

  #lookupAndListen(port: number, host: string): void {
    const listeningId = this.#listeningId;
    // Node looks the host up first. An address is answered from a tick, so the
    // server has its handle (and its address) before any promise job runs; a
    // name's answer comes from the event loop.
    if (isIP(host) !== 0) {
      nextTick(() => {
        if (listeningId === this.#listeningId) {
          this.#setup(host, port);
        }
      });
      return;
    }
    complete(() => {
      if (listeningId !== this.#listeningId) {
        return;
      }
      if (isLocalHost(host)) {
        this.#setup("127.0.0.1", port);
      } else {
        this.emit("error", notFound(host));
      }
    });
  }

  #setup(address: string | null, port: number): void {
    const host = address ?? "::";
    let handle: { port: number; close(): void };
    try {
      handle = runtime().net.listen(port, host, (channel, remote) =>
        this.#onConnection(channel, remote),
      );
    } catch (error) {
      const record = toSystemErrorRecord(error);
      const failure =
        record === null ? error : uvExceptionWithHostPort(record.code, "listen", host, port);
      nextTick(() => this.emit("error", failure));
      return;
    }
    this.#handle = handle;
    this.#address = {
      address: host,
      family: isIPv4(host) ? "IPv4" : "IPv6",
      port: handle.port,
    };
    this.#updateRef();
    nextTick(() => {
      if (this.#handle === handle) {
        this.emit("listening");
      }
    });
  }

  #onConnection(channel: ByteChannel, remote: { address: string; port: number }): void {
    const local = this.#address;
    if (local === null) {
      channel.destroy();
      return;
    }
    const ipv6Server = local.family === "IPv6";
    const mapped = ipv6Server && isIPv4(remote.address);
    const remoteAddress = mapped ? `::ffff:${remote.address}` : remote.address;
    const localAddress =
      local.address === "::"
        ? isIPv6(remote.address)
          ? "::1"
          : "::ffff:127.0.0.1"
        : local.address === "0.0.0.0"
          ? "127.0.0.1"
          : local.address;
    const peer = {
      remoteAddress,
      remotePort: remote.port,
      remoteFamily: isIPv4(remoteAddress) ? ("IPv4" as const) : ("IPv6" as const),
      localAddress,
      localPort: local.port,
      localFamily: isIPv4(localAddress) ? ("IPv4" as const) : ("IPv6" as const),
    };
    if (this.maxConnections !== undefined && this._connections >= this.maxConnections) {
      dropConnection(channel);
      this.emit("drop", {
        localAddress: peer.localAddress,
        localPort: peer.localPort,
        localFamily: peer.localFamily,
        remoteAddress: peer.remoteAddress,
        remotePort: peer.remotePort,
        remoteFamily: peer.remoteFamily,
      });
      return;
    }
    const socket = new Socket({
      allowHalfOpen: this.allowHalfOpen,
      highWaterMark: this.highWaterMark,
      noDelay: this.noDelay,
      keepAlive: this.keepAlive,
    });
    socket[kAttach](channel, peer);
    if (this.pauseOnConnect) {
      socket.pause();
    }
    this._connections++;
    socket.server = this;
    socket._server = this;
    this.emit("connection", socket);
  }

  /** `{ address, family, port }` while listening, else null. */
  address(): AddressInfo | null {
    return this.#handle === null || this.#address === null ? null : { ...this.#address };
  }

  /**
   * Stops accepting connections. `close` (and `cb`) follow once every open
   * connection has ended; `cb` gets `ERR_SERVER_NOT_RUNNING` when it was not listening.
   */
  close(cb?: (error?: Error) => void): this {
    if (typeof cb === "function") {
      if (this.#handle === null) {
        this.once("close", () => cb(notRunning()));
      } else {
        this.once("close", cb);
      }
    }
    this.#listeningId++;
    if (this.#handle !== null) {
      this.#handle.close();
      this.#handle = null;
      this.#updateRef();
    }
    this._emitCloseIfDrained();
    return this;
  }

  /** Emits `close` once the server is closed and every connection has ended. */
  _emitCloseIfDrained(): void {
    if (this.#handle !== null || this._connections > 0) {
      return;
    }
    nextTick(() => this.emit("close"));
  }

  /** Calls back with the number of open connections. */
  getConnections(cb: (error: Error | null, count: number) => void): this {
    nextTick(() => cb(null, this._connections));
    return this;
  }

  /** Lets the process exit while this server listens. */
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
    const want = this.#refWanted && this.#handle !== null;
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
}

Object.defineProperty(Server.prototype, asyncDispose, {
  configurable: true,
  writable: true,
  value: function dispose(this: Server): Promise<void> {
    if (!this.listening) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.close((error) => (error ? reject(error) : resolve()));
    });
  },
});
