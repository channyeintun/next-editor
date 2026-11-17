// A process's end of its link to the kernel: the `ProcessRuntime` every builtin
// and program uses, implemented with blocking calls (the worker waits on a
// shared buffer while the kernel answers), calls answered by message, and the
// events the kernel sends back. kernel/kernel.ts is the other end.
import { createPortChannel } from "../byteChannel";
import { systemErrorFromRecord } from "../errors";
import { decodePayload, readSyncAnswer } from "../kernel/codec";
import type { DirEntry, StatData } from "../kernel/vfs/types";
import { runNextTicks } from "./node/process";
import { THREAD_EXIT_MESSAGE } from "./node/worker_threads";
import type { KernelMessage, ProcessInit, ProcessMessage, SerializedError } from "../protocol";
import { withDirectPaths } from "../sharedfs/processBackend";
import {
  SYNC_ERROR,
  SYNC_HEADER_BYTES,
  SYNC_LENGTH,
  SYNC_PENDING,
  SYNC_STATE,
  SYNC_TOO_SMALL,
} from "../protocol";
import type {
  ByteChannel,
  ChildHandle,
  ExitStatus,
  FdKind,
  FsBackend,
  ProcessRuntime,
  SpawnRequest,
  SpawnSyncRequest,
  SpawnSyncResult,
  ThreadHandle,
  ThreadSpawnRequest,
} from "./runtime";

/** The part of a worker's global scope the client uses. */
export interface WorkerScope {
  postMessage(message: ProcessMessage, transfer?: Transferable[]): void;
}

export interface ProcessClient {
  runtime: ProcessRuntime;
  /** Handles a message from the kernel. */
  receive(message: KernelMessage): void;
  /** Runs `listener` each time the ref count returns to zero. */
  onIdle(listener: () => void): void;
  /** The current ref count. */
  refCount(): number;
  /** The channel for an `"ipc"` stdio entry, when this process was started with one. */
  ipc: MessagePort | null;
}

const DEFAULT_HANDLED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function rebuildError(serialized: SerializedError): Error {
  if (serialized.system) {
    return systemErrorFromRecord(serialized.system);
  }
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.code) {
    (error as Error & { code?: string }).code = serialized.code;
  }
  return error;
}

