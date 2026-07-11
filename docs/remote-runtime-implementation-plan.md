# Remote Runtime — implementation plan

**Prerequisite reading:** [remote-runtime-design.md](./remote-runtime-design.md) — the design
doc is normative; this plan sequences it into phases and atomic tasks. Section references
(§n) below point into the design doc.

**Audience:** implementing agents (Sonnet 5 / Opus 4.8 class) and engineers. Each task is
written to be executable by a focused agent with only: this file, the design doc, and the
repo. Tasks list their inputs, outputs, and acceptance criteria. Tasks marked ∥ within a phase
are independent and may run in parallel.

---

## 0. Ground rules for implementers (read first)

Repo conventions that override generic habits:

1. **Package manager is `bun`** (`bun.lock`). Never run npm/yarn/pnpm. New TS deps: `bun add`.
2. **Tests**: run via the repo's vitest wrapper (`npx vp test run <file>`), not bare `vitest`.
   Typecheck with the repo's tsc script (see `package.json` scripts) before declaring done.
3. **React Compiler is on** — do not add `useCallback`/`useMemo` for referential stability.
4. **State**: app-level stores use `@xstate/store-react` (`createStore`/`trigger`/`useSelector`
   — see `src/**/workspaceStore.ts` for the pattern). Do not hand-roll
   `useSyncExternalStore`/localStorage plumbing and do not add Zustand.
5. **Commits**: Conventional Commits; commit on the current branch; no Anthropic co-author
   trailer. If multiple agents work in parallel, **serialize the commits** (pre-commit
   stash/pop corrupts parallel commits in this repo) or use worktrees.
6. **Cloudflare work (Phase 5)**: before writing Worker/DO/Container code, load the
   `cloudflare`, `durable-objects`, and `sandbox-sdk` skills (or fetch current CF docs) —
   Containers config and limits change quickly; do not code from memory.
7. **xstate is pinned to 5.32.2** (tsgo bug). Don't bump it while touching runtime code.
8. **Don't use the in-app preview browser to verify** — typecheck + tests; the user eyeballs UI.
9. **Deploy** (when asked): `bun run build` then `wrangler deploy` from `infra/`; remote D1
   migrations and container image pushes are separate, explicitly-authorized steps.

Definitions used below:

- **T1/T2/T3** = compatibility tiers from design §3.
- **RCP** = the wire protocol, design §6 (frame formats, method table, limits).
- **Agent** = the in-container Go binary, design §7.

---

## 1. Target file layout

```
docs/remote-runtime-design.md                (exists)
docs/remote-runtime-implementation-plan.md   (this file)

src/runtime/compat/types.ts        RuntimeContainer, RuntimeKind, re-exported WC types
src/runtime/compat/factory.ts      getOrBootSharedRuntime(), runtime selection
src/runtime/compat/stubs.ts        Tier-3 stubs (auth, setupConnect, configureAPIKey)
src/runtime/compat/reloadPreview.ts

src/runtime/rcp/frames.ts          control/binary frame codec
src/runtime/rcp/channels.ts        channel mux + credit flow control
src/runtime/rcp/errors.ts          errno mapping → Error objects
src/runtime/rcp/types.ts           method/param/result/event types (protocol source of truth, TS side)

src/runtime/remote/RemoteContainer.ts
src/runtime/remote/RemoteFs.ts
src/runtime/remote/RemoteProcess.ts
src/runtime/remote/connection.ts   WS lifecycle, reconnect/resume, keepalive
src/runtime/remote/mountZip.ts     FileSystemTree ⇄ zip (fflate)
src/runtime/remote/previewMessages.ts  postMessage listener → on("preview-message")

sandbox/agent/                     Go module (see Phase 2 for internal layout)
sandbox/images/                    Dockerfile.base, Dockerfile.node22, Dockerfile.go1.24, …
sandbox/local-broker/              Bun HTTP server: docker provision + preview proxy
sandbox/conformance/               cross-runtime conformance spec (Phase 3)

infra/worker/runtime/routes.ts     /api/runtime/* + preview ingress
infra/worker/runtime/sessionDo.ts  RuntimeSessionDO
infra/wrangler.toml                + containers, DO binding, preview route
```

---

## 2. Phases

Dependency graph:

```
P0 (compat seam) ──────────────┐
P1 (RCP TS lib) ──┬── P3 (client SDK) ── P6 (editor integration) ── P7 (hardening/rollout)
P2 (Go agent) ────┤                                 │
P4 (local broker) ┴── (conformance CI)              │
P5 (Cloudflare backend) ────────────────────────────┘
```

P0, P1, P2 have no dependencies on each other → start all three in parallel.
P4 needs P2 (an image to run). P3 needs P1 and is _tested_ against P2+P4.
P5 needs P2 image + P4-established conventions. P6 needs P0+P3(+P4 for dev).

---

### Phase 0 — compat seam in the app (no behavior change)

**Goal:** the editor obtains its runtime through an interface, still backed only by
WebContainer. Shippable on its own; zero user-visible change.

| #   | Task                                         | Details                                                                                                                                                                                                                                                                                                                                                  | Acceptance                                                                                                                           |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 0.1 | `src/runtime/compat/types.ts`                | Define `RuntimeContainer` as `Pick<WebContainer, …>` per design §3; `RuntimeKind`; re-export the WC types consumers need (`FileSystemTree`, `WebContainerProcess`, listener types). Type-only imports from `@webcontainer/api`.                                                                                                                          | tsc passes; no runtime import of `@webcontainer/api` added.                                                                          |
| 0.2 | `factory.ts` with only `"webcontainer"` kind | Move the boot-singleton logic from `webContainerRuntimeSupport.ts:566–611` behind `getOrBootSharedRuntime(kind)`. Keep `getOrBootSharedWebContainer()` as a thin delegate so existing imports keep working. Lazy-`import("@webcontainer/api")` inside the webcontainer branch so remote-only sessions skip the WASM download later.                      | Existing tests pass (`npx vp test run`); editor behavior unchanged.                                                                  |
| 0.3 | Retype consumers                             | `useWebContainerRuntimeSession.ts`, `useWebContainerWorkspaceSync.ts`, `webContainerRuntimeSupport.ts` helpers accept `RuntimeContainer` instead of `WebContainer`. Fix any type errors this exposes (they mark accidental deep-surface usage — if a consumer needs something outside `RuntimeContainer`, widen the interface deliberately and note it). | tsc + tests pass; grep shows no remaining `: WebContainer` types outside `src/runtime/compat/` and the support module's boot branch. |

Commit: `refactor: route runtime access through RuntimeContainer interface`

---

### Phase 1 — RCP protocol library (TypeScript)

**Goal:** pure, I/O-free protocol code shared by client SDK and test harness. Everything here
is spec'd in design §6 — implement exactly that (frame layouts, method table §6.3, events
§6.4, credit §6.6, limits §6.7).

| #     | Task                 | Details                                                                                                                                                                                                                                                                                                    | Acceptance                                                                                                         |
| ----- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1.1 ∥ | `rcp/types.ts`       | Method/params/result/event interfaces for every row of §6.3–6.4, `protocolVersion = 1` constant, error codes union.                                                                                                                                                                                        | tsc; exhaustive `Method → {params, result}` mapping type.                                                          |
| 1.2 ∥ | `rcp/frames.ts`      | JSON control-frame encode/parse with validation (reject unknown `t`, oversized frames per §6.7); binary frame header pack/unpack (u32 LE channel, u8 flags, FIN bit).                                                                                                                                      | Unit tests: round-trip, malformed input rejection, FIN handling.                                                   |
| 1.3 ∥ | `rcp/channels.ts`    | Channel allocator (odd=client, even=agent), per-channel credit ledger (initial 256 KiB), `ReadableStream`/`WritableStream` adapters that emit/consume binary frames and grant credit from `pull()`.                                                                                                        | Unit tests: backpressure (writer blocks at zero credit), FIN closes reader, interleaved channels don't cross data. |
| 1.4 ∥ | `rcp/errors.ts`      | errno → `Error` with `"<CODE>: <message>"` prefix (design §6.1); `EGONE`/`EPROTO` classified as fatal.                                                                                                                                                                                                     | Unit tests incl. message-shape assertions.                                                                         |
| 1.5 ∥ | `remote/mountZip.ts` | `FileSystemTree → zip` and `zip → FileSystemTree` with fflate (already a dep). Preserve empty dirs (explicit dir entries), symlink nodes as zip symlink entries (mode bits `0xA000` in external attrs), UTF-8 names. This zip is also the `mount(Uint8Array)` snapshot format and the `export(format:"zip" | "binary")` format.                                                                                                 | Unit tests: round-trip trees w/ nested dirs, empty dir, binary file, symlink, unicode filename. |

