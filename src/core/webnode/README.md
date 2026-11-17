# webnode

A Node.js-compatible runtime that runs in the browser: the engine that can
stand in for `@webcontainer/api`. It runs real, unmodified npm packages (the
Vite dev server, Vitest, the TypeScript compiler, Express) inside Web Workers,
on an in-memory filesystem, with an npm installer, a shell, and previews served
through a service worker.

It is an engine, like `src/core/x86`: nothing here imports from the app layer.
The app wires it in from `src/runtime/webcontainer/engine.ts`.

## How it is built

```
editor page (api.ts)          WebNode.boot() / mount / fs / spawn / on / teardown
   │  MessagePort
   ▼
runtime frame                 a hidden iframe on the RUNTIME ORIGIN, runtime.<host>
   └─ kernel worker (kernel/) owns everything shared: the filesystem (sharedfs/),
        │                     the process table, fds, pipes, ttys, listening ports
        │  per process: MessagePort (async) + SharedArrayBuffer (blocking calls)
        └─ process workers    one Web Worker per process (process/). JavaScript
                              runs in the browser's own engine; `fs.readFileSync`,
                              `child_process.execSync` … block on Atomics.wait
                              while the kernel answers.

preview iframe                on a PREVIEW ORIGIN, <session>-<port>.<host>. Its
   └─ service worker          service worker (preview/sw.ts) turns the page's HTTP
        │  MessagePort        requests and WebSockets into connections to the port
        ▼                     a process listens on, through the gateway
      gateway (preview/)      (preview/gateway.ts) in the kernel worker.
```

- **Nothing a lesson runs is on the editor's origin.** Processes run on the
  runtime origin and previews on preview origins. Those hosts serve only the
  runtime's own scripts and pages (preview/hostResponses.ts), which only the
  editor may frame, so lesson code cannot reach the editor's cookies, storage
  or API. The editor holds one MessagePort to the kernel and nothing else.
- **One filesystem, in one shared memory.** The filesystem is a Rust module
  (`sharedfs/`) that the kernel and every process run on the same shared
  WebAssembly memory, one call at a time. A process reaches it through
  `FsBackend` (process/runtime.ts): a path operation (`stat`, `readFile`,
  `readdir` …) is a function call in the process itself; open files and
  `/dev` are a synchronous round trip to the kernel, which owns every file
  descriptor. There are no per-process copies to drift. The TypeScript
  filesystem (`kernel/vfs`) is the reference the tests compare it with, and
  what the kernel uses where a shared memory cannot be made
  (`sharedFilesystem: false` at boot forces it).
- **The runtime's hosts.** In the deployment they are subdomains of the
  editor's own domain (`runtime.nexteditor.dev`,
  `<session>-<port>.nexteditor.dev`): other origins, but the same site. Lesson
  code there cannot read the editor's cookies or storage, and cannot call its
  API as the visitor (the API checks the request's origin, and a WebSocket's).
  It can set cookies for the parent domain, so the editor's sign-in cookies
  carry the `__Host-` prefix, which a subdomain cannot set
  (infra/worker/auth/session.ts): it can neither replace a visitor's session
  nor plant a sign-in. Two things remain that only a registrable domain of
  their own would remove, as StackBlitz has with webcontainer-api.io: lesson
  code can fill the parent domain's cookie jar until the editor's requests are
  refused for their size (clearing the site's cookies undoes it), and a browser
  may run a same-site frame in the editor's process (the hosts' own pages
  send `Origin-Agent-Cluster`, and cross-origin isolation already keeps each
  origin in its own agent cluster). A page there may not frame the editor
  either: the frame would be signed in (infra/worker/framing.ts). In development every `*.localhost` name is
  its own site.
- **Cross-origin isolation is required** (SharedArrayBuffer). The editor serves
  COOP/COEP and delegates isolation to the runtime frame.
- **One build's scripts never run against another's.** Every script carries its
  build's id (buildId.ts) and asks for the others by it. A host that serves a
  newer build answers a request for an older one with an error, so an editor
  left open across a deploy is told to reload instead of driving a kernel it
  does not match, and the kernel and process scripts of a named build are
  cached for good.
