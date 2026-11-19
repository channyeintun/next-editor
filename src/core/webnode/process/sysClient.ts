// A process's end of its link to the kernel: the `ProcessRuntime` every builtin
// and program uses, implemented with blocking calls (the worker waits on a
// shared buffer while the kernel answers), calls answered by message, and the
// events the kernel sends back. kernel/kernel.ts is the other end.
import { createPortChannel } from "../byteChannel";
import { createSystemError, systemErrorFromRecord } from "../errors";
import { decodePayload, readSyncAnswer } from "../kernel/codec";
import { PIPE_CAPACITY } from "../kernel/streams";
import type { DirEntry, StatData } from "../kernel/vfs/types";
import { postIpcExit } from "./node/internal/ipcEnvelope";
import { runMacrotask } from "./node/eventLoop";
import { postThreadMessage, THREAD_EXIT_MESSAGE } from "./node/worker_threads";
import type { KernelMessage, ProcessInit, ProcessMessage, SerializedError } from "../protocol";
import { withDirectPaths } from "../sharedfs/processBackend";
import { readUmask, writeUmask } from "../umask";
import {
  SYNC_BROKEN,
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

/**
 * The bytes a worker hands the kernel for one fd without waiting, before it
 * waits for the kernel to say they are in: what a pipe holds. However slow
 * the reader, the kernel holds no more than this per writer beyond the pipe.
 */
const WRITE_BUDGET = PIPE_CAPACITY;
/**
 * The writes a worker hands over for one fd before it waits for the kernel,
 * however small: a loop of tiny writes would otherwise queue thousands of
 * messages the kernel must work through before anything else this worker
 * sends, a reader's request included.
 */
const WRITE_COUNT_BUDGET = 256;

/** Captured now: the `node` program replaces the global one. */
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

/** What this worker wrote to one fd. */
interface WriteState {
  /** Bytes handed to the kernel. */
  sent: number;
  /** Bytes known to be in: what was sent up to a write the kernel said was in. */
  confirmed: number;
  /** Writes handed over without waiting, and how many of them are known to be in. */
  handedOver: number;
  handedOverIn: number;
  /**
   * The next write asks the kernel, and waits for its answer: at first, and
   * after a pipe this worker writes to lost its reader, so a write to a
   * broken pipe fails (EPIPE) instead of going nowhere unnoticed.
   */
  doubtful: boolean;
}

/**
 * `bytes` as a message should carry them. A message takes the whole buffer a
 * view looks into and shares a buffer that is shared, so a view of part of a
 * buffer (a `Buffer` from the pool, a slice of a file's bytes, what a zlib
 * stream emits) or of shared memory goes as a copy of just its bytes. Not
 * with the view's own `slice`: a `Buffer`'s returns another view.
 */
function ownBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteLength === bytes.buffer.byteLength &&
    !(bytes.buffer instanceof SharedArrayBuffer)
    ? bytes
    : new Uint8Array(bytes);
}

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
        const previous = header;
        header = new Int32Array(buffer, 0, SYNC_HEADER_BYTES / 4);
        // The kernel writes its count of broken pipes here from now on.
        Atomics.store(header, SYNC_BROKEN, Atomics.load(previous, SYNC_BROKEN));
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

  /**
   * Writes all of `chunk` with blocking writes, answered once the bytes are
   * in. A pipe whose reader goes away mid-write answers with the bytes that
   * went in; the next write then fails with EPIPE.
   */
  const writeAll = (fd: number, chunk: Uint8Array): void => {
    for (let offset = 0; offset < chunk.byteLength;) {
      const written = callSync("fs.write", fd, chunk.subarray(offset), null) as number;
      if (!(written > 0)) {
        return;
      }
      offset += written;
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
  /**
   * Asks the kernel `op`, a call, and runs `answered` as its answer is
   * handled: after every message the kernel sent before it handled the
   * call, and before the next. "mark" asks for nothing but that point.
   */
  const afterAnswer = (op: string, args: unknown[], answered: () => void): void => {
    const id = nextCallId++;
    pendingCalls.set(id, { resolve: answered, reject: answered });
    scope.postMessage({ type: "call", id, op, args });
  };

  /** Names each read this worker may give up (`readAsync` with a signal). */
  let nextReadToken = 1;

  const writeStates = new Map<number, WriteState>();
  /** The kernel's count of broken pipes (`SYNC_BROKEN`) when this worker last looked. */
  let brokenSeen = Atomics.load(header, SYNC_BROKEN);
  /** This worker's account of `fd`'s writes, checked against the kernel's count of broken pipes. */
  const writeStateOf = (fd: number): WriteState => {
    const broken = Atomics.load(header, SYNC_BROKEN);
    if (broken !== brokenSeen) {
      brokenSeen = broken;
      for (const state of writeStates.values()) {
        state.doubtful = true;
      }
    }
    let state = writeStates.get(fd);
    if (!state) {
      state = { sent: 0, confirmed: 0, handedOver: 0, handedOverIn: 0, doubtful: true };
      writeStates.set(fd, state);
    }
    return state;
  };

  let refs = 0;
  const idleListeners: (() => void)[] = [];

  const watchListeners = new Map<number, (eventType: "rename" | "change", name: string) => void>();
  const fdReaders = new Map<number, (chunk: Uint8Array | null) => void>();
  /**
   * What reached a stopped fd and waits here for its next reader: a
   * terminal's input, which the kernel had taken from the terminal when it
   * learned of the `readStop`, and the end of a stream. The next `readStart`
   * gets them first. A pipe's bytes never wait here: they go back to the
   * pipe (`giveBack`).
   */
  const fdBacklogs = new Map<number, (Uint8Array | null)[]>();
  /**
   * Fds whose backlog came from a terminal. The kernel has not been told that
   * those chunks reached a reader (`fd.ack`): it gives them back to the
   * terminal if this process ends or closes the fd before one takes them.
   */
  const typedBacklogs = new Set<number>();
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
   * Fds given back to their pipe (`giveBack`) whose `fd.unread` the kernel
   * has not yet answered, with how many: data that arrives for them before
   * the answer was on its way, and the kernel has put it back in the pipe.
   */
  const unreadFds = new Map<number, number>();

  /**
   * Gives pipe `fd` back `chunks`, which a reader here took and did not use,
   * and with them everything the kernel sent for `fd` that no reader here was
   * handed: the kernel puts all of it back in the pipe, in order, for the
   * next reader. What arrives for `fd` until the kernel answers is part of
   * that, and is dropped.
   */
  const giveBack = (fd: number, chunks: Uint8Array[]): void => {
    unreadFds.set(fd, (unreadFds.get(fd) ?? 0) + 1);
    const answered = () => {
      const left = (unreadFds.get(fd) ?? 1) - 1;
      if (left > 0) {
        unreadFds.set(fd, left);
      } else {
        unreadFds.delete(fd);
      }
    };
    afterAnswer("fd.unread", [fd, chunks], answered);
  };

  /**
   * Drops what is known of the stream on `fd` and refuses data for that
   * number until the kernel has answered: whatever arrives before that was
   * sent for the stream the number had. With `open` the fd is still open and
   * the request closes it. Otherwise the caller has closed it already, and
   * the request only marks the point: it must not close the number, which a
   * thread of this process may have been given since.
   */
  const forgetStream = (fd: number, open: boolean): void => {
    streamedFds.delete(fd);
    fdReaders.delete(fd);
    fdBacklogs.delete(fd);
    typedBacklogs.delete(fd);
    writeStates.delete(fd);
    closingFds.set(fd, (closingFds.get(fd) ?? 0) + 1);
    const confirmed = () => {
      const left = (closingFds.get(fd) ?? 1) - 1;
      if (left > 0) {
        closingFds.set(fd, left);
      } else {
        closingFds.delete(fd);
      }
    };
    if (open) {
      afterAnswer("fd.close", [fd], confirmed);
    } else {
      afterAnswer("mark", [], confirmed);
    }
  };
  const exitListeners = new Map<number, ((status: ExitStatus) => void)[]>();
  const exitedChildren = new Map<number, ExitStatus>();
  const threadExitListeners = new Map<number, ((code: number) => void)[]>();
  const signalListeners: ((signal: string, fromTerminal: boolean) => boolean)[] = [];
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
    mkdir: (path, recursive, mode, floor) =>
      callSync("fs.mkdir", path, recursive, mode, floor) as string | undefined,
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
    writeFile: (path, data, flags, mode) =>
      void callSync("fs.writeFile", path, ownBytes(data), flags, mode),
    open: (path, flags, mode) => callSync("fs.open", path, flags, mode) as number,
    close: (fd) => {
      callSync("fs.close", fd);
      writeStates.delete(fd);
      // A pipe or terminal closed this way (the shell does) is a stream too.
      if (streamedFds.has(fd)) {
        forgetStream(fd, false);
      }
    },
    read: (fd, length, position) => callSync("fs.read", fd, length, position) as Uint8Array,
    readAsync: (fd, length, position, signal) => {
      if (!signal) {
        return call("fs.read", fd, length, position) as Promise<Uint8Array>;
      }
      // The kernel knows the read by this token until it has answered it.
      const token = nextReadToken++;
      const read = call("fs.read", fd, length, position, token) as Promise<Uint8Array>;
      const withdraw = () => post("fs.readCancel", [token]);
      if (signal.aborted) {
        withdraw();
        return read;
      }
      signal.addEventListener("abort", withdraw, { once: true });
      const answered = () => signal.removeEventListener("abort", withdraw);
      read.then(answered, answered);
      return read;
    },
    write: (fd, data, position) => callSync("fs.write", fd, ownBytes(data), position) as number,
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

  // Those of a new process once this one has gone on as one (`forkAndExit`).
  let pid = init.pid;
  let ppid = init.ppid;

  const runtime: ProcessRuntime = {
    get pid() {
      return pid;
    },
    get ppid() {
      return ppid;
    },
    argv: init.argv,
    execArgv: init.execArgv,
    env: init.env,
    cwd: init.cwd,
    // The process's one mask, where its threads and the kernel read it too.
    get umask() {
      return readUmask(init.umask);
    },
    set umask(mask: number) {
      writeUmask(init.umask, mask);
    },
    inheritedFds: init.inheritedFds,

    fs: init.sharedFs
      ? withDirectPaths(
          kernelFs,
          init.sharedFs,
          () => post("fs.changed", []),
          () => readUmask(init.umask),
        )
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
            typedBacklogs.delete(fd);
            fdReaders.delete(fd);
            onChunk(null);
            return;
          }
          if (typedBacklogs.has(fd)) {
            post("fd.ack", [fd, chunk.byteLength]);
          }
          onChunk(chunk);
        }
        if (fdReaders.get(fd) !== onChunk) {
          return;
        }
        fdBacklogs.delete(fd);
        typedBacklogs.delete(fd);
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
      unread(fd, bytes) {
        runtime.fdStream.readStop(fd);
        if (!streamedFds.has(fd) && bytes.byteLength === 0) {
          // Never read as a stream: nothing is held here or on its way.
          return;
        }
        if (streamedFds.has(fd)) {
          // An end that waited here is dropped: the pipe ends again once
          // these bytes are read.
          fdBacklogs.set(fd, []);
        }
        giveBack(fd, bytes.byteLength > 0 ? [ownBytes(bytes)] : []);
      },
      write(fd, written, done) {
        if (written.byteLength === 0) {
          // As write(2) of no bytes: it succeeds whatever became of the
          // reader. Nothing is sent, so nothing is learned about the pipe:
          // the write after it asks the kernel if this one would have.
          done?.(null);
          return;
        }
        const chunk = ownBytes(written);
        const state = writeStateOf(fd);
        const length = chunk.byteLength;
        if (
          !state.doubtful &&
          state.sent - state.confirmed + length <= WRITE_BUDGET &&
          state.handedOver - state.handedOverIn < WRITE_COUNT_BUDGET
        ) {
          // Handed over without waiting, as a write that fits a pipe returns
          // at once; the kernel puts it in, in order, and keeps it when this
          // process ends first.
          post("fd.write", [fd, chunk]);
          state.sent += length;
          state.handedOver += 1;
          done?.(null);
          return;
        }
        const end = (state.sent += length);
        const handedOver = state.handedOver;
        const seen = brokenSeen;
        /** The kernel put the bytes in: so is everything handed over before. */
        const confirm = () => {
          state.confirmed = Math.max(state.confirmed, end);
          state.handedOverIn = Math.max(state.handedOverIn, handedOver);
          // Unless a pipe broke meanwhile, the writes that follow need not ask.
          if (Atomics.load(header, SYNC_BROKEN) === seen) {
            state.doubtful = false;
          }
        };
        if (!done) {
          // A blocking write, as write(2) is: it returns once the bytes are in.
          try {
            writeAll(fd, chunk);
          } catch (error) {
            state.doubtful = true;
            throw error;
          }
          confirm();
          return;
        }
        // As libuv's uv_write: the process goes on, and `done` runs once the
        // bytes are in.
        call("fd.write", fd, chunk).then(
          () => {
            confirm();
            done(null);
          },
          (error: Error) => {
            state.doubtful = true;
            done(error);
          },
        );
      },
      reportWriteError(_fd, error, done) {
        // `done` runs as the macrotask of the kernel's answer, after every
        // message the kernel sent before. The report is work the process
        // still has to do: it holds the process until `done` has run,
        // however long the kernel takes to answer.
        runtime.ref();
        afterAnswer("mark", [], () => {
          try {
            done(error);
          } finally {
            runtime.unref();
          }
        });
      },
      close: (fd) => forgetStream(fd, true),
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
      // A post: kept in order with the calls that follow it.
      unread: (fd, bytes) => post("tty.unread", [fd, ownBytes(bytes)]),
      reclaim: (fd) => post("tty.reclaim", [fd]),
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
          // A macrotask, as the exit's own message is: its ticks run before promise jobs.
          nativeSetTimeout(() => runMacrotask(() => listener(status)), 0);
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
            postThreadMessage(init.thread.port, { type: THREAD_EXIT_MESSAGE });
          } catch {
            // The port is gone; the parent stops waiting for it.
          }
        }
        if (init.ipc) {
          // Last on the IPC channel, after every message this process sent
          // (internal/ipcEnvelope.ts `postIpcExit`). A closed port takes nothing.
          postIpcExit(init.ipc);
        }
        callSync("proc.exit", code);
        // The kernel stops this worker instead of answering.
        throw new Error("webnode: the process did not exit");
      },
      forkAndExit(status) {
        if (init.thread) {
          throw createSystemError("EINVAL", "fork");
        }
        if (init.ipc) {
          // The channel is the process that ends: its last message goes
          // first, as at its exit.
          postIpcExit(init.ipc);
        }
        const next = callSync("proc.forkAndExit", status) as { pid: number; ppid: number };
        pid = next.pid;
        ppid = next.ppid;
        return pid;
      },
      // A post, in order after this worker's writes; the kernel stops the worker.
      die: (signal) => post("proc.die", [signal]),
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

    prepared: {
      locate: (filename) => callSync("module.prepared", filename) as string | null,
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

  // Each message is a macrotask: the nextTick callbacks it queues run as it returns.
  const receive = (message: KernelMessage) => runMacrotask(() => handle(message));

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
        if (closingFds.has(message.fd) || unreadFds.has(message.fd)) {
          // Sent for the stream this fd number had before it was closed, or
          // before it was given back; the kernel put it back in the pipe or
          // the terminal.
          return;
        }
        const reader = fdReaders.get(message.fd);
        if (message.counted && message.chunk) {
          if (!reader) {
            // A stopped reader takes nothing: the kernel had sent this before
            // it learned of the `readStop`, and read(2) would have left it
            // in the pipe. Kept and acknowledged here it would free its room
            // in the pipe, and a reader that stops after every line (a
            // shell's `read`) would let its writer run a pipe's worth
            // further ahead with each one.
            if (fdBacklogs.has(message.fd)) {
              giveBack(message.fd, []);
            }
            return;
          }
          // Handed over: the pipe has room for more. Said before the reader
          // runs, which may end the process.
          post("fd.ack", [message.fd, message.chunk.byteLength]);
        }
        if (!reader) {
          const backlog = fdBacklogs.get(message.fd);
          backlog?.push(message.chunk);
          if (backlog && message.typed) {
            // Not this process's until a reader takes it (`readStart`).
            typedBacklogs.add(message.fd);
          }
          return;
        }
        if (message.chunk === null) {
          fdReaders.delete(message.fd);
        } else if (message.typed) {
          // Handed over: said before the reader runs, which may end the process.
          post("fd.ack", [message.fd, message.chunk.byteLength]);
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
          handled = listener(message.signal, message.fromTerminal === true) || handled;
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
