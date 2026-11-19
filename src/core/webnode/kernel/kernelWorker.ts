// The kernel worker's entry: creates the kernel, answers the page's requests
// (api.ts is the other end) and forwards the kernel's events. The runtime frame
// that starts this worker (runtimeFrame.ts) hands it the port the page talks
// on. This hub only wires the page to kernel.ts and the preview gateway.
import { versionedPath } from "../buildId";
import { toSystemErrorRecord } from "../errors";
import { PreviewGateway } from "../preview/gateway";
import type {
  BootOptions,
  KernelEvent,
  MountEntry,
  PageReply,
  PageRequest,
  PageSpawnOptions,
  TerminalSize,
} from "../protocol";
import { serializeError } from "../protocol";
import { PREPARED_VERSION } from "../process/loader/preparedEntry";
import { Kernel } from "./kernel";
import type { KernelWorker } from "./kernel";
import { PagePreparedStore } from "./preparedModules";
import type { PrepareWorker } from "./preparedModules";
import { Vfs } from "./vfs/vfs";
import { createSharedFilesystem } from "../sharedfs/boot";

interface KernelScope {
  location: { href: string };
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<{ type?: string }>) => void,
  ): void;
}

const scope = globalThis as unknown as KernelScope;
/** The process worker script: this origin's own, never one the page names. */
const PROCESS_SCRIPT_URL = new URL(versionedPath("/__webnode__/process.js"), scope.location.href)
  .href;
/** The script of the worker that makes large modules' entries (process/prepareHost.ts). */
const PREPARE_SCRIPT_URL = new URL(versionedPath("/__webnode__/prepare.js"), scope.location.href)
  .href;

let page: MessagePort | null = null;
const send = (message: PageReply | KernelEvent) => page?.postMessage(message);

let kernel: Kernel | null = null;
let gateway: PreviewGateway | null = null;
/** The page's store of large modules' entries, where the page keeps one and this build names its entries. */
let preparedStore: PagePreparedStore | null = null;
let previewScript = "";

function booted(): Kernel {
  if (!kernel) {
    throw new Error("webnode: the kernel has not booted");
  }
  return kernel;
}

const methods: Record<string, (args: never, ports: readonly MessagePort[]) => unknown> = {
  boot([options]: [BootOptions]) {
    // The filesystem every worker shares, where a shared memory can be made;
    // else the one that lives here, which each process asks for every call.
    const sharedFs = options.sharedFilesystem === false ? null : createSharedFilesystem();
    const vfs = sharedFs ? sharedFs.fs : new Vfs();
    preparedStore =
      options.preparedStore && PREPARED_VERSION !== ""
        ? new PagePreparedStore(send, PREPARED_VERSION)
        : null;
    kernel = new Kernel(
      vfs,
      {
        createWorker: (name) => new Worker(PROCESS_SCRIPT_URL, { name }) as unknown as KernelWorker,
        emit: send,
        sharedFs,
        preparedStore,
        createPrepareWorker: () =>
          new Worker(PREPARE_SCRIPT_URL, { name: "webnode prepare" }) as unknown as PrepareWorker,
      },
      options.workdirName,
    );
    const running = kernel;
    gateway = new PreviewGateway({
      connect: (port) => running.connect(port),
      previewScript: () => previewScript,
      coep: options.coep,
      forwardPreviewErrors: options.forwardPreviewErrors,
      editorOrigin: options.editorOrigin,
    });
    return { workdir: kernel.workdir, path: kernel.defaultEnvironment().PATH };
  },
  mount([entries]: [MountEntry[]]) {
    booted().mount(entries);
  },
  "fs.readFile": ([path]: [string]) => booted().pageFiles.readFile(path),
  "fs.writeFile"([path, data]: [string, Uint8Array]) {
    booted().pageFiles.writeFile(path, data);
  },
  "fs.readdir": ([path]: [string]) => booted().pageFiles.readdir(path),
  "fs.mkdir": ([path, recursive]: [string, boolean]) => booted().pageFiles.mkdir(path, recursive),
  "fs.rm"([path, recursive, force]: [string, boolean, boolean]) {
    booted().pageFiles.rm(path, recursive, force);
  },
  "fs.rename"([from, to]: [string, string]) {
    booted().pageFiles.rename(from, to);
  },
  watch: ([path, recursive]: [string, boolean]) => booted().watchFromPage(path, recursive),
  unwatch([watchId]: [number]) {
    booted().unwatchFromPage(watchId);
  },
  spawn: ([command, args, options]: [string, string[], PageSpawnOptions]) =>
    booted().spawnFromPage(command, args, options),
  input([pid, data]: [number, string]) {
    booted().writeInput(pid, data);
  },
  resize([pid, size]: [number, TerminalSize]) {
    booted().resizeTerminal(pid, size);
  },
  kill([pid]: [number]) {
    booted().killTree(pid);
  },
  setPreviewScript([script]: [string]) {
    previewScript = script;
  },
  previewAttach([serverPort]: [number], ports) {
    gateway?.attach(ports[0], serverPort);
  },
  preparedEntry([ask, entry]: [number, Uint8Array | null]) {
    preparedStore?.answer(ask, entry);
  },
  teardown() {
    gateway?.dispose();
    kernel?.dispose();
    gateway = null;
    kernel = null;
    preparedStore = null;
  },
};

function answer(event: MessageEvent<PageRequest>): void {
  const { id, method, args } = event.data;
  let reply: PageReply;
  try {
    const handler = methods[method];
    if (!handler) {
      throw new Error(`webnode: unknown request "${method}"`);
    }
    const value = handler(args as never, event.ports);
    reply = { id, ok: true, value };
  } catch (error) {
    reply = { id, ok: false, error: serializeError(error, toSystemErrorRecord(error)) };
  }
  send(reply);
}

scope.addEventListener("message", (event) => {
  if (event.data.type !== "connect" || page) {
    return;
  }
  page = event.ports[0];
  page.onmessage = answer;
});
