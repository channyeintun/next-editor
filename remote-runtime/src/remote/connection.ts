import { ChannelMux } from "../rcp/channels";
import { fromWireError, RcpError } from "../rcp/errors";
import { parseBinaryFrame, parseControlFrame } from "../rcp/frames";
import {
  protocolVersion,
  type EventFrame,
  type EventMap,
  type EventMethod,
  type Method,
  type MethodParams,
  type MethodResult,
} from "../rcp/types";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

export interface ConnectionOptions {
  wsUrl: string;
  token?: string;
  workdirName?: string;
  WebSocketImpl?: typeof WebSocket;
  reconnectDelaysMs?: number[];
  handshakeTimeoutMs?: number;
}

export class RcpConnection {
  readonly channels: ChannelMux;
  workdir = "";
  agentVersion = "";
  private socket?: WebSocket;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<EventMethod, Set<(payload: never) => void>>();
  private readonly WebSocketImpl: typeof WebSocket;
  private keepalive?: ReturnType<typeof setInterval>;
  private closed = false;
  private reconnecting = false;
  private resumeToken?: string;
  private readonly reconnectListeners = new Set<() => void | Promise<void>>();

  constructor(private readonly options: ConnectionOptions) {
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.channels = new ChannelMux(
      "client",
      (frame) => this.send(frame),
      (ch, bytes) => this.send(JSON.stringify({ t: "evt", m: "ch.credit", p: { ch, bytes } })),
    );
  }

  async open(resumeToken?: string): Promise<void> {
    this.closed = false;
    await this.openSocket(resumeToken);
    this.startKeepalive();
  }

  private async openSocket(resumeToken?: string): Promise<void> {
    const url = new URL(this.options.wsUrl);
    if (this.options.token) url.searchParams.set("token", this.options.token);
    const socket = new this.WebSocketImpl(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    await this.withTimeout(new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new RcpError("EGONE", "WebSocket open failed")); };
      const cleanup = () => { socket.removeEventListener("open", onOpen); socket.removeEventListener("error", onError); };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    }), "WebSocket open timed out");
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => { if (this.socket === socket) void this.handleClose(); });
    const hello = await this.withTimeout(
      this.request("session.hello", { protocolVersion, resumeToken }),
      "session.hello timed out",
    );
    this.workdir = hello.workdir;
    this.agentVersion = hello.agentVersion;
    this.resumeToken = hello.resumeToken ?? resumeToken;
  }

  request<M extends Method>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const { response } = this.beginRequest(method, params);
    return response;
  }

  beginRequest<M extends Method>(method: M, params: MethodParams<M>): {
    id: number;
    response: Promise<MethodResult<M>>;
  } {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) {
      throw new RcpError("EGONE", "connection is not open");
    }
    const id = this.nextRequestId++;
    const response = new Promise<MethodResult<M>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send(JSON.stringify({ t: "req", id, m: method, p: params }));
    return { id, response };
  }

  on<M extends EventMethod>(method: M, listener: (payload: EventMap[M]) => void): () => void {
    let listeners = this.listeners.get(method);
    if (!listeners) { listeners = new Set(); this.listeners.set(method, listeners); }
    listeners.add(listener as (payload: never) => void);
    return () => listeners!.delete(listener as (payload: never) => void);
  }

  onReconnect(listener: () => void | Promise<void>): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    this.socket?.close();
    this.rejectPending(new RcpError("EGONE", "connection closed"));
  }

  private startKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = setInterval(() => { void this.request("session.ping", {}).catch(() => {}); }, 20_000);
  }

  private send(data: string | Uint8Array): void {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) {
      throw new RcpError("EGONE", "connection is not open");
    }
    this.socket.send(typeof data === "string" ? data : data.slice().buffer as ArrayBuffer);
  }

  private handleMessage(message: MessageEvent): void {
    try {
      if (typeof message.data !== "string") {
        const data = message.data instanceof ArrayBuffer
          ? message.data
          : message.data instanceof Uint8Array ? message.data : undefined;
        if (!data) throw new RcpError("EPROTO", "unsupported WebSocket message");
        this.channels.receive(parseBinaryFrame(data));
        return;
      }
      const frame = parseControlFrame(message.data);
      if (frame.t === "ok" || frame.t === "err") {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        if (frame.t === "ok") pending.resolve(frame.r);
        else pending.reject(fromWireError(frame.e));
        return;
      }
      if (frame.t === "evt") this.emit(frame);
    } catch (error) {
      this.emit({ t: "evt", m: "fatal", p: { message: String(error) } });
    }
  }

  private emit<M extends EventMethod>(frame: EventFrame<M>): void {
    if (frame.m === "ch.credit") {
      const credit = frame.p as EventMap["ch.credit"];
      this.channels.grantCredit(credit.ch, credit.bytes);
    }
    for (const listener of this.listeners.get(frame.m) ?? []) {
      try { listener(frame.p as never); } catch (error) { console.error(error); }
    }
  }

  private async handleClose(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    if (this.keepalive) clearInterval(this.keepalive);
    this.rejectPending(new RcpError("EGONE", "connection lost"));
    const delays = this.options.reconnectDelaysMs ?? [500, 1_000, 2_000, 4_000, 8_000];
    let lastError: unknown = new Error("connection lost");
    for (const delay of delays) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.closed) { this.reconnecting = false; return; }
      try {
        await this.openSocket(this.resumeToken);
        for (const listener of this.reconnectListeners) await listener();
        this.startKeepalive();
        this.reconnecting = false;
        return;
      } catch (error) {
        lastError = error;
        this.socket?.close();
      }
    }
    this.reconnecting = false;
    this.emit({ t: "evt", m: "fatal", p: {
      message: `Remote runtime connection lost: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    } });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    const timeoutMs = this.options.handshakeTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new RcpError("EGONE", message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
