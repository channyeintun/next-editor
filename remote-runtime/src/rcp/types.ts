export const protocolVersion = 1 as const;

export const RCP_LIMITS = {
  maxFileBytes: 64 * 1024 * 1024,
  maxMountBytes: 256 * 1024 * 1024,
  maxProcesses: 64,
  maxWatches: 128,
  maxPathDepth: 64,
  maxControlFrameBytes: 1024 * 1024,
  maxBinaryFrameBytes: 256 * 1024,
  initialChannelCredit: 256 * 1024,
} as const;

export type ErrorCode =
  | "ENOENT"
  | "EEXIST"
  | "ENOTDIR"
  | "EISDIR"
  | "ENOTEMPTY"
  | "EACCES"
  | "EPROTO"
  | "ELIMIT"
  | "EGONE";

export type FileKind = "file" | "dir" | "symlink";
export type PortType = "open" | "close";
export type WatchEventType = "rename" | "change";

export interface MethodMap {
  "session.hello": {
    params: { protocolVersion: number; resumeToken?: string };
    result: { workdir: string; agentVersion: string; resumed: boolean; resumeToken?: string };
  };
  "session.ping": { params: Record<string, never>; result: Record<string, never> };
  "fs.readFile": { params: { path: string }; result: { ch: number } };
  "fs.writeFile": { params: { path: string; ch: number }; result: Record<string, never> };
  "fs.mkdir": {
    params: { path: string; recursive: boolean };
    result: { created?: string };
  };
  "fs.readdir": {
    params: { path: string; withFileTypes: boolean };
    result: { entries: Array<{ name: string; kind: FileKind }> };
  };
  "fs.rm": {
    params: { path: string; recursive: boolean; force: boolean };
    result: Record<string, never>;
  };
  "fs.rename": { params: { from: string; to: string }; result: Record<string, never> };
  "fs.watch": {
    params: { watchId: number; path: string; recursive: boolean };
    result: Record<string, never>;
  };
  "fs.unwatch": { params: { watchId: number }; result: Record<string, never> };
  mount: {
    params: { mountPoint?: string; ch: number };
    result: Record<string, never>;
  };
  export: {
    params: {
      path: string;
      format: "json" | "binary" | "zip";
      includes?: string[];
      excludes?: string[];
    };
    result: { ch: number };
  };
  "proc.spawn": {
    params: {
      cmd: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
      terminal?: { cols: number; rows: number };
      output: boolean;
    };
    result: { pid: number; outCh: number; inCh: number };
  };
  "proc.resize": {
    params: { pid: number; cols: number; rows: number };
    result: Record<string, never>;
  };
  "proc.kill": { params: { pid: number }; result: Record<string, never> };
}

export type Method = keyof MethodMap;
export type MethodParams<M extends Method> = MethodMap[M]["params"];
export type MethodResult<M extends Method> = MethodMap[M]["result"];

export interface EventMap {
  port: { port: number; type: PortType };
  "proc.exit": { pid: number; code: number };
  "fs.watch": { watchId: number; event: WatchEventType; filename: string };
  "ch.credit": { ch: number; bytes: number };
  fatal: { message: string };
}

export type EventMethod = keyof EventMap;

export type RequestFrame<M extends Method = Method> = M extends Method
  ? { t: "req"; id: number; m: M; p: MethodParams<M> }
  : never;
export type SuccessFrame = { t: "ok"; id: number; r: unknown };
export type ErrorFrame = {
  t: "err";
  id: number;
  e: { code: ErrorCode; message: string };
};
export type EventFrame<M extends EventMethod = EventMethod> = M extends EventMethod
  ? { t: "evt"; m: M; p: EventMap[M] }
  : never;
export type ControlFrame = RequestFrame | SuccessFrame | ErrorFrame | EventFrame;