All 1.x are parallelizable. Commit per task or one `feat: add RCP protocol library`.

---

### Phase 2 — sandbox agent (Go)

**Goal:** the in-container runtime server, design §7. Independent of Phases 0/1 (Go side reads
the same §6 spec). Suggested internal layout:

```
sandbox/agent/main.go              flags: --port 8600 --workspace /workspace/<name>
sandbox/agent/internal/rcp/        frame codec + mux (Go mirror of §6)
sandbox/agent/internal/vfs/        jailed fs ops (securejoin), errno mapping
sandbox/agent/internal/proc/       spawn (creack/pty | pipes), process-group kill, reaper
sandbox/agent/internal/watch/      recursive watcher (rjeczalik/notify), debounce
sandbox/agent/internal/ports/      /proc/net/tcp{,6} poller → port events
sandbox/agent/internal/proxy/      /proxy/{port}/… reverse proxy w/ WS passthrough
```

| #     | Task                                                          | Details                                                                                                                                                                                                                                                                                                                                                                 | Acceptance                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1   | Go module scaffold + RCP codec                                | WS server (`nhooyr.io/websocket` or `gorilla`), hello handshake, ping, frame codec + channel mux + credit (mirror of 1.2/1.3), limits §6.7.                                                                                                                                                                                                                             | `go test ./...`; harness connects, hello returns workdir.                                                                                                                                           |
| 2.2 ∥ | `vfs`: all `fs.*` methods                                     | §6.3 semantics; path jail (§7.2); errno strings exactly as design §6.1; `readdir` returns `kind` trichotomy; streaming read/write over channels.                                                                                                                                                                                                                        | Go unit tests + errno matrix (ENOENT, EEXIST on non-recursive mkdir, ENOTEMPTY on rm non-recursive dir, ENOTDIR, EISDIR). Jail test: `../`, absolute, and symlink-escape attempts all fail.         |
| 2.3 ∥ | `proc`: spawn/PTY/kill/exit                                   | §7.1. PTY when `terminal` set (`pty.StartWithSize`); else pipes with merged interleaved output; `Setpgid`; kill = SIGTERM group, SIGKILL after 2 s; `proc.exit` event then FIN outCh; ENOENT spawn rejection; env merging over a sane base (PATH incl. toolchains, HOME, TERM=xterm-256color); `cwd` support; `output:false` suppresses output frames. SIGCHLD reaping. | Tests: `stty size` reflects spawn dims and resize; merged ordering of stdout/stderr writes; exit codes incl. signal deaths (137/143); kill kills grandchildren (`bash -c 'sleep 100 & sleep 100'`). |
| 2.4 ∥ | `watch`                                                       | Recursive watcher per §7.3: rename/change mapping, relative `/`-separated filenames, 10 ms per-path debounce, watch-count limit → `ELIMIT`.                                                                                                                                                                                                                             | Tests: create/modify/delete/mv files in nested dirs produce expected event streams.                                                                                                                 |
| 2.5 ∥ | `ports` + `proxy`                                             | §7.4 poller (300 ms, state 0A, dedupe, ignore agent's own port) emitting `evt port`; §7.5 reverse proxy at `/proxy/{port}/…` with WebSocket upgrade passthrough and streaming bodies.                                                                                                                                                                                   | Tests: start `python3 -m http.server`-equivalent in-test listener → open event within 1 s, close on exit; proxy passes chunked bodies and a WS echo.                                                |
| 2.6 ∥ | `mount` / `export`                                            | Unpack uploaded zip (temp dir → move-merge, symlinks honored, `mountPoint` support); export walks tree honoring `includes`/`excludes` globs → zip or JSON-tree per §6.3.                                                                                                                                                                                                | Round-trip test vs the fixtures used by TS test 1.5 (share a `sandbox/conformance/fixtures/` zip corpus so Go and TS agree byte-for-byte on format).                                                |
| 2.7   | `Dockerfile.base` + `Dockerfile.node22` + `Dockerfile.go1.24` | Design §10: debian-slim, non-root uid 1000, agent as entrypoint, `bash`/git/curl/ca-certs; language layers on top. Multi-arch not required in v1 (match backend arch).                                                                                                                                                                                                  | `docker build` all; `docker run runtime-go1.24` then WS smoke test: spawn `go version` exits 0 with output.                                                                                         |

2.2–2.6 are parallelizable after 2.1. Commits: `feat(agent): …` per task.

---

### Phase 3 — client SDK (`RemoteContainer`)

**Goal:** design §5. Depends on P1; integration-tested against P2 image via P4 broker (or raw
`docker run -p` before P4 lands).

| #   | Task                                         | Details                                                                                                                                                                                                                                                                                                                                                                                                                      | Acceptance                                                                                       |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 3.1 | `connection.ts`                              | WS open, hello, keepalive (20 s), request/response correlation, dispatch to channel mux; reconnect/resume per §5.4 (backoff 0.5→8 s ×5, resumeToken, watch re-registration hook, fatal → `error` event).                                                                                                                                                                                                                     | Unit tests with a mock WS server; kill-and-resume test keeps a running process's output flowing. |
| 3.2 | `RemoteFs.ts`                                | All T1+T2 `fs` methods → RCP calls; encoding application client-side (`readFile` decode, `readdir` DirEnt materialization with `isFile()`/`isDirectory()` methods); `watch()` returning `IFSWatcher` and routing `evt fs.watch`.                                                                                                                                                                                             | Conformance rows (3.5) pass.                                                                     |
| 3.3 | `RemoteProcess.ts` + spawn                   | §5.2 exactly: persistent streaming `TextDecoder` per process; input WritableStream → stdin channel; `exit` promise from `proc.exit` evt; `kill()`/`resize()`; both `spawn` overloads.                                                                                                                                                                                                                                        | Conformance rows pass; multi-byte-split decode test (emit `é` split across two frames).          |
| 3.4 | `RemoteContainer.ts` + boot + events + stubs | §5.1 boot flow (POST /sessions → WS → hello); `mount` via mountZip upload; `export`; `on()` emitter with URL rendering from `previewUrlTemplate` (`server-ready` on every port-open); `setPreviewScript` → control-plane PUT; `teardown()`; `previewMessages.ts` window-message listener (§8.3) w/ origin validation; Tier-3 stubs + `reloadPreview` compat export; compile-time `RuntimeContainer` assignability assertion. | tsc; unit tests for URL template rendering + preview-message origin filtering.                   |
| 3.5 | Conformance suite `sandbox/conformance/`     | One parameterized Vitest spec covering **every T1 row of design §3** (and T2 where cheap): fs matrix, spawn/PTY/resize/kill/exit, watch, mount/export round-trip, port + server-ready via a real listener, error-shape assertions (`ENOENT:` prefix). Runs against `RemoteContainer` + local backend in CI; structured so it can later be pointed at real WebContainer in a browser environment.                             | Suite green vs dockerized agent; wired into CI (skip gracefully when Docker absent, loud in CI). |

Commit: `feat: RemoteContainer client SDK` (+ `test: runtime conformance suite`).

---

### Phase 4 — local Docker broker (dev + CI backend)

**Goal:** design §9.3. Small and boring; also unblocks conformance CI.

| #   | Task                           | Details                                                                                                                                                                                                                                                                                                                   | Acceptance                                                                               |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 4.1 | `sandbox/local-broker/` server | Bun HTTP server: `POST /sessions {runtime, workdirName, idleTimeout}` → `docker run -d --rm --memory 1g --cpus 1 --pids-limit 256 -p 0:8600 runtime-{runtime}` → `{sessionId, wsUrl (direct to mapped port), previewUrlTemplate (broker path-based), token}`; `DELETE /sessions/:id`; idle reaper. Image-name allowlist.  | Boot a `RemoteContainer` against it from a script; teardown removes the container.       |
| 4.2 | Preview proxy + HTML injection | `GET /preview/:sessionId/:port/*` → agent `/proxy/{port}/…` incl. WS upgrade; stream-inject stored preview script before `</head>` on `text/html`; set CORP/COEP headers per design §8.4. Keep the injector as a small shared, unit-tested function (it gets re-implemented with HTMLRewriter in P5 — same test vectors). | Header + injection unit tests; vite-dev-server-in-container HMR works through the proxy. |
| 4.3 | Dev ergonomics                 | `bun run sandbox:broker` script; `sandbox/README.md` (2 paragraphs: build images, start broker, point editor at it via `RemoteBootOptions.endpoint`).                                                                                                                                                                     | A fresh checkout can run the Go demo below in <10 min following the README.              |

Commit: `feat: local docker broker for remote runtime`

---

### Phase 5 — Cloudflare backend

**Goal:** design §9.2. **Load the `cloudflare`, `durable-objects`, `sandbox-sdk` skills first**
(rule 0.6); resolve design open-question 1 (raw Containers vs `@cloudflare/sandbox`) against
current docs before writing code, and record the decision + rationale at the top of
`infra/worker/runtime/sessionDo.ts`.

| #   | Task                            | Details                                                                                                                                                                                                                                                                                                                                                           | Acceptance                                                                                                 |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 5.1 | Wrangler config + image publish | `[[containers]]` (or sandbox-sdk equivalent), DO binding + migration for `RuntimeSessionDO`, `preview.{domain}` wildcard route; CI/docs step for `wrangler containers` image push. Mind image-size limits — verify `runtime-go1.24` fits; if not, slim (design §10).                                                                                              | `wrangler deploy` (staging) succeeds; container instance starts and `/healthz` OK.                         |
| 5.2 | `RuntimeSessionDO`              | Per design §9.2: start container, health-wait, WS proxy (client↔agent, opaque), preview-script storage, idle timer (no WS + no preview traffic → stop), destroy.                                                                                                                                                                                                  | DO unit tests where practical; staging smoke: boot → spawn `go version` → teardown.                        |
| 5.3 | Routes + auth + quotas          | `POST /api/runtime/sessions` (auth: reuse the worker's existing session auth; else signed short-lived token issued to the editor page), runtime-allowlist validation, per-user concurrent + daily-minutes quotas (D1 counters; **local migration only — remote D1 migration is a separately authorized step**), `GET …/:id/ws` proxy, `PUT …/:id/preview-script`. | Route tests; quota-exceeded returns structured error the SDK surfaces cleanly.                             |
| 5.4 | Preview ingress                 | Host-pattern match → DO → agent `/proxy`; HTMLRewriter script injection (reuse P4.2 test vectors); **CORP/COEP headers per §8.4 — the editor's global `require-corp` makes missing CORP render blank iframes**; strip editor cookies; WS/HMR passthrough.                                                                                                         | Integration test asserting headers + injection; staging: Go HTTP server preview renders inside the editor. |
| 5.5 | Conformance vs staging          | Run the P3.5 suite against a staging session (manual/nightly job, not per-PR).                                                                                                                                                                                                                                                                                    | Suite green on staging.                                                                                    |

Commits: `feat(infra): remote runtime sessions on Cloudflare` (split per task as convenient;
serialize if parallel agents).

---

### Phase 6 — editor integration

**Goal:** users can run Go. Depends on P0 + P3 (+P4 for local dev).

| #   | Task                                 | Details                                                                                                                                                                                                                                                                                                                                                                          | Acceptance                                                                                                                                 |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 6.1 | Factory: `"remote"` kind + selection | Extend `getOrBootSharedRuntime` with the remote branch (`RemoteBootOptions` from settings/env: endpoint, runtime). Selection policy per design §5.5: explicit project setting wins; else detect `go.mod`/`*.go` → `go1.24`, `pyproject.toml`/`requirements.txt` → `python3.13`, else webcontainer. Setting stored via the existing `@xstate/store-react` conventions (rule 0.4). | Unit tests for detection; JS projects still boot WebContainer untouched.                                                                   |
| 6.2 | Runtime session hooks over remote    | Audit `useWebContainerRuntimeSession.ts` / `useWebContainerWorkspaceSync.ts` against `RemoteContainer`: shell candidates (`jsh` will ENOENT → loop must advance to `bash` — verify the try/catch), boot-status surface gains "provisioning sandbox…" state, `error` event → reset path releases the remote session.                                                              | Hook tests with mocked RemoteContainer (add the RuntimeKind dimension); manual: terminal into a Go container, `go run .`, preview appears. |
| 6.3 | Runner presets + minimal UI          | Per-runtime default runner commands (`go run .`, `python main.py`, existing node presets) where the runner config initializes; runtime picker in project settings (smallest viable UI — this repo's owner eyeballs UI himself, rule 0.8; consider the `frontend-ux-design` skill for the picker).                                                                                | Preset appears for a fresh Go project; picker persists per project.                                                                        |
| 6.4 | Failure UX + fallback                | Provisioning failure for node-capable projects → offer/auto fallback to WebContainer with a status note; quota errors surfaced with actionable message; teardown on tab close (`beforeunload` best-effort DELETE via `sendBeacon`).                                                                                                                                              | Tests for fallback path; no orphaned sessions after normal close (broker/DO idle reaper as backstop).                                      |

Commit: `feat: remote runtime integration (Go support)`

---

### Phase 7 — hardening & rollout

| #   | Task                  | Details                                                                                                                                                        |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | Reconnect/resume soak | Scripted network-flap test against broker: 30 min terminal session with induced WS drops; no lost output ordering, no duplicated frames.                       |
| 7.2 | Limits & abuse        | Verify §6.7 ELIMITs end-to-end; container egress policy decision (v1 allows egress — document); fuzz the frame parser (Go: `go-fuzz`/native fuzzing on codec). |
| 7.3 | Telemetry             | Session boot latency, reconnects, quota hits — through whatever the worker already uses; no new vendor.                                                        |
| 7.4 | Rollout               | Feature flag default-off → enable for Go/Python detection → announce. Keep WebContainer the default for JS/TS indefinitely (cost).                             |
| 7.5 | Docs                  | Update `README.md` Learn More links + `docs/architecture.html` if the diagram covers runtimes; `sandbox/README.md` finalized.                                  |

---

## 3. Testing matrix (summary)

| Layer                              | Where                                                      | Runs in CI?                         |
| ---------------------------------- | ---------------------------------------------------------- | ----------------------------------- |
| RCP codec/mux (TS)                 | `src/runtime/rcp/*.test.ts`                                | always                              |
| Agent internals (Go)               | `sandbox/agent/... go test`                                | always                              |
| Agent integration (WS over Docker) | Go tests + TS harness                                      | when Docker available; required job |
| Conformance suite                  | `sandbox/conformance/` vs broker                           | when Docker available; required job |
| Staging conformance                | same suite vs CF                                           | nightly/manual                      |
| Editor hooks                       | existing tests + RuntimeKind dimension (`npx vp test run`) | always                              |
| Preview headers/injection          | broker + ingress tests                                     | always / staging                    |

## 4. Risk register

| Risk                                                                              | Likelihood        | Mitigation                                                                             |
| --------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| Blank preview iframes from missing CORP under the app's global COEP (design §8.4) | High if forgotten | Header assertions in P4.2/P5.4 tests; called out in both docs                          |
| CF Containers image-size/instance limits don't fit `runtime-go`                   | Medium            | Verify in P5.1 first; slim images; `runtime-full` may be infeasible on CF — acceptable |
| WS proxying through DO adds latency/limits for high-throughput output             | Medium            | Credit flow control caps memory; measure in P7.1; WebTransport later                   |
| PTY/merged-output semantic mismatches break xterm rendering                       | Medium            | Conformance suite PTY rows; compare against real WebContainer run                      |
| Orphaned sessions cost money                                                      | Medium            | Idle reaper (DO alarm) is the backstop, not the client                                 |
| `jsh`-specific behavior assumed somewhere beyond spawn candidates                 | Low               | P6.2 audit; grep for `jsh`                                                             |

## 5. Definition of done (v1)

- [ ] A Go project (go.mod + main.go HTTP server) can: boot remote runtime, mount, open a
      terminal (bash), `go run .`, get `server-ready`, render live preview in the editor
      iframe, hot-edit a file, save back, teardown cleanly — on Cloudflare staging.
- [ ] JS/TS projects are byte-for-byte unaffected (still WebContainer, no new network calls).
- [ ] Conformance suite green vs local broker in CI; nightly green vs staging.
- [ ] All Tier-1 rows of design §3 implemented; Tier-3 stubs importable.
- [ ] No orphaned containers after a 24 h staging soak.
- [ ] `docs/` updated; commit history in Conventional Commits.
