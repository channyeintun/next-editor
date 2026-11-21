// The parts of webnode the sheet draws, and what its notes say of each. Every
// statement here is read from src/core/webnode; `source` names the file.

export type PartId =
  | "editor"
  | "kernel"
  | "gateway"
  | "fs"
  | "pm"
  | "server"
  | "preview"
  | "sw"
  | "registry";

export interface Part {
  id: PartId;
  /** The label in the part's box. */
  title: string;
  /** The lines under it in the box. */
  lines: string[];
  /** The Notes heading, where it differs from the box's shorter label. */
  noteTitle?: string;
  /** Where the part lives under src/core/webnode. */
  source: string;
  /** The Notes text. Backticks mark code. */
  detail: string;
}

// In the order the diagram tags them: note N is the part tagged N.
export const PARTS: Part[] = [
  {
    id: "editor",
    title: "editor page",
    lines: ["WebNode API: boot, mount, fs,", "spawn, on · preview bridge"],
    noteTitle: "Editor page",
    source: "api.ts, preview/pageBridge.ts",
    detail:
      "`WebNode.boot()` loads the runtime frame and gets one MessagePort to the kernel. Every `mount`, `fs.*`, `spawn` and `watch` is a numbered request on that port; `output`, `exit`, `port` and `watch` come back as events. The preview bridge answers a preview window that asks for a control port.",
  },
  {
    id: "kernel",
    title: "kernel",
    lines: [
      "owns what processes share:",
      "the process table, file descriptors,",
      "pipes, terminals, listening ports.",
      "Answers every process's calls and",
      "starts one worker per process.",
    ],
    noteTitle: "Kernel",
    source: "kernel/kernel.ts",
    detail:
      "a Web Worker started by a hidden iframe on the runtime origin. It owns what processes share: the process table, every file descriptor, pipes, terminals and the table of listening ports. It finds what a command line runs (PATH, a `#!` line, the built-in commands) and starts one Web Worker for each process.",
  },
  {
    id: "gateway",
    title: "preview gateway",
    lines: ["HTTP and WebSocket client to", "the port a process listens on"],
    noteTitle: "Preview gateway",
    source: "preview/gateway.ts",
    detail:
      "runs inside the kernel worker. For each request a service worker sends, it opens a connection to the listening process, writes the request as HTTP/1.1 and streams the response back. It is also the WebSocket client for the page's sockets.",
  },
  {
    id: "fs",
    title: "shared file system",
    lines: ["Rust → Wasm on one shared memory;", "the kernel and processes call it"],
    noteTitle: "Shared file system",
    source: "sharedfs/",
    detail:
      "a Rust module built to WebAssembly. The kernel and every process run it on the same shared memory, one call at a time under a lock, so no process has a copy of its own that could differ. Path calls (`stat`, `readFile`, `readdir`) are function calls inside the process; open files and `/dev` go through the kernel, which owns every file descriptor.",
  },
  {
    id: "pm",
    title: "process · pnpm",
    lines: ["the built-in package manager:", "installer and script runner"],
    noteTitle: "Process: pnpm",
    source: "process/programs/npm/",
    detail:
      "`npm`, `pnpm`, `yarn` and `npx` are one built-in program. It reads `package.json`, resolves the dependency graph against the registry, downloads and checks tarballs, writes `node_modules`, and runs package scripts through `sh`.",
  },
  {
    id: "server",
    title: "process · dev server",
    lines: ["node running Vite, listening", "on a port"],
    noteTitle: "Process: dev server",
    source: "process/programs/node.ts, process/node/",
    detail:
      "the `node` program in a worker of its own. JavaScript runs in the browser's engine; Node's built-in modules (`fs`, `net`, `http`, `child_process` and the rest) are written here on top of kernel calls. A call that must block, such as `execSync` or `server.listen()`, waits on `Atomics.wait` until the kernel answers.",
  },
  {
    id: "preview",
    title: "preview iframe",
    lines: ["the lesson's page, with an", "injected client script"],
    noteTitle: "Preview iframe",
    source: "preview/clientScript.ts, preview/connectPage.ts",
    detail:
      "an iframe on an origin of its own, `<session>-<port>.<host>`. The gateway puts a client script first in every HTML document: a `WebSocket` that reaches the runtime (so Vite's HMR client works), passing a new control port to the service worker, reload on request, and error reports to the editor.",
  },
  {
    id: "sw",
    title: "service worker",
    lines: ["answers the page's requests", "by asking the gateway"],
    noteTitle: "Service worker",
    source: "preview/sw.ts",
    detail:
      "answers every same-origin request of the preview by asking the gateway over a control port. It keeps the preview's cookies in a jar of its own, because a service worker's responses cannot set real cookies, with a copy in Cache Storage.",
  },
  {
    id: "registry",
    title: "npm registry",
    lines: ["registry.npmjs.org"],
    noteTitle: "npm registry",
    source: "process/programs/npm/registry.ts",
    detail:
      "the only network service in these flows. Packages come from `registry.npmjs.org` straight to the browser; no server of this project is in between.",
  },
];

