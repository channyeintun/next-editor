// `http.Agent`: pools client connections per `host:port:localAddress`. With
// `keepAlive` an idle socket goes to `freeSockets` (unref'd) and the next
// request to the same origin reuses it; `maxSockets` queues requests in
// `requests`. Ported from Node 22's lib/_http_agent.js.
import EventEmitter from "../events";
import { invalidArgValue, validateNumber, validateString } from "../internalErrors";
import { connect as netConnect } from "../net";
import type { Socket } from "../net/socket";
import type { HttpSocket } from "./incoming";

/** `new http.Agent(options)`. */
export interface AgentOptions {
  keepAlive?: boolean;
  keepAliveMsecs?: number;
  maxSockets?: number;
  maxTotalSockets?: number;
  maxFreeSockets?: number;
  scheduling?: "fifo" | "lifo";
  timeout?: number;
  noDelay?: boolean;
  [key: string]: unknown;
}

/** The connection options an agent passes to `createConnection`. */
export interface AgentConnectionOptions {
  host?: string;
  port?: number | string;
  localAddress?: string;
  family?: number;
  socketPath?: string;
  path?: string | null;
  servername?: string;
  _agentKey?: string;
  [key: string]: unknown;
}

/** What an agent needs of a request. */
export interface AgentRequest {
  onSocket(socket: HttpSocket, error?: Error): void;
  getHeader(name: string): unknown;
  shouldKeepAlive: boolean;
  timeout?: number;
  reusedSocket: boolean;
  res?: { headers: Record<string, unknown> } | null;
  [kRequestOptions]?: AgentConnectionOptions;
}

type CreateCallback = (error: Error | null, socket?: HttpSocket) => void;

const kRequestOptions = Symbol("requestOptions");
const HTTP_AGENT_KEEP_ALIVE_TIMEOUT_BUFFER = 1000;

function freeSocketErrorListener(this: Socket, error: Error): void {
  this.destroy();
  this.emit("agentRemove");
  void error;
}

function setRequestSocket(agent: Agent, req: AgentRequest, socket: HttpSocket): void {
  req.onSocket(socket);
  const agentTimeout = (agent.options.timeout as number | undefined) || 0;
  if (req.timeout === undefined || req.timeout === agentTimeout) {
    return;
  }
  socket.setTimeout(req.timeout);
}

function calculateServerName(options: AgentConnectionOptions, req: AgentRequest): string {
  let servername = options.host ?? "";
  const hostHeader = req.getHeader("host");
  if (hostHeader) {
    validateString(hostHeader, "options.headers.host");
    if (hostHeader.startsWith("[")) {
      const index = hostHeader.indexOf("]");
      servername = index === -1 ? hostHeader : hostHeader.slice(1, index);
    } else {
      servername = hostHeader.split(":", 1)[0];
    }
  }
  return servername;
}

function normalizeServerName(options: AgentConnectionOptions, req: AgentRequest): void {
  if (!options.servername && options.servername !== "") {
    options.servername = calculateServerName(options, req);
  }
}

/** `http.Agent`. */
export class Agent extends EventEmitter {
  /** `http.Agent.defaultMaxSockets`. */
  static defaultMaxSockets = Infinity;

  defaultPort = 80;
  protocol = "http:";
  options: AgentOptions & { path: null };
  requests: Record<string, AgentRequest[]> = Object.create(null);
  sockets: Record<string, HttpSocket[]> = Object.create(null);
  freeSockets: Record<string, HttpSocket[]> = Object.create(null);
  keepAliveMsecs: number;
  keepAlive: boolean;
  maxSockets: number;
  maxFreeSockets: number;
  scheduling: "fifo" | "lifo";
  maxTotalSockets: number;
  totalSocketCount = 0;

  constructor(options?: AgentOptions) {
    super();
    this.options = { ...options, path: null };
    if (this.options.noDelay === undefined) {
      this.options.noDelay = true;
    }
    this.keepAliveMsecs = this.options.keepAliveMsecs || 1000;
    this.keepAlive = this.options.keepAlive || false;
    this.maxSockets = this.options.maxSockets || Agent.defaultMaxSockets;
    this.maxFreeSockets = this.options.maxFreeSockets || 256;
    this.scheduling = this.options.scheduling || "lifo";
    if (this.scheduling !== "fifo" && this.scheduling !== "lifo") {
      throw invalidArgValue("scheduling", this.scheduling, "must be one of: 'fifo', 'lifo'");
    }
    if (this.options.maxTotalSockets !== undefined) {
      validateNumber(this.options.maxTotalSockets, "maxTotalSockets", 1);
      this.maxTotalSockets = this.options.maxTotalSockets;
    } else {
      this.maxTotalSockets = Infinity;
    }
    this.on("free", (socket: HttpSocket, opts: AgentConnectionOptions) =>
      this.#onFree(socket, opts),
    );
  }

