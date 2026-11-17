// The page-facing API: boot a runtime, put files in it, run commands, and learn
// when a server starts listening. The shape follows `@webcontainer/api` (boot,
// mount, fs, spawn, on, teardown, setPreviewScript), so an app written against
// that can use either.
import { BUILD_ID, versionedPath } from "./buildId";
import { systemErrorFromRecord } from "./errors";
import type { DirEntry } from "./kernel/vfs/types";
import { RUNTIME_FRAME_PATH, STALE_BUILD_MESSAGE } from "./preview/hostResponses";
import {
  createSessionId,
  isSessionId,
  parsePreviewOrigin,
  previewUrl,
  runtimeOrigin,
} from "./preview/origin";
import type { PreviewBase } from "./preview/origin";
import { createPreviewPageBridge } from "./preview/pageBridge";
import type {
  BootOptions,
  KernelEvent,
  MountEntry,
  PageReply,
  PageRequest,
  PageSpawnOptions,
  TerminalSize,
} from "./protocol";

export { reloadPreview } from "./preview/pageBridge";

/** A tree of files to mount, as `@webcontainer/api` describes one. */
export interface FileSystemTree {
  [name: string]:
    | { file: { contents: string | Uint8Array } }
    | { file: { symlink: string } }
    | { directory: FileSystemTree };
}

export interface WebNodeBootOptions {
  /**
   * Where the runtime lives. The kernel and every process run on
   * `runtime.<host>`, and each preview on `<session>-<port>.<host>`; none of
   * them is the page's own origin.
   */
  previewBase: PreviewBase;
  workdirName?: string;
  coep?: "require-corp" | "credentialless" | "none";
  forwardPreviewErrors?: boolean | "exceptions-only";
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | number | boolean>;
  output?: boolean;
  terminal?: TerminalSize;
}

export interface WebNodeProcess {
  /** Resolves with the exit code. */
  exit: Promise<number>;
  /** What the process prints, as terminal text. */
  output: ReadableStream<string>;
  /** What is typed into the process. */
  input: WritableStream<string>;
  kill(): void;
  resize(dimensions: TerminalSize): void;
}

export interface DirectoryEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface FileSystemWatcher {
  close(): void;
}

type WatchListener = (event: "rename" | "change", filename: string | Uint8Array) => void;

export interface FileSystemApi {
  readFile(path: string, encoding?: null): Promise<Uint8Array>;
  readFile(path: string, encoding: string): Promise<string>;
  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: string | { encoding?: string | null } | null,
  ): Promise<void>;
  readdir(
    path: string,
    options: { withFileTypes: true; encoding?: string | null },
  ): Promise<DirectoryEntry[]>;
  readdir(
    path: string,
    options?: string | { withFileTypes?: false; encoding?: string | null } | null,
  ): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  watch(
    path: string,
    options?:
      | string
      | { recursive?: boolean; encoding?: string | null; persistent?: boolean }
      | null
      | WatchListener,
    listener?: WatchListener,
  ): FileSystemWatcher;
}

interface Listeners {
  port: ((port: number, type: "open" | "close", url: string) => void)[];
  "server-ready": ((port: number, url: string) => void)[];
  error: ((error: { message: string }) => void)[];
  "preview-message": ((message: Record<string, unknown>) => void)[];
}

const SESSION_STORAGE_KEY = "webnode:session";
const RUNTIME_START_TIMEOUT_MS = 30000;
/** How long a frame that has loaded may take to say it is a runtime. */
const RUNTIME_READY_GRACE_MS = 5000;

interface Session {
  id: string;
  /** Gives the id up for another tab to use. */
  release(): void;
}

function storedSessionId(): string | null {
  try {
    const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
    return stored && isSessionId(stored) ? stored : null;
  } catch {
    return null;
  }
}

function storeSessionId(id: string): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  } catch {
    // Not remembered: the next boot in this tab makes a new one.
  }
}