export interface DesignNote {
  title: string;
  /** Backticks mark code. */
  detail: string;
}

/** Why webnode is built as it is: the notes that belong to no single part. */
export const DESIGN_NOTES: DesignNote[] = [
  {
    title: "Three origins",
    detail:
      "nothing a lesson runs is on the editor's origin. Processes run on `runtime.<host>` and each preview on `<session>-<port>.<host>`, so lesson code cannot read the editor's cookies or storage, or call its API as the visitor. The editor holds one MessagePort to the kernel and nothing else.",
  },
  {
    title: "Blocking calls",
    detail:
      "Node programs expect system calls that return a value at once. A process posts a `sync` message and sleeps on `Atomics.wait`; the kernel writes the answer into a SharedArrayBuffer and wakes it with `Atomics.notify`. This is why the page must be cross-origin isolated (COOP and COEP headers).",
  },
  {
    title: "File calls without messages",
    detail:
      "module resolution makes tens of thousands of file-system calls. As a round trip to the kernel worker each one took about 15 µs; as a function call into the shared memory it needs no message at all.",
  },
  {
    title: "A port is announced only after it stays open",
    detail:
      "the kernel accepts connections as soon as a process listens, but tells the editor 50 ms later. Vite tests its port by listening and closing at once; announcing that would send the preview to a port nothing listens on.",
  },
  {
    title: "A preview keeps working after its service worker stops",
    detail:
      "the browser stops an idle service worker, and the control port lived only in its memory. A restarted worker asks its windows for a new port (`webnode:need-port`) before it answers, so a reload after a pause loads the page once.",
  },
  {
    title: "webnode loads modules itself",
    detail:
      "each ES module is rewritten into a function and run in dependency order. A large module of an installed package (128 KB or more) is rewritten once, by a Rust rewriter in a worker of its own, and the result is kept in IndexedDB between visits.",
  },
  {
    title: "Native binaries are replaced at install",
    detail:
      "nothing native can run in a browser. `esbuild` installs as `esbuild-wasm` and `rollup` as `@rollup/wasm-node`, at the same version, and a napi-rs package gets its `wasm32-wasi` member.",
  },
  {
    title: "Scripts of two builds never run together",
    detail:
      "every script carries the id of its build and asks for the others by it. After a deploy, a host answers a request for an older build with 409, and the editor asks for a reload.",
  },
  {
    title: "Each project gets its own preview origins",
    detail:
      "a reload of the page keeps its session; any other boot makes a new one. When a session ends, the editor asks each of its preview origins to clear what its pages stored (`Clear-Site-Data`).",
  },
  {
    title: "What it runs",
    detail:
      "the Vite dev server, Vitest, the TypeScript compiler and Express, as published on npm. It is built for this project's lessons and starters, not to match all of Node.js, and it is verified in Chromium browsers only.",
  },
];

export interface MessageChannelRow {
  /** Who talks to whom. */
  channel: string;
  /** The message names, as the code spells them. */
  messages: string[];
  note: string;
}

/** The messages on each channel, from protocol.ts and preview/protocol.ts. */
export const MESSAGE_CHANNELS: MessageChannelRow[] = [
  {
    channel: "editor → kernel",
    messages: [
      "boot",
      "mount",
      "fs.readFile",
      "fs.writeFile",
      "watch",
      "spawn",
      "input",
      "resize",
      "kill",
      "previewAttach",
      "teardown",
    ],
    note: "numbered requests on one MessagePort; each gets a reply",
  },
  {
    channel: "kernel → editor",
    messages: ["output", "exit", "port", "watch", "error", "prepared-get", "prepared-put"],
    note: "events, sent without being asked",
  },
  {
    channel: "process → kernel",
    messages: ["sync", "call", "post"],
    note: "sync blocks the process until the answer; call is answered later; post has no answer",
  },
  {
    channel: "kernel → process",
    messages: ["init", "reply", "fd-data", "child-exit", "signal", "watch", "connection", "resize"],
    note: "init is the first message a process worker receives",
  },
  {
    channel: "preview ⇄ editor",
    messages: [
      "webnode:preview-connect",
      "webnode:preview-port",
      "webnode:preview-message",
      "webnode:reload",
    ],
    note: "window messages, accepted only from the editor's origin and this session's previews",
  },
  {
    channel: "preview ⇄ service worker",
    messages: ["webnode:attach", "webnode:attached", "webnode:need-port", "webnode:ws"],
    note: "passing a control port to the service worker, and opening a page's WebSocket",
  },
  {
    channel: "service worker → gateway",
    messages: ["request", "cancel", "ping", "ws-connect"],
    note: "on the control port",
  },
  {
    channel: "gateway → service worker",
    messages: ["response-head", "response-chunk", "response-end", "response-error", "pong"],
    note: "a response is streamed: head, chunks, end",
  },
  {
    channel: "gateway ⇄ page socket",
    messages: ["open", "message", "sent", "error", "close", "send"],
    note: "on the socket's own port, not through the service worker",
  },
];
