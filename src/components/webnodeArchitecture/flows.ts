// The flows the webnode sheet plays: for each one, the steps a message takes
// through the parts. Every step is read from src/core/webnode (api.ts,
// protocol.ts, kernel/kernel.ts, preview/sw.ts, preview/gateway.ts,
// process/programs/npm) and from how the editor drives it (src/runtime/node,
// src/contexts/useNodeRuntimeSession.ts).
import type { PartId } from "./parts";

/**
 * What kind of message a mark stands for. A `call` is not a message at all: a
 * function call into the shared file system, in the caller's own thread.
 */
export type MessageKind = "request" | "response" | "event" | "call";

/** The kinds, in the order the legend lists them. */
export const MESSAGE_KINDS: MessageKind[] = ["request", "response", "event", "call"];

export const MESSAGE_KIND_LABELS: Record<MessageKind, string> = {
  request: "request",
  response: "response",
  event: "event",
  call: "direct call",
};

/** One message, from one part through one or more others. */
export interface Move {
  kind: MessageKind;
  from: PartId;
  /** Each part it reaches, with the name the message has on that line. */
  hops: { to: PartId; label: string }[];
}

export interface FlowStep {
  /** The caption: one short sentence. Backticks mark code. */
  title: string;
  /** The longer text of the step list. Backticks mark code. */
  detail: string;
  /** The messages that move in this step, at the same time. */
  moves: Move[];
}

export interface Flow {
  id: string;
  name: string;
  summary: string;
  steps: FlowStep[];
}

