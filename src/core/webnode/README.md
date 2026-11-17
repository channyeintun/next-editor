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
- **Each project gets its own preview origins.** A preview origin is `<session>-<port>.<host>`. A reload of the page keeps its session for the same project (the `sessionKey` boot option, the page's path by default), so the preview's service worker and storage stay. Any other boot in the page (a reset for another project or lesson) mints a new session. When a session is given up (teardown), the editor asks each of its preview origins to clear itself: the host answers `POST /__webnode__/clear` from the editor's origin with `Clear-Site-Data: "storage"`, which drops that origin's storage, caches and service worker. Cookies are not named, because that would clear the whole site's. The editor's PostHog cookies are host-only, so the runtime's hosts cannot read them.
- **Preview cookies** live in the preview service worker's own jar, with a copy in its Cache Storage, so a worker the browser stops and restarts keeps the session. They go out on requests and on WebSocket handshakes. The server sees the preview as `http://localhost:<port>`: Host, Origin and Referer are restated on that origin, and a redirect to it (Location, Content-Location, Refresh) comes back as a path on the preview. The injected client goes only into documents (navigations and frames), never into `fetch()` or XHR bodies.
- **Devices.** /dev/null, /dev/stdin, /dev/stdout, /dev/stderr, /dev/tty, /dev/fd and /dev/fd/N are the kernel's, under any spelling (`//dev/null`, `/tmp/../dev/null`, a link to one, a directory linked to /dev). In the tree each one is a symbolic link to itself. A path that reaches one through a link therefore fails in the filesystem with ELOOP and never creates a file there; processBackend.ts sends that call to the kernel, and the kernel works out which device it is. Reading /dev/stdin reads fd 0 to its end; writing /dev/stdout writes fd 1. A device cannot be removed, renamed or replaced.
- **One build's scripts never run against another's.** Every script carries its build's id (buildId.ts) and asks for the others by it. That includes the preview's service worker: the editor names its build when it hands a preview a control port, and the connect page registers `/__webnode__/sw.js?v=<that build>`. A host that serves a newer build answers a request for an older one with 409. So an editor left open across a deploy is told to reload, both by the runtime frame and by a preview's connect page, instead of driving a kernel or a gateway it does not match. The browser's own service-worker update check cannot swap a newer build's worker in either. The kernel and process scripts of a named build are cached for good.
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
- **Stopping a process is not supported.** SIGSTOP, SIGTSTP, SIGTTIN and SIGTTOU do nothing (a handler still gets the last three), so `kill -STOP` neither stops nor ends a process. SIGCHLD, SIGCONT, SIGURG and SIGWINCH are ignored by default, as in POSIX. A background reader of the terminal waits instead of getting SIGTTIN.
- **A node process ignores SIGPIPE**, as Node does: a write to a closed pipe fails with EPIPE on the stream. The shell and its commands keep the POSIX default, so `yes | head -1` ends.
- **/dev/stdout or /dev/stdin on a file** goes through the file descriptor that is already open, at its current offset. On Linux, opening them reopens the file. Reading /dev/stdin on a file does read from the start.
- **readdir('/dev')** lists the devices as symbolic links, because that is what the tree holds; their stat is a character device (or the stat of the fd).
- **Removing /dev itself** (`rm -rf /`, or unlinking an entry through a directory linked to /dev) removes the device links, and from then on such spellings are no longer caught.
- **`tsx watch` runs `node --watch`**, which does not yet restart on changes.
- **Processes an exited page process leaves running** can be ended with that process's `kill()`; they get no SIGHUP.
- **TypeScript is compiled by sucrase, which erases types.** Decorators, and `namespace`/`module` blocks that hold values, cannot be compiled. Loading a file that uses them throws a SyntaxError that names the syntax, the file and the line. Namespaces that hold only types, and `declare namespace`/`declare module`/`declare global` blocks, are erased.
- **A .ts/.tsx/.jsx file's format comes from where it is.** `.cts` is CommonJS and `.mts` is an ES module. In a `"type": "module"` package it is an ES module. In a `"type": "commonjs"` package it is CommonJS, and its `import`/`export` are compiled to `require`/`exports` as tsx does, so `require`, `module` and `__dirname` work. In a package with no `"type"` field its syntax decides: `import`/`export` make it an ES module, as with Node's own type stripping.
- **ES module import cycles**: exported function declarations can be called while the cycle runs, and default and namespace imports are live. A `let`/`const`/`class` export read before its module has run gives `undefined`, not Node's ReferenceError.
- **Importing a name an ES module does not export** fails at link time with Node's SyntaxError. Imports from CommonJS modules, and imports written in TypeScript files, are not checked.
- **`process.nextTick` called inside a promise job** runs before the promise jobs queued after it. Node runs it once the whole microtask queue has drained.
- **`vm` `timeout` and `breakOnSigint` have no effect**: nothing can interrupt synchronous code in a worker. The first use prints a warning, and code that would time out in Node runs until it ends.
- **`node --watch <script>`** runs the script once, with a warning; it is not restarted when files change. `node --run <script>` runs a package.json script as Node does.
- **File permissions are stored, not enforced.** chmod, the mode a file is created with and stat's mode bits behave as on Linux, but reads, writes, opens and access(R_OK/W_OK) succeed whatever the bits say, as they do for root. The one check made is access(X_OK) on a regular file. A program that expects EACCES after chmod 0 does not get it.
- **A WebSocket to a local host** (localhost, *.localhost, 127.x, ::1, the machine's hostname) reaches the server a process listens with inside the runtime, as fetch does (process/node/http/localWebSocket.ts). Only remote hosts use the browser's own WebSocket. wss: to a local host is plain ws:, as https: to a local host is plain http:. If a server never answers our close frame, the socket closes with 1006 after 5 s (Node waits).
- **Asynchronous fs calls** do their work at once and deliver the result from the event loop, one completion per task (fs/completion.ts). Timers, immediates and port messages run between completions, as in Node's poll phase. The cost is about 3 µs a call.
- **Promise state and iterator contents in `util.inspect` / `console.log`.** A browser cannot read a promise's state or an iterator's entries synchronously. A promise prints as `Promise { <state unknown> }` and a Map/Set iterator as `[Map Iterator] { <items unknown> }`, not with a made-up `<pending>` or an empty list. WeakMap/WeakSet print `{ <items unknown> }` even with `showHidden`. `console.table` of a Map or Set iterator prints an empty table. (util/webInspect.ts)
- **Browser classes print as Node's do.** URL, URLSearchParams, Headers, FormData, Blob, File, AbortSignal, AbortController, TextEncoder, TextDecoder, Event, Request and Response print the same fields as in Node. Headers show their names in lower case, and a Response body prints as `ReadableStream {}`.
- **`AsyncLocalStorage.enterWith()` outside a callback the runtime wrapped** (at top level, or after an `await` on a native promise) lasts only until the current synchronous run ends. After that it cannot be told apart from other code, so it is dropped rather than leaked into other requests.
- **Members kept as documented no-ops** (exceptions to "throws an error that names it"): `async_hooks.createHook(...).enable()` and `v8.promiseHooks` accept hooks that never run, because their users are diagnostics tools that keep working without the events. `v8.setFlagsFromString()` is accepted with no effect: engine flags cannot be changed from page JavaScript, and Node calls changing them after start-up undefined. `performance.eventLoopUtilization()` reports zeros because the browser does not report idle time, and Vite reads it unconditionally.
- **`v8.getHeapStatistics()`** reports `performance.memory`'s figures where the browser has them. Where it does not (a worker), it throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM.
- **Assertion diffs** use Node's Myers diff and collapse equal runs as Node does. Past 1000 differing lines they fall back to a plain report (common head and tail, then the other actual lines, then the other expected lines) instead of a minimal diff.
- **`crypto`**: secret keys are supported (`createSecretKey`, `KeyObject` with `type`, `symmetricKeySize`, `export`, `equals`; `createHmac`, `createCipheriv` and `hkdf` take them), so jsonwebtoken and jose HS256 work. `keyObject.toCryptoKey()` and `KeyObject.from()` throw (a CryptoKey is asynchronous in a browser).
- **Pipes have no capacity.** A writer never waits for its reader, so output that nobody reads (a child spawned with `stdio: 'pipe'` whose stream is never read) is kept in the kernel for as long as the writer runs.

Not supported:

- **Native addons** (`.node` files) and any package that downloads a binary.
- **Raw TCP, TLS, HTTP/2 and UDP.** `http`/`https` to another host go through
  the browser's `fetch`, so the remote server's CORS policy applies.
- **`module.register()` loader hooks, `vm` contexts with their own globals,
  `worker_threads.receiveMessageOnPort`, the interactive `node` REPL.**
- **Install scripts of dependencies** are not run (the project's own are).
- **Mobile browsers**, like WebContainer.
- **A preview page's own service worker** (MSW's browser worker, a PWA's `sw.js`). The preview's service worker owns the origin, so `navigator.serviceWorker.register` in a preview rejects with "previews do not support page service workers", and the host answers a script it does not serve with 404.
- **`document.cookie` and the server's cookies are separate jars.** A page script cannot read cookies the server sets, even ones that are not HttpOnly (so an XSRF-TOKEN double-submit does not work). Cookies set by `document.cookie` are not sent to the server.
- **`node:test`, `node:test/reporters`, `node:sqlite`, `node:sea`, `_stream_wrap`, `_tls_common`, `_tls_wrap`.** `module.isBuiltin()` and `builtinModules` list them, as in Node, but `require` throws ERR_UNKNOWN_BUILTIN_MODULE naming the module. (`_http_agent`, `_http_client`, `_http_common`, `_http_incoming`, `_http_outgoing` and `_http_server` load and give `http`'s own classes.)
- **Asymmetric crypto**: `sign`/`verify`, `createSign`/`createVerify`, `generateKeyPair(Sync)`, `generateKey(Sync)`, `createPublicKey`/`createPrivateKey`, public/private encrypt and decrypt, Diffie-Hellman, ECDH, X.509, primes. Each throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM naming itself.
- **TLS of its own.** `tls.getCiphers()`, `tls.rootCertificates`, `tls.createSecureContext()` and `new tls.SecureContext()` throw ERR_FEATURE_UNAVAILABLE_ON_PLATFORM: the browser has the TLS and the trust store, webnode has neither.

The shell (`sh`, `jsh`) and its built-in commands:

- Pipelines: in-process stages (builtins, functions, compound commands, commands/ programs) run at the same time, each as a subshell. `exit` ends only its stage, and a stage's EXIT trap runs when it ends. A stage whose output pipe has lost its reader (the shell's write got EPIPE) exits 141 at its next command. The shell declares SIGPIPE handled and ignores it without a trap, so one in-process stage writing to a closed pipe does not kill the whole shell.
- Signals: between commands the shell checks for pending signals. If the event loop has not turned for 50 ms (a loop of builtins that never waits), it yields once through a MessageChannel message so the kernel's signal message can arrive. Ctrl+C or SIGTERM therefore stops `while :; do :; done`. A non-interactive shell exits 128+n. An interactive jsh abandons the command line (status 130) when Ctrl+C arrives while no foreground child runs; a foreground child that gets Ctrl+C still decides for itself. Background jobs ignore the terminal's signals.
- Background jobs run in the shell's own process get a pid of their own, counting up from 4194304 (2^22, above any kernel pid). That pid sets `$!` and works with `kill` and `wait`. `kill` ends such a job at its next command, wakes its sleeping built-in commands and forwards the signal to the children it waits on.
- History: a command typed on several lines is stored as one line (`for i in 1 2; do echo $i; done`) when that line means the same; otherwise it stays in this session's history only and is not written to ~/.jsh_history.
- The line editor measures characters by xterm's default (Unicode 6) widths, as the jsh terminal does. Emoji are 1 column there.
- **Built-in text filters stream.** grep, sed, tr, cut, uniq and xargs write as their input arrives and stop reading once their output is closed, so `dev-server | grep ready` prints at once. sort, wc and tail (on standard input) still read to the end first. Bytes that are not UTF-8 pass through every text command unchanged, and printf/echo `\NNN` and `\xHH` write single bytes.
- **`tail -f`** checks the named files every 250 ms. It ignores -f on standard input and ends on Ctrl+C (exit 130).
- **`rm -i` and `mv -i` cannot prompt**: without -f they refuse, printing "-i cannot ask for confirmation here" and exiting 1, instead of acting as if the user had answered yes. `rm` never removes an operand whose last component is `.` or `..`, nor `/`.
- **`xargs -P N`** is accepted, but the commands run one at a time. `-s` sets no limit.
- **`curl`**: the cookie jar (`-b`, `-c`) sees only cookies from local servers, because the browser's fetch hides Set-Cookie. For other hosts, `--connect-timeout` bounds the wait for the response headers. `--retry` retries on timeouts, on HTTP 408/429/500/502/503/504, and on a refused connection only with `--retry-connrefused`.
- **`sed`** still has no blocks, hold space, `N/D/P`, branches or `w`. An empty regex reuses the last regex in the script, not the last one run.
- **`grep -r`** skips symbolic links and binary files (a NUL byte in the first 8000 bytes), and prefixes names even for a single file operand, as BSD grep does.

The package manager:

- Registry requests time out when nothing arrives for 30 s (packuments and version documents) or 120 s (tarballs). The clock restarts with each chunk of the body. A request whose connection drops, even mid-body, is retried twice (after 300 ms, then 600 ms) before the install fails with EFETCH.
- `pre<script>` / `post<script>` hooks run for npm, pnpm, yarn and bun alike, as the real tools do (pnpm since v8).
- A peer dependency is placed where it resolves to its dependent's own copy, so react-dom and the package that pins react share one React. A dependency cycle between different versions (a@1 → b@1 → a@2 → b@2 → a@1), which no node_modules tree can lay out, fails the install with "Cannot lay out a dependency cycle" instead of hanging.
- Overrides: plain `name → spec` entries in `overrides`, `pnpm.overrides` and `resolutions` apply everywhere, and so does an npm nested override's own `"."`. Overrides scoped to a parent or a version (`a>b`, `a/b`, `{ "a": { "b": … } }`, `"name@<2"`) are not applied; the installer warns about each one on every install.