/** Takes the lock named for session `id`; null when another tab holds it. */
function lockSession(id: string): Promise<(() => void) | null> {
  const locks = navigator.locks;
  if (!locks) {
    return Promise.resolve(() => {});
  }
  return new Promise((resolve) => {
    locks
      .request(`webnode:session:${id}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        // Held until the runtime is torn down.
        return new Promise<void>((release) => resolve(release));
      })
      .catch(() => resolve(() => {}));
  });
}

/**
 * The session id for this tab: stable across reloads, so its preview origins
 * (and their service workers) are reused. A duplicated tab starts with a copy
 * of the id; only one runtime may use it, so the other makes its own.
 */
async function claimSession(): Promise<Session> {
  let id = storedSessionId() ?? createSessionId();
  for (;;) {
    const release = await lockSession(id);
    if (release) {
      storeSessionId(id);
      return { id, release };
    }
    id = createSessionId();
  }
}

/** Loads the runtime frame and resolves with the port to its kernel. */
function startRuntimeFrame(
  base: PreviewBase,
): Promise<{ frame: HTMLIFrameElement; port: MessagePort }> {
  const origin = runtimeOrigin(base);
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.title = "webnode runtime";
  // The frame needs SharedArrayBuffer, which a cross-origin frame gets only when delegated.
  frame.setAttribute("allow", "cross-origin-isolated");
  frame.src = `${origin}${versionedPath(RUNTIME_FRAME_PATH)}`;

  return new Promise((resolve, reject) => {
    const fail = (message: string) => {
      cleanup();
      frame.remove();
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail(`webnode: the runtime at ${origin} did not start`),
      RUNTIME_START_TIMEOUT_MS,
    );
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    // A host that is not serving the runtime (switched off, or another site's
    // page) loads something that never answers: say so soon, not after the
    // whole start timeout.
    const onLoad = () => {
      clearTimeout(graceTimer);
      graceTimer = setTimeout(
        () => fail(`webnode: ${origin} did not answer as a runtime`),
        RUNTIME_READY_GRACE_MS,
      );
    };
    const onMessage = (
      event: MessageEvent<{ type?: string; message?: string; buildId?: string }>,
    ) => {
      if (event.origin !== origin || event.source !== frame.contentWindow) {
        return;
      }
      if (event.data?.type === "webnode:runtime-ready" && event.ports[0]) {
        const theirs = event.data.buildId;
        if (BUILD_ID && theirs && theirs !== BUILD_ID) {
          fail(`webnode: ${STALE_BUILD_MESSAGE}`);
          return;
        }
        cleanup();
        resolve({ frame, port: event.ports[0] });
      } else if (event.data?.type === "webnode:runtime-error") {
        fail(`webnode: ${event.data.message ?? "the runtime failed to start"}`);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      frame.removeEventListener("load", onLoad);
      window.removeEventListener("message", onMessage);
    };
    frame.addEventListener("load", onLoad);
    window.addEventListener("message", onMessage);
    document.body.append(frame);
  });
}

function flattenTree(tree: FileSystemTree, directory: string, entries: MountEntry[]): void {
  const encoder = new TextEncoder();
  for (const [name, node] of Object.entries(tree)) {
    const path = `${directory}/${name}`;
    if ("directory" in node) {
      entries.push({ path, directory: true });
      flattenTree(node.directory, path, entries);
    } else if ("contents" in node.file) {
      const { contents } = node.file;
      entries.push({
        path,
        data: typeof contents === "string" ? encoder.encode(contents) : contents,
      });
    } else {
      throw new Error(`webnode: mounting a symlink (${path}) is not supported`);
    }
  }
}

/** A running runtime. Create one with `WebNode.boot`. */
export class WebNode {
  readonly fs: FileSystemApi;
  /** The directory the project is mounted in. */
  readonly workdir: string;
  /** The PATH processes start with. */
  readonly path: string;

  private readonly frame: HTMLIFrameElement;
  private readonly kernel: MessagePort;
  private readonly previewBase: PreviewBase;
  private readonly session: Session;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners: Listeners = {
    port: [],
    "server-ready": [],
    error: [],
    "preview-message": [],
  };
  private readonly processes = new Map<
    number,
    { output: ReadableStreamDefaultController<string> | null; exit: (code: number) => void }
  >();
  private readonly watchers = new Map<number, WatchListener>();
  private readonly bridge: { dispose(): void };
  private nextRequestId = 1;
  private tornDown = false;

  private constructor(
    runtime: { frame: HTMLIFrameElement; port: MessagePort },
    session: Session,
    previewBase: PreviewBase,
    booted: { workdir: string; path: string },
  ) {
    this.frame = runtime.frame;
    this.kernel = runtime.port;
    this.previewBase = previewBase;
    this.session = session;
    this.workdir = booted.workdir;
    this.path = booted.path;
    this.fs = this.createFileSystem();
    this.bridge = createPreviewPageBridge({
      serverPortForOrigin: (origin) => {
        const parsed = parsePreviewOrigin(origin, this.previewBase);
        return parsed && parsed.sessionId === this.session.id ? parsed.port : null;
      },
      openControlPort: (serverPort, port) => {
        void this.request("previewAttach", [serverPort], [port]);
      },
      onPreviewMessage: (message) => {
        for (const listener of this.listeners["preview-message"]) {
          listener(message);
        }
      },
    });
  }

  /** Starts a runtime. The page must be cross-origin isolated. */
  static async boot(options: WebNodeBootOptions): Promise<WebNode> {
    if (typeof SharedArrayBuffer === "undefined" || !globalThis.crossOriginIsolated) {
      throw new Error("webnode needs a cross-origin isolated page (COOP and COEP headers)");
    }
    const session = await claimSession();
    let runtime: { frame: HTMLIFrameElement; port: MessagePort };
    try {
      runtime = await startRuntimeFrame(options.previewBase);
    } catch (error) {
      session.release();
      throw error;
    }

    const boot: BootOptions = {
      workdirName: options.workdirName ?? "project",
      coep: options.coep ?? "require-corp",
      forwardPreviewErrors: options.forwardPreviewErrors ?? false,
      editorOrigin: window.location.origin,
    };
    const { port } = runtime;
    const origin = runtimeOrigin(options.previewBase);
    const booted = await new Promise<{ workdir: string; path: string }>((resolve, reject) => {
      // The frame says it is ready before its kernel worker has loaded. A
      // kernel that never loads (its script refused or unreachable) answers
      // nothing, so the wait ends on the frame's report or on a timeout.
      const settle = () => {
        clearTimeout(timer);
        window.removeEventListener("message", onFrameMessage);
      };
      const timer = setTimeout(() => {
        settle();
        reject(new Error(`webnode: the kernel at ${origin} did not answer`));
      }, RUNTIME_START_TIMEOUT_MS);
      const onFrameMessage = (event: MessageEvent<{ type?: string; message?: string }>) => {
        if (event.origin !== origin || event.source !== runtime.frame.contentWindow) {
          return;
        }
        if (event.data?.type === "webnode:runtime-error") {
          settle();
          reject(new Error(`webnode: ${event.data.message ?? "the kernel failed to start"}`));
        }
      };
      window.addEventListener("message", onFrameMessage);
      port.onmessage = (event: MessageEvent<PageReply>) => {
        if (event.data.id !== 0) {
          return;
        }
        settle();
        if (event.data.ok) {
          resolve(event.data.value as { workdir: string; path: string });
        } else {
          reject(new Error(event.data.error.message));
        }
      };
      port.postMessage({ id: 0, method: "boot", args: [boot] } satisfies PageRequest);
    }).catch((error: unknown) => {
      runtime.frame.remove();
      session.release();
      throw error;
    });

    const instance = new WebNode(runtime, session, options.previewBase, booted);
    port.onmessage = (event: MessageEvent<PageReply | KernelEvent>) => instance.receive(event.data);
    return instance;
  }

  /** Writes a tree of files into the working directory (or `mountPoint` inside it). */
  async mount(tree: FileSystemTree, options?: { mountPoint?: string }): Promise<void> {
    const root = options?.mountPoint
      ? `${this.workdir}/${options.mountPoint.replace(/^\/+|\/+$/g, "")}`
      : this.workdir;
    const entries: MountEntry[] = [];
    flattenTree(tree, root, entries);
    await this.request("mount", [entries]);
  }

  /** Starts `command`. Rejects when the command does not exist. */
  async spawn(
    command: string,
    argsOrOptions?: string[] | SpawnOptions,
    maybeOptions?: SpawnOptions,
  ): Promise<WebNodeProcess> {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) ?? {};
    const pageOptions: PageSpawnOptions = {
      cwd: options.cwd,
      env: options.env,
      output: options.output,
      terminal: options.terminal,
    };
    const pid = (await this.request("spawn", [command, args, pageOptions])) as number;

    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const record: {
      output: ReadableStreamDefaultController<string> | null;
      exit: (code: number) => void;
    } = { output: null, exit: resolveExit };
    this.processes.set(pid, record);

    const output = new ReadableStream<string>({
      start(controller) {
        record.output = controller;
      },
      cancel() {
        record.output = null;
      },
    });
    const input = new WritableStream<string>({
      write: (chunk) => {
        void this.request("input", [pid, chunk]);
      },
    });

    return {
      exit,
      output,
      input,
      kill: () => {
        void this.request("kill", [pid]).catch(() => {});
      },
      resize: (dimensions) => {
        void this.request("resize", [pid, dimensions]).catch(() => {});
      },
    };
  }

  /** Listens for an event. Returns the function that stops listening. */
  on<Event extends keyof Listeners>(event: Event, listener: Listeners[Event][number]): () => void {
    const list = this.listeners[event] as Listeners[Event][number][];
    list.push(listener);
    return () => {
      const index = list.indexOf(listener);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }

  /** Sets JavaScript that every previewed HTML document runs first. */
  async setPreviewScript(script: string): Promise<void> {
    await this.request("setPreviewScript", [script]);
  }

  /** Stops every process and discards the filesystem. */
  teardown(): void {
    if (this.tornDown) {
      return;
    }
    this.tornDown = true;
    this.bridge.dispose();
    this.kernel.postMessage({ id: -1, method: "teardown", args: [] } satisfies PageRequest);
    this.kernel.close();
    // Removing the frame ends the kernel worker and every process worker it started.
    this.frame.remove();
    this.session.release();
    for (const { reject } of this.pending.values()) {
      reject(new Error("webnode: the runtime was torn down"));
    }
    this.pending.clear();
    for (const process of this.processes.values()) {
      try {
        process.output?.close();
      } catch {
        // Already closed or cancelled.
      }
    }
    this.processes.clear();
  }

  private request(
    method: string,
    args: unknown[],
    transfer: Transferable[] = [],
  ): Promise<unknown> {
    if (this.tornDown) {
      return Promise.reject(new Error("webnode: the runtime was torn down"));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      this.pending.set(id, { resolve, reject });
      this.kernel.postMessage({ id, method, args } satisfies PageRequest, transfer);
    });
  }

  private receive(message: PageReply | KernelEvent): void {
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!pending) {
        return;
      }
      if (message.ok) {
        pending.resolve(message.value);
      } else if (message.error.system) {
        pending.reject(systemErrorFromRecord(message.error.system));
      } else {
        pending.reject(
          Object.assign(new Error(message.error.message), { name: message.error.name }),
        );
      }
      return;
    }

    switch (message.event) {
      case "output":
        try {
          this.processes.get(message.pid)?.output?.enqueue(message.data);
        } catch {
          // The reader went away.
        }
        return;
      case "exit": {
        const process = this.processes.get(message.pid);
        this.processes.delete(message.pid);
        try {
          process?.output?.close();
        } catch {
          // Already closed or cancelled.
        }
        process?.exit(message.code);
        return;
      }
      case "port": {
        const url = previewUrl(this.previewBase, this.session.id, message.port);
        for (const listener of this.listeners.port) {
          listener(message.port, message.type, url);
        }
        if (message.type === "open") {
          for (const listener of this.listeners["server-ready"]) {
            listener(message.port, url);
          }
        }
        return;
      }
      case "watch":
        this.watchers.get(message.watchId)?.(message.eventType, message.filename);
        return;
      case "error":
        for (const listener of this.listeners.error) {
          listener({ message: message.message });
        }
        return;
    }
  }

  private createFileSystem(): FileSystemApi {
    const decode = (bytes: Uint8Array, encoding: string) => new TextDecoder(encoding).decode(bytes);
    const fs = {
      readFile: async (path: string, encoding?: string | null) => {
        const bytes = (await this.request("fs.readFile", [path])) as Uint8Array;
        return encoding ? decode(bytes, encoding) : bytes;
      },
      writeFile: async (path: string, data: string | Uint8Array) => {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        await this.request("fs.writeFile", [path, bytes]);
      },
      readdir: async (
        path: string,
        options?: string | { withFileTypes?: boolean; encoding?: string | null } | null,
      ) => {
        const entries = (await this.request("fs.readdir", [path])) as DirEntry[];
        if (typeof options === "object" && options?.withFileTypes) {
          return entries.map((entry): DirectoryEntry => ({
            name: entry.name,
            isFile: () => entry.type === "file",
            isDirectory: () => entry.type === "dir",
          }));
        }
        return entries.map((entry) => entry.name);
      },
      mkdir: async (path: string, options?: { recursive?: boolean }) =>
        (await this.request("fs.mkdir", [path, options?.recursive === true])) as string | undefined,
      rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
        await this.request("fs.rm", [path, options?.recursive === true, options?.force === true]);
      },
      rename: async (oldPath: string, newPath: string) => {
        await this.request("fs.rename", [oldPath, newPath]);
      },
      watch: (
        path: string,
        optionsOrListener?:
          | string
          | { recursive?: boolean; encoding?: string | null; persistent?: boolean }
          | null
          | WatchListener,
        maybeListener?: WatchListener,
      ): FileSystemWatcher => {
        const listener =
          typeof optionsOrListener === "function" ? optionsOrListener : maybeListener;
        const recursive =
          typeof optionsOrListener === "object" && optionsOrListener?.recursive === true;
        let watchId: number | null = null;
        let closed = false;
        void this.request("watch", [path, recursive]).then(
          (id) => {
            watchId = id as number;
            if (closed) {
              void this.request("unwatch", [watchId]).catch(() => {});
            } else if (listener) {
              this.watchers.set(watchId, listener);
            }
          },
          () => {},
        );
        return {
          close: () => {
            closed = true;
            if (watchId !== null) {
              this.watchers.delete(watchId);
              void this.request("unwatch", [watchId]).catch(() => {});
            }
          },
        };
      },
    };
    return fs as FileSystemApi;
  }
}
