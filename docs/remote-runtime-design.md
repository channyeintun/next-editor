# Remote Runtime — a WebContainer-compatible remote execution backend on Cloudflare

**Status:** Normative design — standalone package implemented and reviewed; editor integration and
environment validation remain pending.
**Companion docs:** [remote-runtime-implementation-plan.md](./remote-runtime-implementation-plan.md) ·
[remote-runtime-review.md](./remote-runtime-review.md) ·
[remote-runtime-cloudflare-setup.md](./remote-runtime-cloudflare-setup.md) (manual dashboard setup)
**Audience:** implementing agents/engineers. This document is self-contained: it embeds the
exact `@webcontainer/api@1.6.4` surface to replicate (Appendix A) and the exact call sites in
this repo that consume it (Appendix B). You should not need to reverse-engineer either.

---

## 1. Purpose

The editor's "runtime" (run commands, dev servers, terminals, live preview) is built on
[`@webcontainer/api`](https://webcontainers.io), which boots a Node.js-only Linux-like
environment **inside the browser** via WASM. That gives us zero-infra instant boot, but it
hard-limits the runtime to Node.js/JavaScript/TypeScript. We want to run **Go, Python, Rust,
and arbitrary Linux toolchains**.

This design introduces a **remote sandbox runtime** that is **API-compatible with
`@webcontainer/api`**: a client SDK class (`RemoteContainer`) that implements the same
`WebContainer` surface (`boot`, `mount`, `fs.*`, `spawn`, `on('server-ready')`, …) but executes
everything in a per-session Linux container **on Cloudflare** (Workers + Durable Objects +
Containers), transported over one WebSocket.

**Cloudflare is the backend — the only backend.** This repo already deploys a Worker with D1
via wrangler; the remote runtime extends that same deploy. There is deliberately no
backend-portability abstraction, no self-hosted broker, no second infrastructure to operate.
Local development uses `wrangler dev`, which runs the container locally (Docker is required on
dev machines only as wrangler's container build/run dependency).

Because the API is compatible, the editor keeps both runtimes:

|               | WebContainer (existing)    | Remote Runtime (new)                      |
| ------------- | -------------------------- | ----------------------------------------- |
| Where it runs | In the browser (WASM)      | Cloudflare Container (per session)        |
| Languages     | Node.js only               | Anything installable in a container image |
| Boot latency  | ~1–3 s, free               | Container cold start (~1–5 s) + network   |
| Offline       | Yes                        | No                                        |
| Cost          | Zero                       | Per-second container time                 |
| Selection     | Default for JS/TS projects | Selected for Go/Python/etc., or opt-in    |

### Goals

1. **Drop-in compatibility** for the API subset this app actually uses (Tier 1, §3) — the
   editor's runtime hooks change only where they _obtain_ the instance, not how they use it.
2. **Multi-language**: Go first (proof of generality), then Python; image-based so adding a
   language is adding a Dockerfile.
3. **Cloudflare-native, minimal ops**: everything server-side lives in the existing
   `infra/` Worker project and ships with the existing `wrangler deploy` workflow. One new
   Durable Object class, one container image family, zero new vendors.
4. **Live preview parity**: `server-ready`/`port` events, per-port preview URLs, preview script
   injection (`setPreviewScript`) and `preview-message` error forwarding all keep working.

### Non-goals

- Reimplementing StackBlitz-specific APIs: `auth`, `setupConnect`, `configureAPIKey`, the
  `'code'` event. These get inert stubs (§3, Tier 3).
- Offline support for the remote runtime.
- Multi-user collaboration on one sandbox (single editor session ↔ single sandbox).
- Persisting sandboxes across editor sessions in v1 (workspace state already lives client-side;
  the sandbox is rebuilt from `mount()` on boot).
- Portability to non-Cloudflare hosts. (The client↔agent protocol is host-agnostic by nature,
  which keeps the door open, but we build no adapter layer for it.)

---

## 2. Background: how the app uses WebContainer today

All WebContainer access is already funneled through a small set of modules (full call-site
inventory with line numbers in Appendix B):

```
src/contexts/webContainerRuntimeSupport.ts   boot singleton, fs helpers, FileSystemTree builder,
                                             setPreviewScript, teardown
src/contexts/useWebContainerRuntimeSession.ts  spawn (commands / runner / terminal shells),
                                               process wiring, event subscriptions
src/contexts/useWebContainerWorkspaceSync.ts   mount(), fs.watch()
src/contexts/WebContainerRuntimeProviderImpl.tsx  React provider orchestration
src/components/preview/runtimePreview.ts     preview URL normalization, reloadPreview()
src/components/XtermTerminal.tsx             xterm.js ↔ process input/output/resize
src/hooks/usePreviewController.ts            iframe.src ← previewUrl
```

Two properties make the swap tractable:

- **Singleton choke point**: `getOrBootSharedWebContainer()` in
  `webContainerRuntimeSupport.ts` is the only place `WebContainer.boot()` is called.
- **Structural consumption**: every consumer uses the instance through its public surface
  (`fs`, `spawn`, `on`, `mount`, …) — nothing depends on WebContainer internals, `instanceof`,
  or module side effects.

---

## 3. The compatibility contract

We define a structural interface `RuntimeContainer` (type-only import from
`@webcontainer/api`, so signatures can never drift):

```ts
// src/runtime/compat/types.ts
import type { WebContainer } from "@webcontainer/api";

/** The structural surface both runtimes implement. */
export type RuntimeContainer = Pick<
  WebContainer,
  "fs" | "mount" | "spawn" | "export" | "on" | "setPreviewScript" | "teardown" | "path" | "workdir"
>;

export type RuntimeKind = "webcontainer" | "remote";
```

`RemoteContainer` must satisfy this type (`const _check: RuntimeContainer = remoteInstance`
compile-time assertion in tests). Implementation is tiered by what the app actually uses:

### Tier 1 — used by this app today (MUST implement, exact semantics)

| API                                                                                 | Notes for remote implementation                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot({ coep, workdirName, forwardPreviewErrors })`                                 | `coep` accepted and ignored (browser-only concern). `workdirName` → workspace dir name inside container. `forwardPreviewErrors` → enables preview-message pipeline (§8).                                                                              |
| `mount(FileSystemTree)`                                                             | App mounts a full workspace tree at boot. Ship as one zip (fflate, already a dependency) over a binary channel; agent unpacks atomically.                                                                                                             |
| `fs.readFile(path)` / `fs.readFile(path, "utf-8")`                                  | Binary → `Uint8Array`; encoding → `string`.                                                                                                                                                                                                           |
| `fs.writeFile(path, string \| Uint8Array)`                                          |                                                                                                                                                                                                                                                       |
| `fs.mkdir(path)`                                                                    | Non-recursive form; app try/catches EEXIST. Error must be thrown on existing dir (match Node `fs.promises.mkdir`).                                                                                                                                    |
| `fs.rm(path)` / `fs.rm(path, { recursive: true, force: true })`                     |                                                                                                                                                                                                                                                       |
| `fs.readdir(path, { withFileTypes: true })`                                         | Return `DirEnt<string>[]` — objects with `name`, `isFile()`, `isDirectory()` **methods** (not booleans).                                                                                                                                              |
| `fs.watch(".", { recursive: true }, cb)`                                            | `cb(event: "rename" \| "change", filename)`. Filenames are **relative to the watched path**, `/`-separated. Returns `{ close() }`. App treats watch as optional and degrades gracefully — but implement it; workspace sync depends on it for good UX. |
| `spawn(cmd, args, { env })` / `spawn(cmd, args, { env, terminal: { cols, rows } })` | `terminal` present ⇒ allocate a PTY. Absent ⇒ pipes, but `output` still merges stdout+stderr.                                                                                                                                                         |
| `process.output: ReadableStream<string>`                                            | **Strings, not bytes** — UTF-8 decoded, ANSI escapes preserved. stdout+stderr merged.                                                                                                                                                                 |
| `process.input: WritableStream<string>`                                             | App does `getWriter()` / `write()` / `releaseLock()` per keystroke batch.                                                                                                                                                                             |
| `process.exit: Promise<number>`                                                     | Resolves with exit code; killed ⇒ conventionally `143`/`137`-style codes are fine, must resolve (never reject).                                                                                                                                       |
| `process.kill()`                                                                    | Kill the whole process tree (process group), idempotent.                                                                                                                                                                                              |
| `process.resize({ cols, rows })`                                                    | PTY resize; no-op on non-PTY processes.                                                                                                                                                                                                               |
| `on("server-ready", (port, url) => …)`                                              | Emitted when a spawned process starts listening on a port (§7.4). `url` must be directly loadable in an iframe.                                                                                                                                       |
| `on("port", (port, "open" \| "close", url) => …)`                                   |                                                                                                                                                                                                                                                       |
| `on("error", ({ message }) => …)`                                                   | Fatal runtime errors (connection lost beyond recovery, container died).                                                                                                                                                                               |
| `on("preview-message", (msg) => …)`                                                 | See §8.3. Message shapes in Appendix A §8.                                                                                                                                                                                                            |
| `setPreviewScript(src)`                                                             | Inject `<script>` into every HTML response served from sandbox ports (§8.2). Called once per boot with the recorder script.                                                                                                                           |
| `teardown()`                                                                        | Synchronous from caller's view; releases the remote session (fire-and-forget DELETE + WS close).                                                                                                                                                      |
| `reloadPreview(iframe)` (module export)                                             | App dynamic-imports it from `@webcontainer/api` with an `iframe.src` fallback. The compat module exports its own (cache-busting reload for remote preview URLs).                                                                                      |

All `on()` calls return an `Unsubscribe` function.

### Tier 2 — full-compat parity (SHOULD implement; cheap on a real Linux fs)

`fs.rename`, remaining `readdir`/`mkdir({recursive:true})`/`readFile` encoding overloads,
`spawn(cmd, opts)` overload (no args array), `SpawnOptions.cwd` and `SpawnOptions.output:false`,
`mount(Uint8Array|ArrayBuffer, { mountPoint })` (binary snapshot = our zip format),
`export(path, { format: "json" | "binary" | "zip", includes, excludes })`,
`on("xdg-open")`, `path` / `workdir` getters.

### Tier 3 — inert stubs (MUST exist for type compat, MUST NOT throw on import)

`auth` (methods return `{ status: "authorized" }` / resolved promises), `setupConnect` (no-op),
`configureAPIKey` (no-op), `on("code")` (returns unsubscribe, never fires),
`isPreviewMessage`, `PreviewMessageType` (re-export real values).

---

## 4. Architecture

```
┌────────────────────────── Browser ──────────────────────────┐
│  editor UI (unchanged hooks)                                 │
│     │  RuntimeContainer interface                            │
│     ▼                                                        │
│  runtime factory ──► WebContainer (JS/TS projects, as today) │
│               └────► RemoteContainer (client SDK)            │
│                        │ 1 WebSocket (RCP, §6)   ▲ iframe    │
└────────────────────────┼─────────────────────────┼───────────┘
                         ▼                         │ https://p{port}-{sid}.preview…
┌──────────── Cloudflare (the existing infra/ worker) ────────┐
│  Worker routes (Hono)                            │          │
│   • POST /api/runtime/sessions   (auth, quotas)             │
│   • GET  /api/runtime/sessions/:id/ws   (WS proxy)          │
│   • preview ingress: host or /preview path → session port   │
│     └ HTMLRewriter: inject preview script, set CORP headers │
│  RuntimeSessionDO (Durable Object, 1 per session)           │
│   • extends Container (@cloudflare/containers)              │
│   • lifecycle, idle timeout, preview-script storage         │
└───────────────────────┬─────────────────────────────────────┘
                        ▼
┌───────────── Cloudflare Container (per session) ────────────┐
│  image: runtime-node22 | runtime-go1.24 | …                 │
│   └─ agent (single Go binary, WS server)                    │
│       • fs ops jailed to /workspace                         │
│       • spawn: PTY (creack/pty) or pipes                    │
│       • recursive fs watcher                                │
│       • port watcher (/proc/net/tcp) → port/server-ready    │
│       • user processes: go run, vite, python, bash…         │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 Core decision: one protocol, one agent, thin Cloudflare control plane

The **agent** is a single static Go binary baked into every runtime image. It implements the
entire runtime semantics (fs, processes, watchers, port events) against the real Linux
environment, exposed as one WebSocket endpoint.

The **control plane** (Worker + `RuntimeSessionDO`) does _only_ auth, provisioning, routing,
and preview ingress. It never interprets RCP frames — between the client WS and the agent WS
it is an opaque byte proxy. All runtime semantics live in exactly two places: the client SDK
and the agent.

Why keep a custom agent instead of leaning on `@cloudflare/sandbox` (the Sandbox SDK)?
Resolved: **build on the thin official `@cloudflare/containers` `Container` class + our
agent.** The Sandbox SDK's value (exec, file APIs, preview URLs) overlaps with what the agent
must provide anyway, while the WebContainer semantics we're contractually bound to —
interactive PTYs with resize, merged-output streams, recursive `fs.watch`, _automatic_ port
detection driving `server-ready` — are not part of it. One abstraction (the agent), not two.
The `Container` class still gives us the boring parts free: container lifecycle binding to the
DO, `containerFetch`, sleep/wake.

A practical side benefit (not a portability goal): the agent + client SDK pair is fully
testable in CI against a plain `docker run` of the image — no Cloudflare account in the loop
for most tests (§13).

### 4.2 Why WebSocket (not WebTransport/HTTP)

- Works today end-to-end through Workers and Durable Objects (including WS hibernation
  support on the DO side), and through `wrangler dev` locally.
- Ordered delivery simplifies stream semantics; per-stream flow control handled at the RCP
  layer (§6.6) rather than transport.
- Binary frames give us zero-copy-ish file transfer without base64 inflation.

WebTransport can be a later optimization behind the same frame codec.

---

## 5. Client SDK (`RemoteContainer`)

Location: `src/runtime/remote/`. No React imports — plain TS class, same as `WebContainer`.

### 5.1 Boot flow

```ts
export interface RemoteBootOptions extends BootOptions {
  /** Runtime image selector, e.g. "node22", "go1.24", "python3.13". */
  runtime?: string;
  /** Base URL of the control plane; defaults to same-origin /api/runtime.
   *  In local dev, point it at the wrangler dev origin (e.g. http://localhost:8787/api/runtime). */
  endpoint?: string;
  /** Idle seconds before the server reclaims the sandbox. Default 300. */
  idleTimeoutSeconds?: number;
}

export class RemoteContainer /* satisfies RuntimeContainer */ {
  static async boot(options?: RemoteBootOptions): Promise<RemoteContainer>;
  /** @internal test/tooling entry: skip provisioning, connect straight to a known agent WS.
   *  Used by the conformance suite against a plain `docker run` of a runtime image. */
  static async attach(target: {
    wsUrl: string;
    previewUrlTemplate: string;
    workdirName?: string;
  }): Promise<RemoteContainer>;
}
```

`boot()`:

1. `POST {endpoint}/sessions` with `{ runtime, workdirName, idleTimeoutSeconds }` → `201`
   `{ sessionId, wsUrl, previewUrlTemplate, token }`.
   `previewUrlTemplate` (produced server-side per environment):
   - production: `https://p{{port}}-{{sessionId}}.preview.example.com`
   - `wrangler dev`: `http://localhost:8787/preview/{{sessionId}}/{{port}}`
2. Open WebSocket to `wsUrl` (token as query param or `Sec-WebSocket-Protocol` suffix).
3. Send `session.hello { protocolVersion: 1, resumeToken?: string }` → receive
   `{ workdir, agentVersion }`. Resolve `boot()` only after hello succeeds.
4. Start keepalive ping (20 s interval).

Boot rejects (never hangs) on provisioning failure — the editor surfaces `errorMessage` and,
for Node projects, can fall back to WebContainer.

### 5.2 Stream bridging (the subtle part)

- **`process.output`**: a `ReadableStream<string>` backed by RCP binary frames on the process's
  output channel. Decode with a persistent `TextDecoder("utf-8", { stream: true })` per process
  so multi-byte codepoints split across frames don't corrupt (this _will_ happen with box-drawing
  output from Go TUIs). Close the stream on `proc.exit`.
- **`process.input`**: a `WritableStream<string>` whose `write(chunk)` encodes UTF-8 and sends a
  binary frame on the stdin channel. `close()` sends FIN (EOF).
- **Backpressure**: honor RCP credit frames (§6.6): the output stream's `pull()` grants credit;
  a paused consumer stops granting, and the agent stops reading the PTY, which back-pressures
  the child process naturally.

### 5.3 Event emitter

Same semantics as WebContainer's `on`: multiple listeners, `Unsubscribe` return, listener
exceptions swallowed (log, don't break the dispatch loop). `server-ready`/`port` events are
translations of agent `evt port` frames with URLs rendered from `previewUrlTemplate`.

### 5.4 Reconnection

Transient WS drops must not destroy the session (mobile networks, DO restarts):

- On close (not initiated by `teardown`), retry with exponential backoff (0.5 s → 8 s, max 5
  tries), sending `resumeToken` in `session.hello`.
- The agent keeps sessions resumable for 60 s after disconnect: processes keep running, output
  is buffered per-channel in a ring buffer (256 KiB); on resume, buffered frames flush.
- Client re-registers `fs.watch` subscriptions after resume (agent watch state is dropped on
  disconnect; the client owns the watch list).
- After final failure: match WebContainer — leave `exit` promises unresolved but emit
  `on("error", { message })`; the app reacts to `error` by resetting the runtime, which calls
  `kill()`/`teardown()` (see the reset path in `useWebContainerRuntimeSession.ts`).

### 5.5 The runtime factory (integration point)

`webContainerRuntimeSupport.ts`'s singleton generalizes to:

```ts
// src/runtime/compat/factory.ts
export function getOrBootSharedRuntime(kind: RuntimeKind, opts?): Promise<RuntimeContainer>;
```

Selection policy (in the provider, not the factory): explicit per-project runtime setting if
set; else detect (`go.mod`/`*.go` → remote `go1.24`; `requirements.txt`/`pyproject.toml` →
remote `python3.13`; else `webcontainer`). Store the setting via the existing
`@xstate/store-react` store conventions (see memory/store docs) — **not** a new hand-rolled
store.

---

## 6. RCP — the wire protocol

One WebSocket, two frame kinds. Version negotiated in `session.hello` (`protocolVersion: 1`).

### 6.1 Control frames (WS text frames, JSON)

```
Request:  { "t": "req", "id": 7,  "m": "fs.readFile", "p": { … } }
Success:  { "t": "ok",  "id": 7,  "r": { … } }
Failure:  { "t": "err", "id": 7,  "e": { "code": "ENOENT", "message": "…" } }
Event:    { "t": "evt", "m": "port", "p": { … } }
```

- `id`: client-assigned, monotonically increasing per connection. Agent-initiated requests are
  not needed in v1 (agent only sends `ok`/`err`/`evt`).
- `e.code`: Node-style errno strings (`ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`,
  `EACCES`) plus protocol codes (`EPROTO`, `ELIMIT`, `EGONE`). The client SDK converts these to
  `Error` objects whose `message` **starts with the code** (e.g. `"ENOENT: no such file or
directory, open '/foo'"`) — matching Node/WebContainer message shape that app code may sniff.

### 6.2 Binary frames (WS binary frames)

```
byte 0..3   u32 LE channelId
byte 4      u8  flags   (bit0 FIN = half-close of this channel)
byte 5..    payload
```

Channels are allocated by control-frame handshakes (never implicitly). Channel 0 is reserved.

### 6.3 Method reference

| Method            | Params → Result                                                                       | Notes                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `session.hello`   | `{ protocolVersion, resumeToken? }` → `{ workdir, agentVersion, resumed }`            | Must be first frame.                                                                                                                    |
| `fs.readFile`     | `{ path }` → `{ ch }` then binary frames on `ch` ending FIN                           | Always binary over the wire; the **client** applies encoding.                                                                           |
| `fs.writeFile`    | `{ path, ch }` → after client FINs `ch` → `ok {}`                                     | Client allocates `ch` (odd ids = client-allocated, even = agent-allocated).                                                             |
| `fs.mkdir`        | `{ path, recursive }` → `{ created? }`                                                |                                                                                                                                         |
| `fs.readdir`      | `{ path, withFileTypes }` → `{ entries: [{ name, kind: "file"\|"dir"\|"symlink" }] }` | Client materializes `DirEnt` methods.                                                                                                   |
| `fs.rm`           | `{ path, recursive, force }` → `{}`                                                   |                                                                                                                                         |
| `fs.rename`       | `{ from, to }` → `{}`                                                                 |                                                                                                                                         |
| `fs.watch`        | `{ watchId, path, recursive }` → `{}`                                                 | Events: `evt fs.watch { watchId, event: "rename"\|"change", filename }`.                                                                |
| `fs.unwatch`      | `{ watchId }` → `{}`                                                                  |                                                                                                                                         |
| `mount`           | `{ mountPoint?, ch }` (client streams zip on `ch`, FIN) → `{}` after unpack           | Zip via fflate on client; agent unpacks with symlink members supported. Applied atomically enough: unpack to temp dir, then move-merge. |
| `export`          | `{ path, format, includes?, excludes? }` → `{ ch }` streaming zip/json down           |                                                                                                                                         |
| `proc.spawn`      | `{ cmd, args, env, cwd?, terminal?, output }` → `{ pid, outCh, inCh }`                | Rejects `err ENOENT` if executable not found (the shell-candidate loop in the app relies on failure).                                   |
| `proc.resize`     | `{ pid, cols, rows }` → `{}`                                                          |                                                                                                                                         |
| `proc.kill`       | `{ pid }` → `{}`                                                                      | SIGTERM to process group, SIGKILL after 2 s.                                                                                            |
| `proc.stdinClose` | via FIN flag on `inCh`                                                                |                                                                                                                                         |
| `session.ping`    | `{}` → `{}`                                                                           | Keepalive.                                                                                                                              |

(`setPreviewScript` is deliberately **not** an RCP method — it's a control-plane REST call,
§8.2, because injection happens at the preview ingress, not in the container.)

### 6.4 Events (agent → client)

| Event       | Payload                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `port`      | `{ port, type: "open" \| "close" }` — client renders URL from template and emits both `port` and `server-ready` (on open). |
| `proc.exit` | `{ pid, code }` — agent then FINs `outCh`.                                                                                 |
| `fs.watch`  | `{ watchId, event, filename }`                                                                                             |
| `fatal`     | `{ message }` → client emits `on("error")`.                                                                                |

### 6.5 Example trace — user opens a terminal and runs a Go server

```
c→a  {"t":"req","id":1,"m":"proc.spawn","p":{"cmd":"bash","args":[],"env":{...},"terminal":{"cols":120,"rows":30},"output":true}}
a→c  {"t":"ok","id":1,"r":{"pid":12,"outCh":2,"inCh":3}}
a→c  [bin ch=2] "bash-5.2$ "
c→a  [bin ch=3] "go run .\n"
a→c  [bin ch=2] "go run .\r\n…listening on :8080…"
a→c  {"t":"evt","m":"port","p":{"port":8080,"type":"open"}}
       └ client: emits on("port",8080,"open",url) and on("server-ready",8080,url)
… user closes terminal …
c→a  {"t":"req","id":2,"m":"proc.kill","p":{"pid":12}}
a→c  {"t":"ok","id":2,"r":{}}
a→c  {"t":"evt","m":"proc.exit","p":{"pid":12,"code":143}}
a→c  [bin ch=2 FIN]
a→c  {"t":"evt","m":"port","p":{"port":8080,"type":"close"}}
```

### 6.6 Flow control

Per-channel credit: receiver sends `{"t":"evt","m":"ch.credit","p":{"ch":2,"bytes":262144}}`
(fire-and-forget). Sender must not exceed outstanding credit. Initial credit per channel:
256 KiB. This is what stops a runaway process from ballooning DO memory or the browser tab.

### 6.7 Limits (agent-enforced, return `ELIMIT`)

Max file read/write 64 MiB, mount zip 256 MiB, 64 concurrent processes, 128 watches, path depth
64, control frame 1 MiB, binary frame 256 KiB.

---

## 7. Sandbox agent

Location: `sandbox/agent/` (Go module, single `main` package plus internal packages). Go is
chosen because: single static binary (scratch-friendly, ~8 MiB), first-class PTY
(`github.com/creack/pty`), trivial concurrency for the mux, and it dogfoods the multi-language
story.

### 7.1 Process model

- PID 1 in the container is the agent (or `tini` → agent). Agent reaps zombies (`SIGCHLD`).
- Each `proc.spawn`: `terminal` present → `pty.StartWithSize`, else `exec.Cmd` with combined
  stdout/stderr pipe (interleave via a mutex-guarded writer to preserve WebContainer's merged
  `output` semantics). Always `Setpgid: true`; kill targets the process group.
- Exit codes: `cmd.Wait()`; signaled processes report `128+signal`.

### 7.2 Filesystem jail

Workspace root `/workspace/{workdirName}`. Every path from the wire is resolved with a
`securejoin`-style function (lexical clean + reject `..` escapes + re-verify after symlink
resolution stays under root). The agent runs as a non-root user (`uid 1000`);
container-level isolation is the real boundary (§12), the jail just keeps the API honest.

### 7.3 Recursive watch

Linux inotify is non-recursive; use `github.com/rjeczalik/notify` (recursive on Linux) or
fsnotify + directory-walk auto-add. Map to WebContainer semantics: create/delete/move →
`"rename"`, write/truncate → `"change"`; filename relative to watch root. Debounce duplicate
events within 10 ms per path. Cap watched dirs (`ELIMIT`) to survive `node_modules`.

### 7.4 Port watcher (`server-ready` emulation)

Poll `/proc/net/tcp` + `/proc/net/tcp6` every 300 ms; a socket in state `0A` (LISTEN) on
`0.0.0.0`/`::`/`127.0.0.1` with a port not seen before ⇒ `evt port {open}`; disappeared ⇒
`{close}`. Ignore **only** the agent's own listen port; everything else is user traffic.
WebContainer emits `server-ready` per listening start; we mirror: client emits `server-ready`
on every `open`.

Note: preview traffic must reach `127.0.0.1`-bound servers too, so the preview path proxies
from **inside** the container (the agent's `/proxy` endpoint, §7.5), not from the container's
network edge.

### 7.5 Agent HTTP surface (single port, e.g. `:8600`)

- `GET /ws` — the RCP WebSocket.
- `GET /proxy/{port}/{path…}` — reverse proxy to `127.0.0.1:{port}` **inside** the container,
  streaming, WebSocket-upgrade passthrough (dev servers use WS for HMR). Used by the preview
  ingress (§8.1). Forwards method/body/headers; rewrites nothing (HTML injection happens at
  the edge, §8.2).
- `GET /healthz`.

---

## 8. Preview pipeline

### 8.1 URL scheme and routing

The Worker's preview ingress accepts **two routings to the same code path**:

- **Production (host-based)**: `https://p{{port}}-{{sessionId}}.preview.{domain}` — a wildcard
  route on `*.preview.{domain}`. Parse `port` + `sessionId` from the host.
- **Dev (path-based)**: `http://localhost:8787/preview/{{sessionId}}/{{port}}/{path…}` — used
  under `wrangler dev`, where wildcard subdomains don't exist. (Works for most dev servers;
  absolute-path asset URLs are the known limitation — acceptable for dev.)

Either way: resolve `sessionId` → `RuntimeSessionDO` → `containerFetch` to agent
`GET /proxy/{port}/…`, streaming both directions including WebSocket upgrades (HMR).
Session ids are 128-bit random — the URL is an unguessable capability (v1 auth model;
documented tradeoff).

### 8.2 `setPreviewScript` — HTML injection at the ingress

WebContainer injects the script into every HTML response. Remotely, the interception point is
the preview ingress: `RemoteContainer.setPreviewScript(src)` →
`PUT /api/runtime/sessions/{id}/preview-script` → stored in the session DO. The ingress applies
`HTMLRewriter` to `text/html` responses, appending `<script>` (with `PreviewScriptOptions`
type/defer/async attributes) into `<head>`. Non-HTML and streaming responses pass through
untouched.

### 8.3 `preview-message` (forwarded preview errors)

The app's recorder script and `forwardPreviewErrors` both ride on this. The compat layer adds
a tiny **forwarder prelude** ahead of the user's preview script when `forwardPreviewErrors` is
enabled. The prelude registers `window.onerror`, `unhandledrejection`, and a `console.error`
wrapper, and `parent.postMessage`s payloads shaped exactly like `PreviewMessage` (Appendix A
§A.6, including `previewId`, `port`, `pathname`, `search`, `hash`) with `targetOrigin` = the
editor origin (embedded in the prelude at injection time). The `RemoteContainer` instance adds
a `window.addEventListener("message")` handler that validates `event.origin` against the
session's preview origin and re-emits `on("preview-message")`.

### 8.4 COEP/CORP — critical gotcha

The editor forces `Cross-Origin-Embedder-Policy: require-corp` + COOP on all its own responses
(needed by WebContainer's SharedArrayBuffer; configured in `vite.config.ts` and
`infra/worker/index.ts`). Under COEP, a cross-origin `<iframe>` only loads if the embedded
response opts in. Therefore the preview ingress MUST set on every preview response:

```
Cross-Origin-Resource-Policy: cross-origin
Cross-Origin-Embedder-Policy: unsafe-none      (don't cascade require-corp into user apps)
```

Without CORP, remote previews render as blank frames while WebContainer previews work — an
easy multi-hour debugging trap. Add an integration test asserting these headers.

`reloadPreview` compat export: re-set `iframe.src` with a cache-busting query param, falling
back to `contentWindow.location.reload()` when same-origin (it never is, remotely).

---

## 9. Control plane (Cloudflare)

All of this lives in the existing `infra/` Worker project and ships with `wrangler deploy`.
**Implementers: load the `cloudflare`, `durable-objects`, and `sandbox-sdk`/containers skills
(or fetch current CF docs) before coding — Containers config, instance types, and image-size
limits change; do not code from memory.**

### 9.1 `RuntimeSessionDO`

One Durable Object per session, `extends Container` from **`@cloudflare/containers`** (the
official thin DO↔container wrapper — decision rationale in §4.1). Responsibilities:

- Start the container with the selected image variant; wait healthy (`GET /healthz`).
- Proxy the client WS ↔ agent `GET /ws` (opaque byte proxy; use hibernation-friendly WS
  handling where practical — the RCP connection is long-lived).
- Proxy preview requests to agent `GET /proxy/{port}/…` (streaming + WS upgrade).
- Store the preview script (`setPreviewScript` REST target).
- Idle timer: no client WS **and** no preview traffic for `idleTimeoutSeconds` ⇒ stop the
  container (DO alarm). `teardown()`/DELETE ⇒ destroy immediately.

### 9.2 Worker routes (Hono, alongside existing routes)

- `POST /api/runtime/sessions` — requires the app's existing session auth (reuse whatever the
  worker uses for its current API routes; if none exists yet, gate v1 behind a short-lived
  signed token the worker issues to the editor page). Validates `runtime` against the image
  allowlist; enforces per-user concurrent-session and daily-minutes quotas (D1 counters —
  note: **remote** D1 migrations are a separately authorized step in this repo).
- `GET /api/runtime/sessions/:id/ws` — token check, forward to DO.
- `PUT /api/runtime/sessions/:id/preview-script` — store in DO.
- `DELETE /api/runtime/sessions/:id` — teardown.
- Preview ingress (§8.1): host-pattern match in production, `/preview/:sid/:port/*` in dev.
  Applies HTMLRewriter injection (§8.2), CORP/COEP headers (§8.4), and strips editor cookies
  before forwarding.

### 9.3 Local development — `wrangler dev`, no extra infrastructure

`wrangler dev` runs the Worker, the DO, **and the container locally** (it builds and runs the
image via Docker). The editor's vite dev server points `RemoteBootOptions.endpoint` at the
wrangler dev origin. This replaces any need for a self-hosted broker/daemon: the dev loop is
`docker` (installed) + `bun run dev` + `wrangler dev`. CI uses the same mechanism for
full-stack tests, and plain `docker run` + `RemoteContainer.attach` (§5.1) for
agent/SDK-level tests without the Worker in the loop.

### 9.4 Session lifecycle

```
created ─boot→ running ─idle timeout→ reclaimed
   │                │─ teardown() ──→ destroyed
   │                └─ ws lost >60s and no resume → reclaimed
```

Reclaimed/destroyed are terminal in v1 (no persistence; the editor re-boots + re-mounts, which
it already does per session). Client maps `EGONE` on any request to `on("error")`.

---

## 10. Runtime images

`sandbox/images/` — built and pushed with wrangler's container image tooling as part of the
deploy workflow (image push is a documented, separately-authorized deploy step):

| Image                | Contents                                                                                               | Notes                              |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `runtime-base`       | debian-slim (glibc), agent binary, `bash`, coreutils, git, curl, ca-certs, non-root user, `/workspace` | Everything derives FROM this.      |
| `runtime-node22`     | + Node 22, npm/pnpm/bun                                                                                | Parity with WebContainer projects. |
| `runtime-go1.24`     | + Go toolchain, pre-warmed stdlib build cache                                                          | First new-language target.         |
| `runtime-python3.13` | + CPython, uv                                                                                          | Second target.                     |

Version-pinned tags; the `runtime` boot option maps to an image variant through an allowlist
in the control plane (never client-supplied image refs). **Check current Cloudflare Containers
image-size and instance-type limits before adding heavy toolchains** — a `runtime-full`
(node+go+python) variant is desirable but may not fit; treat it as optional.

---

## 11. Behavioral differences vs WebContainer (accepted + mitigated)

| Difference                                               | Impact                              | Mitigation                                                                                                                |
| -------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| fs ops cost a network RTT                                | mount/save slower                   | zip-batched mount; app reads-back only on save                                                                            |
| `jsh` doesn't exist                                      | terminal shell candidate loop       | agent images ship `bash`; the app already falls back `jsh`→`bash`→`sh` — spawn must reject ENOENT for the loop to advance |
| preview URL shape/origin differs                         | any URL parsing                     | `runtimePreview.ts` already normalizes; verify against new shape                                                          |
| boot can take seconds & fail (capacity, quota)           | UX                                  | distinct status messages ("provisioning sandbox…"); fallback to WebContainer for node projects                            |
| network egress exists (WC is sandboxed to a virtual net) | user code can call the internet     | egress allowed in v1 (it's a feature: `go get`/`npm i` need it); rate/quota at the platform level                         |
| processes survive brief disconnects                      | none (improvement)                  | resume protocol §5.4                                                                                                      |
| `output` chunk boundaries differ                         | apps that assume line-atomic chunks | none needed; xterm handles arbitrary chunking                                                                             |
| clock/timezone/arch (linux/amd64 or arm64)               | rarely                              | document                                                                                                                  |

---

## 12. Security model

- **Isolation boundary = the Cloudflare Container instance** (isolated per session).
- Agent runs non-root; workspace-jailed fs API; but assume user code owns the container —
  design so that owning the container gains nothing beyond one's own session: the agent holds
  no secrets, the WS is authenticated per-session at the control plane, preview URLs are
  per-session capabilities, no cross-session network path.
- Resource limits: memory/cpu/disk per container instance type, plus RCP `ELIMIT`s (§6.7).
- The control plane validates `runtime` against the image allowlist and enforces quotas.
- Preview ingress sets CORP headers (§8.4) and must **not** forward the editor's cookies to
  the sandbox (strip `Cookie` at the ingress).

---

## 13. Testing & conformance

1. **Protocol unit tests** (`src/runtime/rcp/*.test.ts`): frame codec, channel mux, credit
   accounting, error mapping — pure, no I/O.
2. **Agent integration tests** (Go tests + a TS harness): run the agent image via plain
   `docker run`, connect with `RemoteContainer.attach`, drive RCP over WS: fs matrix (incl.
   errno cases: ENOENT/EEXIST/ENOTEMPTY), spawn/PTY (resize reflected in `stty size`, merged
   output ordering, exit codes, kill-tree), watch events, port events with a real listener,
   mount+export round-trip. No Cloudflare account needed.
3. **Conformance suite** (the crown jewel): one Vitest spec file parameterized over
   `RuntimeContainer` implementations — runs against `RemoteContainer` in two modes
   (`attach`+docker in CI always; full `boot()` against `wrangler dev` as a CI job), and can
   be pointed at real `WebContainer` in a browser run to detect semantic drift. Every Tier-1
   row in §3 gets at least one assertion.
4. **Preview tests**: header assertions (CORP! §8.4), HTML injection, WS-upgrade proxying —
   against `wrangler dev`, re-run against staging.
5. **App-level**: existing runtime hook tests gain a `RuntimeKind` dimension with a mocked
   `RemoteContainer` (per repo test conventions; `npx vp test run`).

---

## 14. Open questions (decide during implementation, don't block on them)

1. Workspace persistence across sessions (volume snapshot to R2 on idle?) — deferred; v1
   rebuilds from `mount()`.
2. `server-ready` heuristics for multi-port apps (emit for every port vs first) — v1: every
   open, matching WC; the app takes the latest.
3. WebTransport upgrade path; binary control frames (CBOR) — deferred.
4. Per-language "runner presets" UI (e.g. default command `go run .`) — product question,
   tracked in the plan's editor-integration phase.

---

## Appendix A — `@webcontainer/api@1.6.4` public surface (verbatim spec)

This is the complete installed API surface (extracted from `node_modules/@webcontainer/api`
`dist/index.d.ts` / `dist/utils.d.ts`). The compat layer must be assignable to these types.

### A.1 `WebContainer`

```ts
export declare class WebContainer {
  fs: FileSystemAPI;
  static boot(options?: BootOptions): Promise<WebContainer>;
  spawn(command: string, args: string[], options?: SpawnOptions): Promise<WebContainerProcess>;
  spawn(command: string, options?: SpawnOptions): Promise<WebContainerProcess>;
  export(path: string): Promise<FileSystemTree>;
  export(path: string, options: ExportOptions & { format?: "json" }): Promise<FileSystemTree>;
  export(path: string, options: ExportOptions): Promise<Uint8Array>;
  on(event: "port", listener: PortListener): Unsubscribe;
  on(event: "server-ready", listener: ServerReadyListener): Unsubscribe;
  on(event: "preview-message", listener: PreviewMessageListener): Unsubscribe;
  on(event: "error", listener: ErrorListener): Unsubscribe;
  on(event: "xdg-open", listener: OpenListener): Unsubscribe;
  on(event: "code", listener: CodeListener): Unsubscribe;
  mount(
    snapshotOrTree: FileSystemTree | Uint8Array | ArrayBuffer,
    options?: LoadFilesOptions,
  ): Promise<void>;
  setPreviewScript(scriptSrc: string, options?: PreviewScriptOptions): Promise<void>;
  teardown(): void;
  get path(): string;
  get workdir(): string;
}

export interface BootOptions {
  coep?: "require-corp" | "credentialless" | "none";
  workdirName?: string;
  forwardPreviewErrors?: boolean | "exceptions-only";
}
export interface LoadFilesOptions {
  mountPoint?: string;
}
export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | number | boolean>;
  output?: boolean;
  terminal?: { cols: number; rows: number };
}
export interface ExportOptions {
  format?: "json" | "binary" | "zip";
  includes?: string[];
  excludes?: string[];
}
```

### A.2 Filesystem

```ts
export interface FileSystemAPI {
  readdir(
    path: string,
    options: "buffer" | { encoding: "buffer"; withFileTypes?: false },
  ): Promise<Uint8Array[]>;
  readdir(
    path: string,
    options?: { encoding?: BufferEncoding | null; withFileTypes?: false } | BufferEncoding | null,
  ): Promise<string[]>;
  readdir(
    path: string,
    options: { encoding: "buffer"; withFileTypes: true },
  ): Promise<DirEnt<Uint8Array>[]>;
  readdir(
    path: string,
    options: { encoding?: BufferEncoding | null; withFileTypes: true },
  ): Promise<DirEnt<string>[]>;
  readFile(path: string, encoding?: null): Promise<Uint8Array>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: string | { encoding?: string | null } | null,
  ): Promise<void>;
  mkdir(path: string, options?: { recursive?: false }): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<string>;
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  watch(filename: string, options?: FSWatchOptions, listener?: FSWatchCallback): IFSWatcher;
  watch(filename: string, listener?: FSWatchCallback): IFSWatcher;
}
export interface IFSWatcher {
  close(): void;
}
export type FSWatchOptions =
  | { encoding?: BufferEncoding | null; persistent?: boolean; recursive?: boolean }
  | string
  | null;
export type FSWatchCallback = (event: "rename" | "change", filename: string | Uint8Array) => void;
export interface DirEnt<T> {
  name: T;
  isFile(): boolean;
  isDirectory(): boolean;
}
export type BufferEncoding =
  | "ascii"
  | "utf8"
  | "utf-8"
  | "utf16le"
  | "ucs2"
  | "ucs-2"
  | "base64"
  | "base64url"
  | "latin1"
  | "binary"
  | "hex";

export interface FileSystemTree {
  [name: string]: DirectoryNode | FileNode | SymlinkNode;
}
export interface DirectoryNode {
  directory: FileSystemTree;
}
export interface FileNode {
  file: { contents: string | Uint8Array };
}
export interface SymlinkNode {
  file: { symlink: string };
}
```

### A.3 Process

```ts
export interface WebContainerProcess {
  exit: Promise<number>;
  input: WritableStream<string>;
  output: ReadableStream<string>;
  kill(): void;
  resize(dimensions: { cols: number; rows: number }): void;
}
```

### A.4 Events

```ts
export type PortListener = (port: number, type: "open" | "close", url: string) => void;
export type ServerReadyListener = (port: number, url: string) => void;
export type PreviewMessageListener = (message: PreviewMessage) => void;
export type ErrorListener = (error: { message: string }) => void;
export type OpenListener = (text: string) => void;
export type CodeListener = (type: CodeEventType, event: CodeEvent) => void;
export type Unsubscribe = () => void;
export type CodeEventType = "open" | "diff";
export interface CodeEventFile {
  filepath: string;
  line?: number;
  column?: number;
}
export interface CodeEvent {
  files: CodeEventFile[];
}
```

### A.5 Preview script

```ts
export interface PreviewScriptOptions {
  type?: "module" | "importmap";
  defer?: boolean;
  async?: boolean;
}
```

### A.6 Preview messages

```ts
export enum PreviewMessageType {
  UncaughtException = "PREVIEW_UNCAUGHT_EXCEPTION",
  UnhandledRejection = "PREVIEW_UNHANDLED_REJECTION",
  ConsoleError = "PREVIEW_CONSOLE_ERROR",
}
export interface BasePreviewMessage {
  previewId: string;
  port: number;
  pathname: string;
  search: string;
  hash: string;
}
export interface UncaughtExceptionMessage {
  type: PreviewMessageType.UncaughtException;
  message: string;
  stack: string | undefined;
}
export interface UnhandledRejectionMessage {
  type: PreviewMessageType.UnhandledRejection;
  message: string;
  stack: string | undefined;
}
export interface ConsoleErrorMessage {
  type: PreviewMessageType.ConsoleError;
  args: any[];
  stack: string;
}
export type PreviewMessage = (
  | UncaughtExceptionMessage
  | UnhandledRejectionMessage
  | ConsoleErrorMessage
) &
  BasePreviewMessage;
```

### A.7 Utilities & StackBlitz-specific (stub targets)

```ts
export function reloadPreview(
  preview: HTMLIFrameElement,
  hardRefreshTimeout?: number,
): Promise<void>;
export function isPreviewMessage(data: any): data is PreviewMessage;
export declare function configureAPIKey(key: string): void;
export declare const auth: AuthAPI; // Tier 3 stub
export declare function setupConnect(options?: { editorOrigin?: string }): void; // Tier 3 stub
export interface AuthAPI {
  init(options: {
    editorOrigin?: string;
    clientId: string;
    scope: string;
  }):
    | { status: "need-auth" | "authorized" }
    | { status: "auth-failed"; error: string; description: string };
  startAuthFlow(options?: { popup?: boolean }): void;
  loggedIn(): Promise<void>;
  logout(options?: { ignoreRevokeError?: boolean }): Promise<void>;
  on(event: "logged-out", listener: () => void): Unsubscribe;
  on(
    event: "auth-failed",
    listener: (reason: { error: string; description: string }) => void,
  ): Unsubscribe;
}
```

## Appendix B — exact call sites in this repo (as of 2026-07-11)

| API used                | Where                                                                                   | Shape                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `WebContainer.boot`     | `src/contexts/webContainerRuntimeSupport.ts:574`                                        | `{ coep: "require-corp", forwardPreviewErrors: true, workdirName: "next-editor-runtime" }` |
| singleton               | `webContainerRuntimeSupport.ts:50–56, 566–611`                                          | `getOrBootSharedWebContainer()` — instance + bootPromise dedupe                            |
| `fs.readdir`            | `webContainerRuntimeSupport.ts:222`                                                     | `{ withFileTypes: true }`; uses `.name`, `.isDirectory()`, `.isFile()`                     |
| `fs.readFile`           | `webContainerRuntimeSupport.ts:246, 259`                                                | binary and `"utf-8"` forms                                                                 |
| `fs.writeFile`          | `webContainerRuntimeSupport.ts:454`                                                     | `string \| Uint8Array` (base64-decoded client-side)                                        |
| `fs.mkdir`              | `webContainerRuntimeSupport.ts:371`                                                     | non-recursive, EEXIST try/caught                                                           |
| `fs.rm`                 | `webContainerRuntimeSupport.ts:425, 439`                                                | plain and `{ recursive: true, force: true }`                                               |
| `fs.watch`              | `src/contexts/useWebContainerWorkspaceSync.ts:106`                                      | `(".", { recursive: true }, cb)`; optional-feature guarded at :127                         |
| `mount`                 | `useWebContainerWorkspaceSync.ts:146`                                                   | `FileSystemTree` from `createWorkspaceTree()` (`webContainerRuntimeSupport.ts:287–356`)    |
| `spawn` (commands)      | `src/contexts/useWebContainerRuntimeSession.ts:419, 516`                                | `(cmd, args, { env }?)`                                                                    |
| `spawn` (terminal)      | `useWebContainerRuntimeSession.ts:633`                                                  | candidates `jsh`→`bash`→`sh`, `{ env, terminal: { cols, rows } }`                          |
| `process.output`        | `useWebContainerRuntimeSession.ts:431, 529, 651`                                        | `.pipeTo(new WritableStream({ write }))`                                                   |
| `process.input`         | `useWebContainerRuntimeSession.ts:647`                                                  | `getWriter()` / `write()` / `releaseLock()`                                                |
| `process.exit`          | `useWebContainerRuntimeSession.ts:247, 454, 560, 677`                                   | awaited for status transitions                                                             |
| `process.kill`          | `useWebContainerRuntimeSession.ts:56, 233, 248, 271, 643`                               | try/caught, idempotence assumed                                                            |
| `process.resize`        | `useWebContainerRuntimeSession.ts:795`                                                  | `{ cols, rows }`                                                                           |
| `on("server-ready")`    | `useWebContainerRuntimeSession.ts:321–334`                                              | sets previewPort/previewUrl/status                                                         |
| `on("port")`            | `useWebContainerRuntimeSession.ts:337–358`                                              | lifecycle tracking                                                                         |
| `on("error")`           | `useWebContainerRuntimeSession.ts:361–378`                                              | status="error"                                                                             |
| `on("preview-message")` | `useWebContainerRuntimeSession.ts:381–390`                                              | console-error / uncaught / rejection capture                                               |
| `setPreviewScript`      | `webContainerRuntimeSupport.ts:586`                                                     | recorder script, once per boot                                                             |
| `teardown`              | `webContainerRuntimeSupport.ts:608`                                                     |                                                                                            |
| `reloadPreview`         | `src/components/preview/runtimePreview.ts:154`                                          | dynamic import, `iframe.src` fallback at :148–159                                          |
| preview URL → iframe    | `src/hooks/usePreviewController.ts:751–759`                                             | `iframe.src = runtimePreviewUrl` after srcdoc removal                                      |
| COEP/COOP headers       | `vite.config.ts:9–12, 147–172`; `infra/worker/index.ts:20–30`; `infra/wrangler.toml:65` | global `require-corp` — see §8.4 CORP requirement                                          |