- **ES modules are linked by our own loader** (process/loader): each module is
  rewritten (es-module-lexer + sucrase) into a function and evaluated in
  dependency order, with top-level await. Nothing is loaded through native
  `import`. The generated code uses private names for its import and export
  bindings (build/webnodeBundle.ts renames sucrase's), so a module may declare
  its own `require` or `exports`.
- **Native binaries are swapped at install time** the way WebContainer does it:
  `esbuild` → `esbuild-wasm`, `rollup` → `@rollup/wasm-node`, at the same
  version, and a platform family's `wasm32-wasi` member in place of its native
  ones (process/programs/npm/substitutions.ts). The runtime reports `linux` /
  `x64` and sets `process.versions.webcontainer`, so packages that special-case
  WebContainer take the same paths here.

## Layout and owners

Each directory is one domain with one owner. Add behaviour in the owning
directory; the files marked _hub_ only wire.

| Path                       | What it owns                                                     |
| -------------------------- | ---------------------------------------------------------------- |
| `errors.ts`                | errno table, `SystemError`                                       |
| `buildId.ts`               | the id of the build a script belongs to                          |
| `protocol.ts`              | every message that crosses a thread                              |
| `api.ts`                   | the page-facing API (WebContainer-compatible)                    |
| `sharedfs/`                | the filesystem: a Rust module on one shared memory (its README)  |
| `kernel/vfs/`              | the filesystem in TypeScript: the reference and the fallback     |
| `kernel/kernel.ts`         | processes, fds, pipes, ttys, ports, blocking-call answers        |
| `kernel/exec.ts`           | what a command line runs (PATH, `#!`, built-in commands)         |
| `kernel/kernelWorker.ts`   | the kernel worker's entry — _hub_                                |
| `kernel/runtimeFrame.ts`   | the runtime frame's script                                       |
| `process/runtime.ts`       | what a process can ask the kernel for (interfaces) — _contract_  |
| `process/sysClient.ts`     | a process's end of its link to the kernel                        |
| `process/host.ts`          | the process worker's entry — _hub_                               |
| `process/loader/`          | module resolution, CommonJS and ES module loading                |
| `process/node/index.ts`    | the builtin-module registry — _hub_                              |
| `process/node/<name>.ts`   | one Node builtin module each (see "Builtin modules")             |
| `process/programs/shell/`  | `sh` / `jsh` and the built-in commands                           |
| `process/programs/npm/`    | `npm` / `pnpm` / `yarn` / `npx`: the installer and script runner |
| `process/programs/node.ts` | the `node` command line                                          |
| `preview/`                 | preview service worker, connect page, injected client, gateway   |
| `test/`                    | the browser harness page and the conformance cases               |

## Rules for code in this directory

- TypeScript is strict with `erasableSyntaxOnly` and `verbatimModuleSyntax`: no
  `enum`, no `namespace`, no constructor parameter properties; `import type` for
  types; no unused locals or parameters. The only `lib` is DOM, so worker
  globals need a local declaration.
- Never import from outside `src/core/webnode` except npm packages. Import the
  npm polyfill packages with a trailing slash so a Node test run does not pick
  the Node builtin: `buffer/`, `string_decoder/`, `punycode/`.
- A module never touches `runtime()` (process/runtime.ts) while it is being
  evaluated, only when one of its functions runs. The bundle evaluates every
  builtin before the process has booted.
- A builtin that needs a browser global a program may replace (`performance`,
  `crypto`) captures it when the module is evaluated.
- A member the browser cannot provide throws an error that names it. It never
  returns a made-up value. Hashes are real hashes.
- Tests sit beside the source as `<name>.test.ts`, start with
  `// @vitest-environment node`, and run with
  `npx vp test run src/core/webnode/<path>`. Type-check with
  `npx tsc --noEmit -p src/core/webnode`.

## Builtin modules

`process/node/<name>.ts` default-exports the object `require("<name>")`
returns. Sub-paths are separate files (`fs/promises` → `fs_promises.ts`, named in
the registry). A builtin imports other builtins as ordinary TypeScript modules
(`import events from "./events"`), so there is one `EventEmitter`, one `Buffer`,
one `Stream`.

What a builtin needs from the kernel it gets from `runtime()`; its tests install
a fake with `setRuntime()` (process/testing/fakeRuntime.ts). Behaviour follows
Node 22: same exports, same argument validation errors, same error `code`s.

## Running it in a real browser

`scripts/webnode-harness.ts` builds the runtime, serves it with the headers and
hosts it needs, and drives headless Chrome:

```bash
bun scripts/webnode-harness.ts run 'node -e "console.log(process.version)"'
bun scripts/webnode-harness.ts cases          # the conformance cases
bun scripts/webnode-harness.ts serve          # then open the printed URL
```

A conformance case (`test/cases/*.cjs`, `*.mjs`) runs under real Node and inside
webnode; both must print the same output and exit with the same code. A feature
is supported when a case, or a unit test against real Node, proves it.

A deployment ships the scripts minified, and serves them from a Worker. Both
are checked the same way:

```bash
WEBNODE_HARNESS_MINIFY=1 bun scripts/webnode-harness.ts cases
WEBNODE_HARNESS_TARGET=http://localhost:8787 bun scripts/webnode-harness.ts cases
```

`WEBNODE_HARNESS_FS=kernel` runs with the TypeScript filesystem instead of the
shared one. The second command above runs the cases against the hosts a
`wrangler dev` listener serves,
started with `--var WEBNODE_PREVIEW_HOST:localhost` and
`--var PUBLIC_URL:http://localhost:8787`. "Deploying" has the same for the
deployment.

## Deploying

`infra/wrangler.toml` names the host the runtime lives under
(`WEBNODE_PREVIEW_HOST`) and routes its subdomains to the Worker; the build
names the same host in `VITE_WEBNODE_PREVIEW_HOST`. webnode is the app's
default runtime in Chromium browsers; `?runtime=webcontainer` in the address
takes a visitor back to WebContainer and is remembered, `?runtime=webnode`
undoes that. When webnode does not start, the app runs the lesson on
WebContainer for that page load. After a deploy:

```bash
WEBNODE_HARNESS_TARGET=https://nexteditor.dev WEBNODE_HARNESS_PREVIEW_HOST=nexteditor.dev bun scripts/webnode-harness.ts cases
```

## What runs, and what does not yet

Verified in headless Chrome against the lessons' own workspaces and every
starter template: `pnpm install` from the npm registry; Vite 5.4, 7 and 8 dev
servers with HMR over the preview's WebSocket bridge; rolldown; Tailwind v4;
React 18 and 19, Vue, Solid and Svelte; TanStack Start with Nitro (server
rendering); Vitest 5; the TypeScript 6 compiler; `tsx`-style TypeScript entry
files; Express; esbuild (as `esbuild-wasm`) and rollup (as `@rollup/wasm-node`).

**napi packages built for `wasm32-wasi`** (rolldown, Tailwind v4's oxide, oxc)
load through `node:wasi` (process/node/wasi.ts): the system calls are
`@tybys/wasm-util`'s over this runtime's `fs`, and the package's threads are
`worker_threads` workers sharing one `WebAssembly.Memory`. The installer picks
the `wasm32-wasi` member of a platform family and gives a peer dependency the
copy its dependent pins, which is what keeps the emnapi packages on one version.

Known differences from Node:

- **An ES module's namespace is a plain object.** Its keys are in the order the
  module declares them, not sorted, it prints as an object rather than as
  `[Module: null prototype]`, and assigning to it does not fail.
- **`AsyncLocalStorage` across `await`** on a native promise: the browser has no
  async context, so a store set by `run()` can be lost after such an `await`.

Not supported:

- **Native addons** (`.node` files) and any package that downloads a binary.
- **Raw TCP, TLS, HTTP/2 and UDP.** `http`/`https` to another host go through
  the browser's `fetch`, so the remote server's CORS policy applies.
- **`module.register()` loader hooks, `vm` contexts with their own globals,
  `worker_threads.receiveMessageOnPort`, the interactive `node` REPL.**
- **Install scripts of dependencies** are not run (the project's own are).
- **Mobile browsers**, like WebContainer.