  #onFree(socket: HttpSocket, options: AgentConnectionOptions): void {
    const name = this.getName(options);
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const requests = this.requests[name];
    if (requests?.length) {
      const req = requests.shift() as AgentRequest;
      setRequestSocket(this, req, socket);
      if (requests.length === 0) {
        delete this.requests[name];
      }
      return;
    }
    const req = socket._httpMessage as AgentRequest | null;
    if (!req || !req.shouldKeepAlive || !this.keepAlive) {
      socket.destroy();
      return;
    }
    const freeSockets = this.freeSockets[name] || [];
    const freeLen = freeSockets.length;
    let count = freeLen;
    if (this.sockets[name]) {
      count += this.sockets[name].length;
    }
    if (
      this.totalSocketCount > this.maxTotalSockets ||
      count > this.maxSockets ||
      freeLen >= this.maxFreeSockets ||
      !this.keepSocketAlive(socket)
    ) {
      socket.destroy();
      return;
    }
    this.freeSockets[name] = freeSockets;
    socket._httpMessage = null;
    this.removeSocket(socket, options);
    socket.once("error", freeSocketErrorListener);
    freeSockets.push(socket);
  }

  /** Opens a connection; `net.createConnection` unless overridden. */
  createConnection(options: AgentConnectionOptions, callback?: CreateCallback): Socket | undefined {
    void callback;
    return netConnect(options);
  }

  /** `host:port:localAddress[:family]`: the pool key. */
  getName(options: AgentConnectionOptions = {}): string {
    let name = options.host || "localhost";
    name += ":";
    if (options.port) {
      name += String(options.port);
    }
    name += ":";
    if (options.localAddress) {
      name += options.localAddress;
    }
    if (options.family === 4 || options.family === 6) {
      name += `:${options.family}`;
    }
    if (options.socketPath) {
      name += `:${options.socketPath}`;
    }
    return name;
  }

  /** Gives `req` a socket: a free one, a new one, or a place in the queue. */
  addRequest(
    req: AgentRequest,
    options: AgentConnectionOptions | string,
    port?: number,
    localAddress?: string,
  ): void {
    let opts: AgentConnectionOptions =
      typeof options === "string" ? { host: options, port, localAddress } : options;
    opts = { ...opts, ...this.options };
    if (opts.socketPath) {
      opts.path = opts.socketPath;
    }
    normalizeServerName(opts, req);
    const name = this.getName(opts);
    this.sockets[name] ||= [];
    const freeSockets = this.freeSockets[name];
    let socket: HttpSocket | undefined;
    if (freeSockets) {
      while (freeSockets.length && freeSockets[0].destroyed) {
        freeSockets.shift();
      }
      socket = this.scheduling === "fifo" ? freeSockets.shift() : freeSockets.pop();
      if (!freeSockets.length) {
        delete this.freeSockets[name];
      }
    }
    const freeLen = freeSockets ? freeSockets.length : 0;
    const sockLen = freeLen + this.sockets[name].length;
    if (socket) {
      this.reuseSocket(socket, req);
      setRequestSocket(this, req, socket);
      this.sockets[name].push(socket);
    } else if (sockLen < this.maxSockets && this.totalSocketCount < this.maxTotalSockets) {
      this.createSocket(req, opts, (error, created) => {
        if (error || !created) {
          req.onSocket(created as HttpSocket, error ?? undefined);
        } else {
          setRequestSocket(this, req, created);
        }
      });
    } else {
      this.requests[name] ||= [];
      req[kRequestOptions] = opts;
      this.requests[name].push(req);
    }
  }

  /** Opens a socket for `req` and tracks it. */
  createSocket(req: AgentRequest, options: AgentConnectionOptions, cb: CreateCallback): void {
    const opts: AgentConnectionOptions = { ...options, ...this.options };
    if (opts.socketPath) {
      opts.path = opts.socketPath;
    }
    normalizeServerName(opts, req);
    const name = this.getName(opts);
    opts._agentKey = name;
    opts.encoding = null;
    let called = false;
    const oncreate: CreateCallback = (error, socket) => {
      if (called) {
        return;
      }
      called = true;
      if (error || !socket) {
        cb(error ?? new Error("createConnection returned no socket"));
        return;
      }
      this.sockets[name] ||= [];
      this.sockets[name].push(socket);
      this.totalSocketCount++;
      installListeners(this, socket, opts);
      cb(null, socket);
    };
    if (this.keepAlive) {
      opts.keepAlive = this.keepAlive;
      opts.keepAliveInitialDelay = this.keepAliveMsecs;
    }
    let created: Socket | undefined;
    try {
      created = this.createConnection(opts, oncreate);
    } catch (error) {
      oncreate(error as Error);
      return;
    }
    if (created) {
      oncreate(null, created as HttpSocket);
    }
  }

  /** Forgets `socket`; a queued request for the origin gets a new connection. */
  removeSocket(socket: HttpSocket, options: AgentConnectionOptions): void {
    const name = this.getName(options);
    const sets = [this.sockets];
    if (!socket.writable) {
      sets.push(this.freeSockets);
    }
    for (const sockets of sets) {
      const list = sockets[name];
      if (list) {
        const index = list.indexOf(socket);
        if (index !== -1) {
          list.splice(index, 1);
          if (list.length === 0) {
            delete sockets[name];
          }
        }
      }
    }
    let req: AgentRequest | undefined;
    let opts: AgentConnectionOptions | undefined = options;
    if (this.requests[name]?.length) {
      req = this.requests[name][0];
    } else {
      for (const prop of Object.keys(this.requests)) {
        if (this.sockets[prop]?.length) {
          break;
        }
        req = this.requests[prop][0];
        opts = req[kRequestOptions];
        break;
      }
    }
    if (req && opts) {
      const pending = req;
      pending[kRequestOptions] = undefined;
      this.createSocket(pending, opts, (error, created) => {
        if (error || !created) {
          pending.onSocket(created as HttpSocket, error ?? undefined);
        } else {
          created.emit("free");
        }
      });
    }
  }

  /** Prepares an idle socket for the pool: unref'd, with the agent's timeout. */
  keepSocketAlive(socket: HttpSocket): boolean {
    socket.setKeepAlive(true, this.keepAliveMsecs);
    socket.unref();
    let agentTimeout = (this.options.timeout as number | undefined) || 0;
    let canKeepSocketAlive = true;
    const res = (socket._httpMessage as AgentRequest | null)?.res;
    const hint = res?.headers["keep-alive"];
    if (typeof hint === "string") {
      const seconds = /^timeout=(\d+)/.exec(hint)?.[1];
      if (seconds) {
        let serverHintTimeout =
          Number.parseInt(seconds, 10) * 1000 - HTTP_AGENT_KEEP_ALIVE_TIMEOUT_BUFFER;
        serverHintTimeout = serverHintTimeout > 0 ? serverHintTimeout : 0;
        if (serverHintTimeout === 0) {
          canKeepSocketAlive = false;
        } else if (serverHintTimeout < agentTimeout) {
          agentTimeout = serverHintTimeout;
        }
      }
    }
    if (socket.timeout !== agentTimeout) {
      socket.setTimeout(agentTimeout);
    }
    return canKeepSocketAlive;
  }

  /** Takes a pooled socket back into use. */
  reuseSocket(socket: HttpSocket, req: AgentRequest): void {
    socket.removeListener("error", freeSocketErrorListener);
    req.reusedSocket = true;
    socket.ref();
  }

  /** Destroys every socket the agent holds. */
  destroy(): void {
    for (const set of [this.freeSockets, this.sockets]) {
      for (const key of Object.keys(set)) {
        for (const socket of set[key].slice()) {
          socket.destroy();
        }
      }
    }
  }
}

