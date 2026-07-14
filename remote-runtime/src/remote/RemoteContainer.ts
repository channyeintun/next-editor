import type { WebContainer } from "@webcontainer/api";
import { RcpConnection, type ConnectionOptions } from "./connection";
import { treeToZip, zipToTree } from "./mountZip";
import { listenForPreviewMessages } from "./previewMessages";
import { RemoteFs } from "./RemoteFs";
import { RemoteProcess } from "./RemoteProcess";
import type {
  ExportOptions,
  FileSystemTree,
  PreviewScriptOptions,
  RemoteBootOptions,
  SpawnOptions,
} from "./types";

type EventName = "port" | "server-ready" | "preview-message" | "error" | "xdg-open" | "code";
type Listener = (...args: never[]) => void;

export function renderPreviewUrl(template: string, sessionId: string, port: number): string {
  return template.replaceAll("{{sessionId}}", sessionId).replaceAll("{{port}}", String(port));
}

export class RemoteContainer {
  readonly fs: WebContainer["fs"];
  readonly on: WebContainer["on"];
  readonly path = "/";
  readonly workdir: string;
  private readonly listeners = new Map<EventName, Set<Listener>>();
  private readonly removePreviewListener: () => void;
  private tornDown = false;

  private constructor(
    private readonly connection: RcpConnection,
    private readonly previewUrlTemplate: string,
    private readonly control?: { endpoint: string; sessionId: string; token?: string },
  ) {
    this.fs = new RemoteFs(connection) as unknown as WebContainer["fs"];
    this.on = ((event: EventName, listener: Listener) => {
      let listeners = this.listeners.get(event);
      if (!listeners) { listeners = new Set(); this.listeners.set(event, listeners); }
      listeners.add(listener);
      return () => listeners!.delete(listener);
    }) as WebContainer["on"];
    this.workdir = connection.workdir;
    connection.on("port", ({ port, type }) => {
      const url = this.previewUrl(port);
      this.emit("port", port, type, url);
      if (type === "open") this.emit("server-ready", port, url);
    });
    connection.on("fatal", ({ message }) => this.emit("error", { message }));
    this.removePreviewListener = listenForPreviewMessages(
      (origin) => this.isPreviewOrigin(origin),
      (message) => this.emit("preview-message", message),
    );
  }

  static async boot(options: RemoteBootOptions = {}): Promise<RemoteContainer> {
    const endpoint = (options.endpoint ?? "/api/runtime").replace(/\/$/, "");
    const response = await fetch(`${endpoint}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runtime: options.runtime ?? "node22",
        workdirName: options.workdirName ?? "project",
        idleTimeoutSeconds: options.idleTimeoutSeconds ?? 300,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Remote runtime provisioning failed (${response.status}): ${body}`);
    }
    const provisioned = await response.json() as {
      sessionId: string; wsUrl: string; previewUrlTemplate: string; token?: string;
    };
    const connection = new RcpConnection({ wsUrl: provisioned.wsUrl, token: provisioned.token });
    await connection.open();
    return new RemoteContainer(connection, provisioned.previewUrlTemplate, {
      endpoint, sessionId: provisioned.sessionId, token: provisioned.token,
    });
  }

  static async attach(target: {
    wsUrl: string;
    previewUrlTemplate: string;
    workdirName?: string;
    WebSocketImpl?: ConnectionOptions["WebSocketImpl"];
  }): Promise<RemoteContainer> {
    const connection = new RcpConnection(target);
    await connection.open();
    return new RemoteContainer(connection, target.previewUrlTemplate);
  }

  async mount(
    snapshotOrTree: FileSystemTree | Uint8Array | ArrayBuffer,
    options: { mountPoint?: string } = {},
  ): Promise<void> {
    const bytes = snapshotOrTree instanceof Uint8Array
      ? snapshotOrTree
      : snapshotOrTree instanceof ArrayBuffer ? new Uint8Array(snapshotOrTree) : treeToZip(snapshotOrTree);
    const ch = this.connection.channels.allocate();
    const { response } = this.connection.beginRequest("mount", { mountPoint: options.mountPoint, ch });
    const writer = this.connection.channels.writable(ch).getWriter();
    await writer.write(bytes); await writer.close(); await response;
  }

  export(path: string): Promise<FileSystemTree>;
  export(path: string, options: ExportOptions & { format?: "json" }): Promise<FileSystemTree>;
  export(path: string, options: ExportOptions): Promise<Uint8Array>;
  async export(path: string, options: ExportOptions = {}): Promise<FileSystemTree | Uint8Array> {
    const format = options.format ?? "json";
    const { ch } = await this.connection.request("export", {
      path, format, includes: options.includes, excludes: options.excludes,
    });
    const reader = this.connection.channels.readable(ch).getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); length += value.length; }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return format === "json" ? zipToTree(bytes) : bytes;
  }

  async spawn(command: string, args?: string[] | SpawnOptions, options: SpawnOptions = {}): Promise<RemoteProcess> {
    const actualArgs = Array.isArray(args) ? args : [];
    const actualOptions = Array.isArray(args) ? options : args ?? {};
    const env = Object.fromEntries(Object.entries(actualOptions.env ?? {}).map(([key, value]) => [key, String(value)]));
    const result = await this.connection.request("proc.spawn", {
      cmd: command, args: actualArgs, env, cwd: actualOptions.cwd,
      terminal: actualOptions.terminal, output: actualOptions.output ?? true,
    });
    return new RemoteProcess(this.connection, result.pid, result.outCh, result.inCh);
  }

  async setPreviewScript(src: string, options: PreviewScriptOptions = {}): Promise<void> {
    if (!this.control) { console.warn("setPreviewScript is unavailable in direct attach mode"); return; }
    const response = await fetch(`${this.control.endpoint}/sessions/${this.control.sessionId}/preview-script`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(this.control.token ? { Authorization: `Bearer ${this.control.token}` } : {}) },
      body: JSON.stringify({ src, options }),
    });
    if (!response.ok) throw new Error(`Failed to set preview script (${response.status})`);
  }

  teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true; this.removePreviewListener(); this.connection.close();
    if (this.control) void fetch(`${this.control.endpoint}/sessions/${this.control.sessionId}`, {
      method: "DELETE", keepalive: true,
      headers: this.control.token ? { Authorization: `Bearer ${this.control.token}` } : {},
    }).catch(() => {});
  }

  private previewUrl(port: number): string {
    return renderPreviewUrl(this.previewUrlTemplate, this.control?.sessionId ?? "", port);
  }

  private isPreviewOrigin(origin: string): boolean {
    try { return new URL(this.previewUrl(8600)).origin === origin; } catch { return false; }
  }

  private emit(event: EventName, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try { listener(...args as never[]); } catch (error) { console.error(error); }
    }
  }
}

const _runtimeCompatibility: Pick<WebContainer,
  "fs" | "mount" | "spawn" | "export" | "on" | "setPreviewScript" | "teardown" | "path" | "workdir"
> = null as unknown as RemoteContainer;
void _runtimeCompatibility;
