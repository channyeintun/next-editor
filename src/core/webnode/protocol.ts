// Every message that crosses a thread: page ⇄ kernel worker, and kernel worker
// ⇄ process worker. The kernel and both clients import these shapes so the two
// sides of a channel cannot drift.
import type { SystemErrorRecord } from "./errors";
import type { ExitStatus } from "./process/runtime";
import type { SharedFsAdmission } from "./sharedfs/processBackend";
import type { UmaskCell } from "./umask";

// ---------------------------------------------------------------------------
// Page ⇄ kernel
// ---------------------------------------------------------------------------

export interface BootOptions {
  /** The directory name under /home/projects the project mounts at. */
  workdirName: string;
  /**
   * False keeps the filesystem inside the kernel worker (kernel/vfs), with
   * every call a round trip to it. The shared one (sharedfs) is used otherwise,
   * where a shared memory can be made.
   */
  sharedFilesystem?: boolean;
  coep: "require-corp" | "credentialless" | "none";
  forwardPreviewErrors: boolean | "exceptions-only";
  /** The origin of the page that booted the runtime: the only one a preview takes a connection from. */
  editorOrigin: string;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface PageSpawnOptions {
  cwd?: string;
  env?: Record<string, string | number | boolean>;
  /** False discards the process's output. */
  output?: boolean;
  terminal?: TerminalSize;
}

/** One file or directory of a mounted tree, as an absolute path. */
export type MountEntry = { path: string; data: Uint8Array } | { path: string; directory: true };

/** A request from the page; `id` pairs it with its reply. */
export interface PageRequest {
  id: number;
  method: string;
  args: unknown[];
}

export type PageReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: SerializedError };

/** What the kernel tells the page without being asked. */
export type KernelEvent =
  | { event: "output"; pid: number; data: string }
  | { event: "exit"; pid: number; code: number }
  | { event: "port"; port: number; type: "open" | "close" }
  | { event: "watch"; watchId: number; eventType: "rename" | "change"; filename: string }
  | { event: "error"; message: string };

/** An error flattened for a thread crossing. `system` is set for a failed system call. */
export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  system?: SystemErrorRecord;
}

// ---------------------------------------------------------------------------
// Kernel ⇄ process
// ---------------------------------------------------------------------------

/** Which built-in program a process worker runs. */
export type ProgramName = "node" | "shell" | "npm";

/** The first message a process worker receives. */
export interface ProcessInit {
  type: "init";
  pid: number;
  ppid: number;
  /** A worker thread of process `pid` rather than a process of its own. */
  thread: null | {
    threadId: number;
    filename: string;
    eval: boolean;
    workerData: unknown;
    port: MessagePort;
    name: string;
  };
  program: ProgramName;
  argv: string[];
  execArgv: string[];
  env: Record<string, string>;
  cwd: string;
  /**
   * The process's file mode creation mask, in memory it shares with its
   * threads and the kernel (umask.ts): the process sets it there, and
   * whoever creates a file for it reads it there.
   */
  umask: UmaskCell;
  /** The buffer the kernel answers this worker's blocking calls in. */
  syncBuffer: SharedArrayBuffer;
  /**
   * This worker's way into the shared filesystem, when the kernel admitted it:
   * it then makes the path calls itself (sharedfs/README.md). Null where there
   * is no shared filesystem, and every filesystem call goes to the kernel.
   */
  sharedFs: SharedFsAdmission | null;
  /** Which of fds 0-2 are terminals, and that terminal's size. */
  ttyFds: number[];
  /**
   * The descriptors above 2 the process starts with, lowest first (what a
   * parent shell's `exec 3>&1` left open): a shell takes them into its own
   * table without asking the kernel about each.
   */
  inheritedFds: number[];
  terminal: TerminalSize;
  /** The channel for an `"ipc"` stdio entry. */
  ipc: MessagePort | null;
}

/** Messages a process worker sends the kernel. */
export type ProcessMessage =
  /** A blocking call: the worker waits on its sync buffer for the answer. */
  | { type: "sync"; op: string; args: unknown[] }
  /** The worker supplies a bigger sync buffer and asks for the last answer again. */
  | { type: "sync-buffer"; buffer: SharedArrayBuffer }
  /** A call answered later with a `reply` message. */
  | { type: "call"; id: number; op: string; args: unknown[] }
  /** A call with no answer. */
  | { type: "post"; op: string; args: unknown[] };

/** Messages the kernel sends a process worker. */
export type KernelMessage =
  | ProcessInit
  | { type: "reply"; id: number; ok: true; value: unknown }
  | { type: "reply"; id: number; ok: false; error: SerializedError }
  /**
   * What arrived on an fd being read; a null `chunk` is the end. The process
   * says so (an `fd.ack` post) as it hands a chunk to its reader. `counted`
   * bytes come from a pipe and take up its room until then; what reaches the
   * process with its reader stopped it gives back (an `fd.unread` call), and
   * the kernel puts back in the pipe whatever it sent and was not
   * acknowledged. `typed` bytes come from a terminal: what the process never
   * hands over goes back to the terminal when the process ends or closes the
   * fd.
   */
  | { type: "fd-data"; fd: number; chunk: Uint8Array | null; counted?: boolean; typed?: boolean }
  | { type: "child-exit"; pid: number; status: ExitStatus }
  | { type: "thread-exit"; threadId: number; code: number }
  /** `fromTerminal`: the terminal sent it (a Ctrl+C), to every process of its foreground group. */
  | { type: "signal"; signal: string; fromTerminal?: boolean }
  | { type: "watch"; watchId: number; eventType: "rename" | "change"; filename: string }
  | {
      type: "connection";
      listenerId: number;
      channelId: number;
      port: MessagePort;
      remotePort: number;
    }
  /** The process at the other end of a connection is gone. */
  | { type: "channel-dead"; channelId: number }
  | { type: "resize"; terminal: TerminalSize };

// The sync buffer: an Int32Array header, then the payload.
export const SYNC_STATE = 0;
export const SYNC_LENGTH = 1;
export const SYNC_KIND = 2;
/**
 * A count the kernel raises whenever a pipe the worker writes to loses its
 * last reader. The worker reads it before writes it hands over without
 * waiting, so it learns of a broken pipe at once, even in a loop that never
 * yields to its messages.
 */
export const SYNC_BROKEN = 3;
export const SYNC_HEADER_BYTES = 16;

export const SYNC_PENDING = 0;
export const SYNC_OK = 1;
export const SYNC_ERROR = 2;
/** The answer does not fit; `SYNC_LENGTH` holds the bytes it needs. */
export const SYNC_TOO_SMALL = 3;

export const PAYLOAD_JSON = 0;
export const PAYLOAD_BYTES = 1;
export const PAYLOAD_VOID = 2;

export const INITIAL_SYNC_BUFFER_BYTES = 1 << 20;

/** Flattens `error` for a thread crossing. */
export function serializeError(error: unknown, system: SystemErrorRecord | null): SerializedError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: typeof code === "string" ? code : undefined,
      system: system ?? undefined,
    };
  }
  return { name: "Error", message: String(error) };
}