/** Builds the runtime for the process (or thread) `init` describes. */
export function createProcessClient(scope: WorkerScope, init: ProcessInit): ProcessClient {
  let buffer = init.syncBuffer;
  let header = new Int32Array(buffer, 0, SYNC_HEADER_BYTES / 4);

  const callSync = (op: string, ...args: unknown[]): unknown => {
    Atomics.store(header, SYNC_STATE, SYNC_PENDING);
    scope.postMessage({ type: "sync", op, args });
    for (;;) {
      Atomics.wait(header, SYNC_STATE, SYNC_PENDING);
      const state = Atomics.load(header, SYNC_STATE);
      if (state === SYNC_TOO_SMALL) {
        // The answer needs more room: hand the kernel a bigger buffer.
        buffer = new SharedArrayBuffer(SYNC_HEADER_BYTES + header[SYNC_LENGTH] * 2);
        header = new Int32Array(buffer, 0, SYNC_HEADER_BYTES / 4);
        Atomics.store(header, SYNC_STATE, SYNC_PENDING);
        scope.postMessage({ type: "sync-buffer", buffer });
        continue;
      }
      const { kind, bytes } = readSyncAnswer(buffer);
      const value = decodePayload(kind, bytes);
      if (state === SYNC_ERROR) {
        throw rebuildError(value as SerializedError);
      }
      return value;
    }
  };

  let nextCallId = 1;
  const pendingCalls = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const call = (op: string, ...args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextCallId++;
      pendingCalls.set(id, { resolve, reject });
      scope.postMessage({ type: "call", id, op, args });
    });
  const post = (op: string, args: unknown[], transfer?: Transferable[]) =>
    scope.postMessage({ type: "post", op, args }, transfer);

  let refs = 0;
  const idleListeners: (() => void)[] = [];

  const watchListeners = new Map<number, (eventType: "rename" | "change", name: string) => void>();
  const fdReaders = new Map<number, (chunk: Uint8Array | null) => void>();
  /**
   * What reached a stopped fd: the kernel had already taken these bytes from
   * the pipe or terminal when it learned of the `readStop`. The next
   * `readStart` gets them first, so no byte is lost when a reader pauses.
   */
  const fdBacklogs = new Map<number, (Uint8Array | null)[]>();
  /**
   * Fds closed here whose close the kernel has not yet answered, with how many
   * such closes are pending. The kernel reuses the lowest free fd, and a spawn
   * or pipe answers through the shared buffer at once, so a new stream can
   * take the number while data the kernel sent for the old one is still on its
   * way. The answer to the close comes after all of that data.
   */
  const closingFds = new Map<number, number>();
  /** Fds a stream was started on: only these can have data on its way when they are closed. */
  const streamedFds = new Set<number>();

  /**
   * Drops what is known of the stream on `fd` and refuses data for that
   * number until the kernel has answered a close of it: whatever arrives
   * before that answer was sent for the stream the number had. The request
   * closes the fd when it is still open, and is refused, which marks the same
   * point, when the caller has closed it already.
   */
  const forgetStream = (fd: number): void => {
    streamedFds.delete(fd);
    fdReaders.delete(fd);
    fdBacklogs.delete(fd);
    closingFds.set(fd, (closingFds.get(fd) ?? 0) + 1);
    const confirmed = () => {
      const left = (closingFds.get(fd) ?? 1) - 1;
      if (left > 0) {
        closingFds.set(fd, left);
      } else {
        closingFds.delete(fd);
      }
    };
    // Answered in order with the fd's data, and handled before the next message.
    const id = nextCallId++;
    pendingCalls.set(id, { resolve: confirmed, reject: confirmed });
    scope.postMessage({ type: "call", id, op: "fd.close", args: [fd] });
  };
  const exitListeners = new Map<number, ((status: ExitStatus) => void)[]>();
  const exitedChildren = new Map<number, ExitStatus>();
  const threadExitListeners = new Map<number, ((code: number) => void)[]>();
  const signalListeners: ((signal: string) => boolean)[] = [];
  const resizeListeners = new Set<() => void>();
  const connectionHandlers = new Map<
    number,
    (channel: ByteChannel, remote: { address: string; port: number }) => void
  >();
  const channels = new Map<number, { kill(): void }>();
  let terminal = init.terminal;
  let handledSignalsSet = false;
  let nextToken = 1;

  const adoptChannel = (channelId: number, port: MessagePort): ByteChannel => {
    const channel = createPortChannel(port, () => {
      channels.delete(channelId);
      post("net.closed", [channelId]);
    });
    channels.set(channelId, channel);
    return channel;
  };

  // Every filesystem call as a call to the kernel. A worker admitted to the
  // shared filesystem makes the path calls itself instead (withDirectPaths).
  const kernelFs: FsBackend = {
    stat: (path, follow) => callSync("fs.stat", path, follow) as StatData,
    fstat: (fd) => callSync("fs.fstat", fd) as StatData,
    exists: (path) => callSync("fs.exists", path) as boolean,
    readdir: (path) => callSync("fs.readdir", path) as DirEntry[],
    mkdir: (path, recursive, mode) =>
      callSync("fs.mkdir", path, recursive, mode) as string | undefined,
    rmdir: (path) => void callSync("fs.rmdir", path),
    unlink: (path) => void callSync("fs.unlink", path),
    rm: (path, recursive, force) => void callSync("fs.rm", path, recursive, force),
    rename: (from, to) => void callSync("fs.rename", from, to),
    link: (existing, path) => void callSync("fs.link", existing, path),
    symlink: (target, path) => void callSync("fs.symlink", target, path),
    readlink: (path) => callSync("fs.readlink", path) as string,
    realpath: (path) => callSync("fs.realpath", path) as string,
    chmod: (path, mode, follow) => void callSync("fs.chmod", path, mode, follow),
    fchmod: (fd, mode) => void callSync("fs.fchmod", fd, mode),
    utimes: (path, atime, mtime, follow) => void callSync("fs.utimes", path, atime, mtime, follow),
    futimes: (fd, atime, mtime) => void callSync("fs.futimes", fd, atime, mtime),
    truncate: (path, length) => void callSync("fs.truncate", path, length),
    ftruncate: (fd, length) => void callSync("fs.ftruncate", fd, length),
    copyFile: (source, destination, mode) =>
      void callSync("fs.copyFile", source, destination, mode),
    access: (path, mode) => void callSync("fs.access", path, mode),
    mkdtemp: (prefix) => callSync("fs.mkdtemp", prefix) as string,
    readFile: (path) => callSync("fs.readFile", path) as Uint8Array,
    writeFile: (path, data, flags, mode) => void callSync("fs.writeFile", path, data, flags, mode),
    open: (path, flags, mode) => callSync("fs.open", path, flags, mode) as number,
    close: (fd) => {
      callSync("fs.close", fd);
      // A pipe or terminal closed this way (the shell does) is a stream too.
      if (streamedFds.has(fd)) {
        forgetStream(fd);
      }
    },
    read: (fd, length, position) => callSync("fs.read", fd, length, position) as Uint8Array,
    readAsync: (fd, length, position) =>
      call("fs.read", fd, length, position) as Promise<Uint8Array>,
    write: (fd, data, position) => callSync("fs.write", fd, data, position) as number,
    fsync: (fd) => void callSync("fs.fsync", fd),
    watch(path, recursive, listener) {
      const watchId = callSync("fs.watch", path, recursive) as number;
      watchListeners.set(watchId, listener);
      return () => {
        if (watchListeners.delete(watchId)) {
          post("fs.unwatch", [watchId]);
        }
      };
    },
  };

  const runtime: ProcessRuntime = {
    pid: init.pid,
    ppid: init.ppid,
    argv: init.argv,
    execArgv: init.execArgv,
    env: init.env,
    cwd: init.cwd,

    fs: init.sharedFs
      ? withDirectPaths(kernelFs, init.sharedFs, () => post("fs.changed", []))
      : kernelFs,

    fdStream: {
      kind: (fd) => callSync("fd.kind", fd) as FdKind,
      readStart(fd, onChunk) {
        streamedFds.add(fd);
        fdReaders.set(fd, onChunk);
        const backlog = fdBacklogs.get(fd);
        while (backlog && backlog.length > 0) {
          if (fdReaders.get(fd) !== onChunk) {
            // The reader stopped again while catching up: the rest stays queued.
            return;
          }
          const chunk = backlog.shift()!;
          if (chunk === null) {
            // The stream had ended: the kernel's pump is done, nothing to restart.
            fdBacklogs.delete(fd);
            fdReaders.delete(fd);
            onChunk(null);
            return;
          }
          onChunk(chunk);
        }
        if (fdReaders.get(fd) !== onChunk) {
          return;
        }
        fdBacklogs.delete(fd);
        post("fd.readStart", [fd]);
      },
      readStop(fd) {
        if (fdReaders.delete(fd)) {
          if (!fdBacklogs.has(fd)) {
            fdBacklogs.set(fd, []);
          }
          post("fd.readStop", [fd]);
        }
      },
      write(fd, chunk, done) {
        if (done) {
          call("fd.write", fd, chunk).then(
            () => done(null),
            (error: Error) => done(error),
          );
        } else {
          post("fd.write", [fd, chunk]);
        }
      },
      close: forgetStream,
    },

    tty: {
      isatty(fd) {
        if (fd >= 0 && fd <= 2) {
          return init.ttyFds.includes(fd);
        }
        try {
          return callSync("fd.kind", fd) === "tty";
        } catch {
          return false;
        }
      },
      windowSize: () => ({ columns: terminal.cols, rows: terminal.rows }),
      setRawMode: (fd, enabled) => void callSync("tty.setRawMode", fd, enabled),
      onResize(listener) {
        resizeListeners.add(listener);
        return () => resizeListeners.delete(listener);
      },
    },

    processes: {
      spawn(request: SpawnRequest): ChildHandle {
        let ipc: MessagePort | null = null;
        let token: string | null = null;
        if (request.stdio.includes("ipc")) {
          const channel = new MessageChannel();
          ipc = channel.port1;
          token = `ipc:${nextToken++}`;
          post("handoff", [token, null], [channel.port2]);
        }
        const result = callSync("proc.spawn", request, token) as {
          pid: number;
          stdio: (number | null)[];
        };
        return { pid: result.pid, stdio: result.stdio, ipc };
      },
      spawnSync: (request: SpawnSyncRequest) =>
        callSync("proc.spawnSync", request) as SpawnSyncResult,
      onExit(pid, listener) {
        const status = exitedChildren.get(pid);
        if (status) {
          exitedChildren.delete(pid);
          queueMicrotask(() => listener(status));
          return;
        }
        const listeners = exitListeners.get(pid) ?? [];
        listeners.push(listener);
        exitListeners.set(pid, listeners);
      },
      pipe: () => callSync("proc.pipe") as { readFd: number; writeFd: number },
      kill: (pid, signal) => void callSync("proc.kill", pid, signal),
      exit(code): never {
        if (init.thread) {
          try {
            // Last on the thread's port, after everything it posted (THREAD_EXIT_MESSAGE).
            init.thread.port.postMessage({ type: THREAD_EXIT_MESSAGE });
          } catch {
            // The port is gone; the parent stops waiting for it.
          }
        }
        callSync("proc.exit", code);
        // The kernel stops this worker instead of answering.
        throw new Error("webnode: the process did not exit");
      },
      onSignal(listener) {
        signalListeners.push(listener);
        if (!handledSignalsSet) {
          post("proc.signals", [DEFAULT_HANDLED_SIGNALS]);
        }
      },
      setHandledSignals(signals) {
        handledSignalsSet = true;
        post("proc.signals", [signals]);
      },
    },

    net: {
      listen(port, _host, onConnection) {
        const result = callSync("net.listen", port) as { port: number; listenerId: number };
        connectionHandlers.set(result.listenerId, onConnection);
        return {
          port: result.port,
          close() {
            if (connectionHandlers.delete(result.listenerId)) {
              post("net.close", [result.listenerId]);
            }
          },
        };
      },
      async connect(port) {
        const result = (await call("net.connect", port)) as {
          port: MessagePort;
          channelId: number;
          localPort: number;
        };
        // The port the kernel labels this end with: the socket's localPort.
        return Object.assign(adoptChannel(result.channelId, result.port), {
          localPort: result.localPort,
        });
      },
    },

    threads: {
      isMainThread: init.thread === null,
      threadId: init.thread?.threadId ?? 0,
      workerData: init.thread?.workerData ?? null,
      parentPort: init.thread?.port ?? null,
      spawn(request: ThreadSpawnRequest): ThreadHandle {
        const channel = new MessageChannel();
        const token = `thread:${nextToken++}`;
        post("handoff", [token, request.workerData], [channel.port2, ...request.transferList]);
        const threadId = callSync(
          "thread.spawn",
          { ...request, workerData: null, transferList: [] },
          token,
        ) as number;
        return {
          threadId,
          port: channel.port1,
          onExit(listener) {
            const listeners = threadExitListeners.get(threadId) ?? [];
            listeners.push(listener);
            threadExitListeners.set(threadId, listeners);
          },
          terminate: () => post("thread.terminate", [threadId]),
        };
      },
    },

    ref() {
      refs += 1;
    },
    unref() {
      refs -= 1;
      if (refs <= 0) {
        refs = Math.max(refs, 0);
        for (const listener of idleListeners) {
          listener();
        }
      }
    },
  };

  const receive = (message: KernelMessage) => {
    try {
      handle(message);
    } finally {
      // The end of a task that ran user code: Node runs nextTick callbacks before promise jobs.
      runNextTicks();
    }
  };

  const handle = (message: KernelMessage) => {
    switch (message.type) {
      case "reply": {
        const pending = pendingCalls.get(message.id);
        pendingCalls.delete(message.id);
        if (message.ok) {
          pending?.resolve(message.value);
        } else {
          pending?.reject(rebuildError(message.error));
        }
        return;
      }
      case "fd-data": {
        if (closingFds.has(message.fd)) {
          // Sent for the stream this fd number had before it was closed.
          return;
        }
        const reader = fdReaders.get(message.fd);
        if (!reader) {
          fdBacklogs.get(message.fd)?.push(message.chunk);
          return;
        }
        if (message.chunk === null) {
          fdReaders.delete(message.fd);
        }
        reader(message.chunk);
        return;
      }
      case "child-exit": {
        const listeners = exitListeners.get(message.pid);
        exitListeners.delete(message.pid);
        if (listeners) {
          for (const listener of listeners) {
            listener(message.status);
          }
        } else {
          exitedChildren.set(message.pid, message.status);
        }
        return;
      }
      case "thread-exit": {
        const listeners = threadExitListeners.get(message.threadId) ?? [];
        threadExitListeners.delete(message.threadId);
        for (const listener of listeners) {
          listener(message.code);
        }
        return;
      }
      case "signal": {
        let handled = false;
        for (const listener of signalListeners) {
          handled = listener(message.signal) || handled;
        }
        if (!handled) {
          callSync("proc.die", message.signal);
        }
        return;
      }
      case "watch":
        watchListeners.get(message.watchId)?.(message.eventType, message.filename);
        return;
      case "connection": {
        const handler = connectionHandlers.get(message.listenerId);
        const channel = adoptChannel(message.channelId, message.port);
        if (handler) {
          handler(channel, { address: "127.0.0.1", port: message.remotePort });
        } else {
          channel.destroy();
        }
        return;
      }
      case "channel-dead":
        channels.get(message.channelId)?.kill();
        return;
      case "resize":
        terminal = message.terminal;
        for (const listener of resizeListeners) {
          listener();
        }
        return;
      case "init":
        return;
    }
  };

  return {
    runtime,
    receive,
    onIdle: (listener) => idleListeners.push(listener),
    refCount: () => refs,
    ipc: init.ipc,
  };
}