export const FLOWS: Flow[] = [
  {
    id: "boot",
    name: "Boot",
    summary: "The editor starts a runtime and puts the project's files in it.",
    steps: [
      {
        title: "The editor starts the kernel and sends `boot`.",
        detail:
          "`WebNode.boot()` adds a hidden iframe on the runtime origin. The frame starts the kernel worker and posts one MessagePort back to the editor. The editor sends its first request on it.",
        moves: [{ kind: "request", from: "editor", hops: [{ to: "kernel", label: "boot" }] }],
      },
      {
        title: "The kernel creates the file system.",
        detail:
          "It makes one shared WebAssembly memory and starts the Rust file-system module on it. Every process worker will later run the same module on the same memory.",
        moves: [{ kind: "call", from: "kernel", hops: [{ to: "fs", label: "fs_init" }] }],
      },
      {
        title: "The kernel answers with the working directory.",
        detail:
          "The reply carries the directory the project lives in, under `/home/projects`, and the PATH that processes start with.",
        moves: [{ kind: "response", from: "kernel", hops: [{ to: "editor", label: "reply" }] }],
      },
      {
        title: "The editor mounts the project.",
        detail: "`mount` sends every file of the project as a path and its bytes.",
        moves: [{ kind: "request", from: "editor", hops: [{ to: "kernel", label: "mount" }] }],
      },
      {
        title: "The kernel writes the files.",
        detail:
          "From here the editor keeps both copies the same: it writes its own changes with `fs.writeFile`, and a `watch` tells it what the processes change.",
        moves: [{ kind: "call", from: "kernel", hops: [{ to: "fs", label: "writeFile" }] }],
      },
    ],
  },
  {
    id: "install",
    name: "Install packages",
    summary:
      "`pnpm install` runs as a process in a Web Worker and talks to the npm registry from the browser.",
    steps: [
      {
        title: "The editor asks the kernel to run the install command.",
        detail:
          '`spawn` carries the command line, `sh -lc "pnpm install"`. The kernel finds what it names and gives the process a terminal. The reply is the process id.',
        moves: [{ kind: "request", from: "editor", hops: [{ to: "kernel", label: "spawn" }] }],
      },
      {
        title: "The kernel starts a Web Worker for the process.",
        detail:
          "The worker's first message, `init`, carries the process id, arguments, environment, a SharedArrayBuffer for blocking calls, and the process's way into the shared file system. The shell starts `pnpm` in the same way.",
        moves: [{ kind: "event", from: "kernel", hops: [{ to: "pm", label: "init" }] }],
      },
      {
        title: "pnpm asks the registry what to install.",
        detail:
          "It reads `package.json` and fetches package metadata, about 16 requests at a time, until the whole dependency graph is known. A package with a native binary is replaced by its WebAssembly build here.",
        moves: [{ kind: "request", from: "pm", hops: [{ to: "registry", label: "GET package" }] }],
      },
      {
        title: "Tarballs come back and are checked.",
        detail:
          "Tarballs download about 8 at a time. Each one is checked against the integrity hash the registry lists, and a tarball that passes is kept in Cache Storage for the next install.",
        moves: [{ kind: "response", from: "registry", hops: [{ to: "pm", label: "tarball" }] }],
      },
      {
        title: "pnpm writes `node_modules` itself.",
        detail:
          "It unpacks each tarball and writes the files with direct calls into the shared file system: no message to the kernel for each file. Then it links the commands in `.bin` and runs the project's own install scripts.",
        moves: [{ kind: "call", from: "pm", hops: [{ to: "fs", label: "writeFile" }] }],
      },
      {
        title: "Output and the exit code go back to the editor.",
        detail:
          "What pnpm prints goes to the process's terminal in the kernel, which sends `output` events to the editor's terminal panel. When pnpm ends, an `exit` event carries its code, and the editor runs the next command.",
        moves: [
          {
            kind: "event",
            from: "pm",
            hops: [
              { to: "kernel", label: "fd.write" },
              { to: "editor", label: "output, exit" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "serve",
    name: "Start the dev server",
    summary: "`pnpm dev` starts Vite. When Vite listens on a port, the editor gets a preview URL.",
    steps: [
      {
        title: "The editor runs the dev command.",
        detail:
          "Another `spawn`. `pnpm dev` runs the package's script through `sh`, which starts `node` with Vite.",
        moves: [{ kind: "request", from: "editor", hops: [{ to: "kernel", label: "spawn" }] }],
      },
      {
        title: "The kernel starts each process in a worker of its own.",
        detail:
          "The shell, pnpm and `node` are three processes, so three Web Workers. Each gets an `init` message.",
        moves: [{ kind: "event", from: "kernel", hops: [{ to: "server", label: "init" }] }],
      },
      {
        title: "Vite loads its code from `node_modules`.",
        detail:
          "webnode's own module loader reads each file with a direct call into the shared file system, rewrites ES modules into functions, and runs them in dependency order.",
        moves: [{ kind: "call", from: "server", hops: [{ to: "fs", label: "readFile" }] }],
      },
      {
        title: "Vite listens on a port.",
        detail:
          "`server.listen()` is a blocking call. The process posts `net.listen` and sleeps on `Atomics.wait` until the kernel has put the listener in its table of ports and woken it.",
        moves: [{ kind: "request", from: "server", hops: [{ to: "kernel", label: "net.listen" }] }],
      },
      {
        title: "The kernel tells the editor that the port is open.",
        detail:
          "It first waits 50 ms to see that the listener stays, then sends a `port` event. The editor's `server-ready` listener gets the preview URL, `https://<session>-<port>.<host>/`.",
        moves: [{ kind: "event", from: "kernel", hops: [{ to: "editor", label: "port" }] }],
      },
      {
        title: "The editor loads that URL in the preview iframe.",
        detail:
          "Each session and port is an origin of its own, so one project cannot read what another left in a preview's storage.",
        moves: [{ kind: "event", from: "editor", hops: [{ to: "preview", label: "iframe src" }] }],
      },
    ],
  },
  {
    id: "request",
    name: "Preview request",
    summary:
      "How a page in the preview iframe gets its files from a server that is not on the network.",
    steps: [
      {
        title: "On the first load the page asks the editor for a port.",
        detail:
          "No service worker runs yet, so the preview host answers the navigation with a small connect page. It posts `webnode:preview-connect` to its parent window, the editor.",
        moves: [
          {
            kind: "request",
            from: "preview",
            hops: [{ to: "editor", label: "webnode:preview-connect" }],
          },
        ],
      },
      {
        title: "The editor makes a channel: one end for the gateway, one for the preview.",
        detail:
          "It checks that the sender is one of this session's preview origins. Then it sends one MessagePort to the kernel with `previewAttach`, and the other to the preview window with `webnode:preview-port` and the id of the editor's build.",
        moves: [
          { kind: "request", from: "editor", hops: [{ to: "kernel", label: "previewAttach" }] },
          {
            kind: "response",
            from: "editor",
            hops: [{ to: "preview", label: "webnode:preview-port" }],
          },
        ],
      },
      {
        title: "The connect page starts the service worker and gives it the port.",
        detail:
          "It registers the service worker of the editor's build, posts `webnode:attach` with the port, and reloads when the worker answers `webnode:attached`.",
        moves: [{ kind: "event", from: "preview", hops: [{ to: "sw", label: "webnode:attach" }] }],
      },
      {
        title: "Now every request of the page reaches the service worker.",
        detail:
          "After the reload the worker controls the page. Each document, module, stylesheet and `fetch()` raises a `fetch` event in the worker and does not go to the network.",
        moves: [{ kind: "request", from: "preview", hops: [{ to: "sw", label: "GET /main.tsx" }] }],
      },
      {
        title: "The service worker passes the request to the gateway.",
        detail:
          "It sends the method, path, headers and body as a `request` message on the control port. It adds the preview's cookies from its own jar, and the headers a browser does not show a service worker (Sec-Fetch-*, Origin, Referer).",
        moves: [{ kind: "request", from: "sw", hops: [{ to: "gateway", label: "request" }] }],
      },
      {
        title: "The gateway opens a connection to the dev server.",
        detail:
          "It asks the kernel for the process that listens on the port. The kernel posts one end of a new channel to that process as a `connection` message, and the gateway writes the request on it as HTTP/1.1. The server sees a plain request to `localhost:<port>`.",
        moves: [
          { kind: "request", from: "gateway", hops: [{ to: "server", label: "HTTP request" }] },
        ],
      },
      {
        title: "The dev server reads and transforms the file.",
        detail:
          "Vite handles the request as it does on a developer's machine. Its file reads are direct calls into the shared file system.",
        moves: [{ kind: "call", from: "server", hops: [{ to: "fs", label: "readFile" }] }],
      },
      {
        title: "The response streams back through the gateway.",
        detail:
          "The gateway reads the HTTP response, removes the headers that belong to the connection, adds the isolation headers the preview needs, and puts the client script into HTML documents. It sends `response-head`, then `response-chunk` messages, then `response-end`.",
        moves: [
          {
            kind: "response",
            from: "server",
            hops: [
              { to: "gateway", label: "HTTP response" },
              { to: "sw", label: "response-head" },
            ],
          },
        ],
      },
      {
        title: "The page gets a normal response.",
        detail:
          "The service worker builds a `Response` whose body is a stream of the chunks, and keeps any `Set-Cookie` in its jar. To the page it is an answer from the network.",
        moves: [{ kind: "response", from: "sw", hops: [{ to: "preview", label: "200 OK" }] }],
      },
    ],
  },
  {
    id: "edit",
    name: "File edit to hot update",
    summary: "What happens between a change in the editor and the changed page.",
    steps: [
      {
        title: "The editor writes the changed file.",
        detail:
          "After an edit, the editor sends the file's new contents to the kernel with `fs.writeFile`.",
        moves: [
          { kind: "request", from: "editor", hops: [{ to: "kernel", label: "fs.writeFile" }] },
        ],
      },
      {
        title: "The kernel writes it, and the file system records the change.",
        detail:
          "While something watches, each change is added to an event log in the shared memory. Only the kernel delivers what is in the log.",
        moves: [{ kind: "call", from: "kernel", hops: [{ to: "fs", label: "writeFile" }] }],
      },
      {
        title: "The kernel tells the process that watches the file.",
        detail:
          "It posts a `watch` message to every process that watches that path. The file watcher inside Vite receives it.",
        moves: [{ kind: "event", from: "kernel", hops: [{ to: "server", label: "watch" }] }],
      },
      {
        title: "Vite sends an update over its WebSocket.",
        detail:
          "Vite's HMR socket is a connection from the dev server to the gateway, and from the gateway a MessagePort straight to the page's `WebSocket` object. Its frames do not pass through the service worker.",
        moves: [
          {
            kind: "event",
            from: "server",
            hops: [
              { to: "gateway", label: "socket frame" },
              { to: "preview", label: "message: update" },
            ],
          },
        ],
      },
      {
        title: "The page asks for the changed module.",
        detail:
          "Vite's client in the page imports the module again. That is a preview request like any other: service worker, gateway, dev server.",
        moves: [
          {
            kind: "request",
            from: "preview",
            hops: [
              { to: "sw", label: "GET /App.tsx" },
              { to: "gateway", label: "request" },
              { to: "server", label: "HTTP request" },
            ],
          },
        ],
      },
      {
        title: "The new module arrives and the page updates.",
        detail:
          "The response comes back the same way, and Vite replaces the module without a reload. For a change it cannot apply this way, Vite sends `full-reload` and the page loads again.",
        moves: [
          {
            kind: "response",
            from: "server",
            hops: [
              { to: "gateway", label: "HTTP response" },
              { to: "sw", label: "response-head" },
              { to: "preview", label: "200 OK" },
            ],
          },
        ],
      },
    ],
  },
];
