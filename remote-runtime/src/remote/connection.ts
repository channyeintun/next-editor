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

  constructor(private readonly options: ConnectionOptions) {
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.channels = new ChannelMux(
      "client",
      (frame) => this.send(frame),
      (ch, bytes) => this.send(JSON.stringify({ t: "evt", m: "ch.credit", p: { ch, bytes } })),
    );
  }

  async open(resumeToken?: string): Promise<void> {
    const url = new URL(this.options.wsUrl);
    if (this.options.token) url.searchParams.set("token", this.options.token);
    const socket = new this.WebSocketImpl(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new RcpError("EGONE", "WebSocket open failed")); };
      const cleanup = () => { socket.removeEventListener("open", onOpen); socket.removeEventListener("error", onError); };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => this.handleClose());
    const hello = await this.request("session.hello", { protocolVersion, resumeToken });
    this.workdir = hello.workdir;
    this.agentVersion = hello.agentVersion;
    this.keepalive = setInterval(() => { void this.request("session.ping", {}).catch(() => {}); }, 20_000);
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

  close(): void {
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    this.socket?.close();
    this.rejectPending(new RcpError("EGONE", "connection closed"));
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

  private handleClose(): void {
    if (this.closed) return;
    this.rejectPending(new RcpError("EGONE", "connection lost"));
    this.emit({ t: "evt", m: "fatal", p: { message: "Remote runtime connection lost" } });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