function installListeners(agent: Agent, socket: HttpSocket, options: AgentConnectionOptions): void {
  const onFree = () => {
    agent.emit("free", socket, options);
  };
  socket.on("free", onFree);
  const onClose = () => {
    agent.totalSocketCount--;
    agent.removeSocket(socket, options);
  };
  socket.on("close", onClose);
  const onTimeout = () => {
    const sockets = agent.freeSockets;
    if (Object.keys(sockets).some((name) => sockets[name].includes(socket))) {
      socket.destroy();
    }
  };
  socket.on("timeout", onTimeout);
  const onRemove = () => {
    agent.totalSocketCount--;
    agent.removeSocket(socket, options);
    socket.removeListener("close", onClose);
    socket.removeListener("free", onFree);
    socket.removeListener("timeout", onTimeout);
    socket.removeListener("agentRemove", onRemove);
  };
  socket.on("agentRemove", onRemove);
}

/** The agent `http.globalAgent` starts as: keep-alive, as in Node 19+. */
export const globalAgent = new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 });

let currentGlobalAgent: Agent = globalAgent;

/** `http.globalAgent` as it is now (a program may replace it). */
export function getGlobalAgent(): Agent {
  return currentGlobalAgent;
}

/** Replaces `http.globalAgent`. */
export function setGlobalAgent(agent: Agent): void {
  currentGlobalAgent = agent;
}
