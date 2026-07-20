# Implementation Status — next-recording VS Code extension

Plan of record: [`docs/vscode-recording-playback-extension-implementation-plan.md`](../../docs/vscode-recording-playback-extension-implementation-plan.md) (repository root).
Research: [`docs/vscode-recording-playback-extension-research.md`](../../docs/vscode-recording-playback-extension-research.md).

This document tracks routine progress and phase-gate evidence. The plan itself is
not modified without explicit approval.

## Phase ledger

| Phase | Description                                      | Status                            |
| ----- | ------------------------------------------------ | --------------------------------- |
| 0     | Preflight and decision recording                 | Done (2026-07-20)                 |
| 1     | Isolated extension scaffold                      | Done (2026-07-20)                 |
| 2     | Capture topology and text-change feasibility     | Done (2026-07-20)                 |
| 3     | Renderer benchmark and decision                  | Done (2026-07-20)                 |
| 4     | Versioned model, journal, and checkpoints        | Done (2026-07-20)                 |
| 5     | Native visual recording vertical slice           | Done (2026-07-20)                 |
| 6     | Artifact finalization and read-only playback     | Done (2026-07-20)                 |
| 7     | Recovery, security, privacy, and scale hardening | Done (2026-07-20)                 |
| 8     | Audio feasibility and integration                | Deferred (gated per plan §12/§15) |
| 9     | Release candidate and handoff                    | Done (2026-07-20, core milestone) |

## Phase 0 evidence (2026-07-20)

### Preflight checks

- Root `CLAUDE.md` read completely. Implementation host is the macOS
  workstation (`Darwin arm64`), so the full verification suite is allowed;
  the VPS process/memory restrictions do not apply here.
- `git status --short` at start: clean worktree on `main`. No unrelated
  changes to preserve.
- The architecture research document was read completely before any
  implementation decision below.
- No root file (`package.json`, lockfile, TypeScript config, Vite config) is
  modified by this project. Root `package.json` declares no `workspaces`
  field, so `bun install` executed inside `vscode-extension/` produces an
  independent `vscode-extension/bun.lock` and does not touch the root
  lockfile.

### Toolchain confirmed on 2026-07-20

- Node.js v24.18.0, Bun 1.3.14 (package commands run from
  `vscode-extension/` only).
- Current stable VS Code Extension API: **1.125** (per `@types/vscode`
  latest stable on the npm registry).

### Dependency and tooling decisions

Exact versions are pinned in `vscode-extension/package.json` +
`bun.lock` at Phase 1. Registry-latest versions verified 2026-07-20:

| Purpose                 | Package                                                                                              | Version verified                                | Rationale                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Extension-host language | `typescript` (strict)                                                                                | 7.0.2                                           | Current registry `latest`, pinned exactly under the extension's latest-toolchain policy.                                  |
| Lifecycle statechart    | `xstate`                                                                                             | 5.32.2                                          | Independently pinned for the extension's fresh coordinator machine; no main-app machine implementation is imported.       |
| Host bundle             | `esbuild`                                                                                            | 0.28.1                                          | Node-targeted CJS bundle for the extension host; fast, zero-config, standard for extensions.                              |
| Webview bundle          | `vite`                                                                                               | 8.1.5                                           | Plan §6.1 mandates Vite for the webview bundle.                                                                           |
| Unit/protocol tests     | `vitest`                                                                                             | 4.1.10                                          | Plan §6.1 mandates Vitest for pure tests.                                                                                 |
| Integration tests       | `@vscode/test-electron` 3.0.0 + `mocha` 11.7.6                                                       | —                                               | Official Extension Development Host test tooling.                                                                         |
| VSIX packaging          | `@vscode/vsce`                                                                                       | 3.9.2                                           | Official packaging tool.                                                                                                  |
| API types               | `@types/vscode`                                                                                      | pinned to the selected engine floor (see below) | Pinning types to the floor makes the compiler enforce the minimum-engine contract.                                        |
| Schema source           | `zod`                                                                                                | 4.4.3                                           | One schema source generates both runtime validators and TS types (plan §7); works in host and webview.                    |
| ZIP write               | `yazl`                                                                                               | 3.3.1                                           | Streaming ZIP writer, independent dependency (plan §9.5 forbids reusing main-app compression code).                       |
| ZIP read                | `yauzl`                                                                                              | 3.4.0                                           | Streaming ZIP reader with explicit entry iteration — needed for archive-safety validation before extraction (plan §13.2). |
| Webview UI              | `react` / `react-dom`                                                                                | 19.2.7                                          | Plan §5 webview layout names React entrypoints (`index.tsx`, `App.tsx`).                                                  |
| Renderer candidate A    | `monaco-editor`                                                                                      | 0.55.1                                          | Benchmark candidate only until ADR 0002 (plan §11).                                                                       |
| Renderer candidate B    | `codemirror` 6 (`@codemirror/state` 6.7.1, `@codemirror/view` 6.43.6, `@codemirror/language` 6.12.4) | —                                               | Benchmark candidate only until ADR 0002.                                                                                  |

None of these decisions copy versions from the main application; each was
verified against the registry on the date above.

### Engine floor (provisional, finalized during Phase 1 scaffolding)

Provisional `engines.vscode`: `^1.86.0`.

Rationale: every API family the plan requires is stable well before 1.86 —
custom readonly editors (1.44), `workspace.onDidChangeTextDocument` with
undo/redo `reason` (1.49), tab/tab-group API incl. `TabInput*` types (1.67),
`TextEditorSelectionChangeKind`, visible ranges, multi-root workspace APIs
(all ≤1.67). 1.86 is chosen as the floor rather than 1.67 because it is the
first release requiring Node 18+ semantics matching our compiled target and
it comfortably predates the current stable (1.125) by >3 years of releases.
`@types/vscode` is pinned to the floor so any accidental use of a newer API
fails typecheck. If Phase 1/2 compilation shows a needed API is missing at
1.86, the floor moves up to the oldest version that has it and this section
plus `README.md` record the change.

- No proposed APIs.
- No VS Code internal module imports.

### Identifiers (fixed by plan §6.3)

- Package name `next-recording`, namespaces `nextRecording.*`, custom
  editor view type `nextRecording.player`, artifact extension
  `.nextrecording`. Centralized in one identifiers module during Phase 1.

### Initial assumptions

- Supported platform for development and first validation: macOS arm64,
  VS Code desktop, local workspaces (single- and multi-root) and untitled
  documents.
- `extensionKind: ["ui"]` per plan §6.3; remote-workspace behavior is
  observed through VS Code APIs but not a validated platform row yet.
- Timebase: `process.hrtime.bigint()` session-relative microseconds
  (plan §7.2).
- Artifact container: streaming ZIP, format documented in
  `docs/artifact-format-v1.md` before v1 is declared stable.

### Deferred capabilities (explicitly out of scope for the core milestone)

- Audio (Phase 8 gate; native helper not created until that phase starts).
- Diff, notebook, terminal, webview, and third-party custom-editor surface
  capture (explicit unsupported-surface markers only).
- VS Code for the Web, cross-window sessions, collaboration/upload,
  `.ne` interoperability, screen/camera capture, horizontal scroll, exact
  fold state, mouse coordinates.

## Phase 1 evidence (2026-07-20)

- Independent package installed with Bun 1.3.14; `vscode-extension/bun.lock`
  created; root lockfile untouched (verified via `git status`).
- Version adjustments against the registry during the original install:
  `@types/react` 19.2.17 and `@types/react-dom` 19.2.3 (the React runtime
  version numbers do not exist for the types packages). TypeScript was
  initially pinned to 5.9.3; the post-review toolchain policy now requires
  registry `latest`, so the current package and lockfile use 7.0.2.
- Acceptance gate results:
  - `bun run typecheck` — pass (host, webview, test configs, strict).
  - `bun run lint`, `bun run format:check` — pass.
  - `bun run verify:boundaries` — pass.
  - `bun run test:unit` — 2 tests pass.
  - `bun run build` — host bundle 3.3 kB, webview bundle 190.6 kB.
  - `bun run test:integration` — 3 tests pass in a real Extension
    Development Host (VS Code 1.129.1, darwin-arm64): activation,
    command registration, and opening a synthetic `.nextrecording` in the
    placeholder custom editor (`vscode.TabInputCustom` with viewType
    `nextRecording.player`).
  - `bun run package` — VSIX 9 files / 64 kB; contents audited: only
    `dist/`, `package.json`, `package.nls.json`, README, CHANGELOG.
- Note: current stable VS Code observed at integration time is 1.129.1;
  the 1.86 engine floor stands.

## Phase 2 evidence (2026-07-20)

Capture feasibility proven against a real Extension Development Host
(VS Code 1.129.1, darwin-arm64).

- Components: `EventClock` (hrtime-based, seq authority), in-memory
  `EventSink`, `DocumentRegistry` (visible-first enrollment, reopen
  identity reuse), `DocumentShadow` (UTF-16 evolving-buffer application +
  full-text verification + SHA-256), `SurfaceRegistry`
  (`WeakMap<TextEditor>`), `TopologyTracker` (weak identity first,
  structural reconciliation fallback, microtask burst reconcile, snapshot
  dedupe, explicit discontinuity flag), `CapturePolicy` (scheme
  classification + size pre-filter), `CaptureSession` orchestrator,
  diagnostic dev commands (`nextRecording.dev.*`, removed at Phase 9).
- Unit tests (15): shadow surrogate pairs/combining marks/CRLF/EOL-only
  transactions/mismatch reset/out-of-bounds + 200-round randomized
  non-overlapping multi-change property test; event clock ordering and
  clamped coalesce timestamps; identifier invariants.
- Integration scenarios (9 new, all passing):
  - Two documents edited alternately — exact shadow hashes, initial
    checkpoint content verified.
  - Same document in two groups — one `documentId`, two `surfaceId`s,
    selection events isolated to one surface, both groups in topology.
  - Multi-cursor edit — exactly one atomic patch with 3 changes.
  - Undo/redo — patch `reason` recorded.
  - Workspace-edit full replace — shadow consistent.
  - Untitled document — `rootId: null`, scheme `untitled`, checkpoint text.
  - Diff editor — `capability.unsupportedSurface` (kind `textDiff`) +
    topology tab, never treated as a text surface.
  - 120-edit rapid burst — **zero lost transactions**, unbroken
    beforeVersion/afterVersion and hash chains, zero shadow mismatches,
    textChange callback mean < 10 ms budget.
  - Topology snapshots deduplicated; structural coherence (unique
    group/tab IDs, active refs valid, ordered view columns).
- Envelope invariants asserted on every trace: `seq` contiguous from 0,
  `tUs` nondecreasing.
- No API gaps found that block the plan; group/tab identity required the
  structural fallback exactly as the research predicted.

## Phase 3 evidence (2026-07-20)

- Pure playback reducer (`SessionReducer`) + renderer contract
  (`Renderer.ts`) + deterministic seeded fixture generator implemented;
  reducer determinism, ground-truth final texts, checkpoint-restore seek
  equivalence, and envelope invariants covered by unit tests.
- Minimal faithful Monaco and CodeMirror 6 adapters implemented against
  the same contract; benchmark harness runs both in a **real VS Code
  webview** (EDH) via `bun run benchmark:renderer`; report at
  `.artifacts/renderer-benchmark.json`.
- **Decision: Monaco** — meets every §11.4 budget (worst seek p95 187 ms
  on the 60-min/250k fixture); CodeMirror fails the seek budget (980 ms
  p95 long-session; 252 ms multi-surface), replays the long fixture 17×
  slower, and degrades at 20 surfaces (134 ms vs 38 ms). Full tables,
  methodology, and caveats (incl. the surrogate-split fixture bug found
  and fixed during the first run) in `docs/adr/0002-player-renderer.md`.
- `@codemirror/*` demoted to devDependencies, referenced only by the
  dev-only benchmark bundle (`dist/benchmark`, excluded from VSIX).
- Note: this phase's commit also lands the completed v1 event union in
  `model/events.ts` (audio + session lifecycle types) because the reducer
  compiles against it; runtime validators land with Phase 4.

## Phase 4 evidence (2026-07-20)

- `zod` 4.4.3 added as the runtime-validator source (`model/schemas.ts`):
  full v1 event union, ManifestV1, session metadata, seek index. Type
  equivalence pinned by compile-time assignability (SessionEvent →
  wire event) plus runtime samples of all 29 event types; fixture streams
  validate end-to-end.
- `OrderedJournalWriter`: single-owner append handle, bounded queue with
  soft-limit overload signal (never drops content events), 100 ms/64 KiB
  flush, 1 s fdatasync, `lastDurableSeq` advances only after sync, and
  ordered **barriers** so checkpoint bodies are durable before their
  journaled reference (plan §9.4).
- `JournalReader`: streaming NDJSON with recovery semantics — one
  discardable tail line; malformed pre-tail line stops at last verified
  seq with recorded corruption; seq/tUs invariants enforced; byte offsets
  captured for the seek index.
- `CheckpointStore` (atomic, hash-verified), `SessionMetadataStore`
  (temp+fsync+rename), `SessionPaths`, `RecoveryService` (scan/inspect/
  guarded discard), `SeekIndexBuilder` (1 s buckets), pure
  `validateSessionReplay` (sequence/time/IDs/bounds/hash chains).
- Crash simulation: journal truncation at 44 byte positions including
  mid-line cuts recovers exactly the durable prefix (test
  `journalRecovery.test.ts`); corruption, gap, and decreasing-time cases
  covered; checkpoint corruption detected on verified read.
- Working-session + artifact format documented in
  `docs/artifact-format-v1.md` (draft until Phase 6 declares v1 stable).

## Phase 5 evidence (2026-07-20)

- An extension-owned XState 5 coordinator implements the plan §8.1
  lifecycle (idle → preparing → recording → stopping → finalizing → idle;
  active failures pass through an explicit failed/cleanup state). Session
  IDs guard stale asynchronous completions. No main-app machine code is
  imported. Entering stopping synchronously removes capture subscriptions
  and enqueues final state before the first filesystem await; context keys
  and status UI update only after legal machine transitions.
- Capture events flow into the durable journal via `DurableSessionSink`;
  checkpoint bodies ride the same ordered pipeline as barriers, so a
  journaled checkpoint reference is never durable before its body.
- Stop sequence: subscriptions off → final checkpoints for dirty docs →
  `session.stopping` → journal drain+sync → full headless replay
  validation (schema, seq/tUs, IDs, patch bounds, every hash) →
  `session.finalized` → `finalized.json` + metadata `finalized`.
- `CapturePolicy` honors user configuration snapshotted at recording
  start (`capture.exclude` globs, `maxDocumentBytes`, `includeUntitled`,
  `includeRemote`); configuration contributions added to the manifest.
- Privacy disclosure shown once (modal) before the first recording.
- Status bar: red REC + elapsed + click-to-stop; saving spinner while
  finalizing; hidden when idle.
- Integration tests run in a **multi-root** workspace now; new scenarios
  (all passing in EDH, 16 total):
  - multi-root + untitled session via real `nextRecording.start/stop`;
    metadata `finalized`; journal shows 2 rootIds, untitled descriptor,
    `session.finalized` as last event; zero shadow mismatches.
  - double-start rejected; stop idempotent; state returns to idle.
  - simulated crash (abandoned session) → recovery scan finds it
    (`recoverable: true`, durable events > 0, no corruption) → explicit
    discard removes it.
  - excluded glob (`**/*.secret`): no enrollment, exclusion marker
    present, excluded content provably absent from the journal.
- Machine note: a stale `~/.pnp.cjs` on this workstation makes esbuild's
  automatic Yarn PnP detection reject dependencies; `esbuild.mjs` now
  resolves bare imports with standard Node resolution (kept as a build
  workaround, consistent with the repo's existing PnP alias convention;
  the user's manifest is not touched).
- Finalization originally preloaded all checkpoint bodies. The
  post-implementation review below replaces that with on-demand,
  one-checkpoint-at-a-time replay validation for normal and recovered
  sessions.

## Phase 6 evidence (2026-07-20)

- **Artifact pipeline**: `writeArtifact` derives the ManifestV1 tables from
  the validated journal, builds the 1-second seek index with journal byte
  offsets, hashes every entry (SHA-256), streams the ZIP via `yazl` to a
  temp path, fsyncs, **revalidates by reopening with the real reader**
  (manifest, entries, hashes, `session.finalized` tail, event count), then
  atomically renames into the recording library. Wired into the
  coordinator's stop path; `finalized.json` and session metadata record
  the artifact path.
- **Reader safety (plan §13.2)**: `openArtifact` enforces, before any
  content is served — entry count, traversal/absolute/drive-letter paths,
  duplicate names, directory/symlink entry types, per-entry declared
  sizes, decompression ratio, manifest/index size caps, format-version
  fail-closed, and per-entry hash verification on read. 12 hostile-archive
  unit tests (hand-built raw ZIPs with valid CRCs plus a deflate bomb)
  all fail closed; tampered checkpoint bodies are detected at read time.
- **Recording library**: artifacts live under extension storage;
  `nextRecording.open` lists/opens them (no workspace required);
  `nextRecording.export` copies to a user-chosen destination (streamed
  local copy; size-bounded remote fallback with a warning); the stop
  notification offers Open/Export.
- **Playback**: versioned zod-validated protocol on both sides
  (PROTOCOL_VERSION 2, request IDs, duplicate/late-response safe, chunked
  20k-event windows, checkpoints on demand); `PlaybackEngine` (pure TS)
  with the §10.4 visual clock, checkpoint-plan seeks, deterministic
  group→surface assignment; Monaco renderer per ADR 0002; reconstructed
  equal-width group layout with tab bars, unsupported-surface
  placeholders, error view; pause-on-hide + compact state persistence
  (`setState` playhead/rate). CSP: nonce script, `worker-src blob:` for
  Monaco's inlined worker, no remote origins.
- **EDH evidence (19 integration tests passing)**: a real recorded
  session produces an artifact that passes the reader stack in-host;
  opening the player never changes any workspace document version and
  dirties nothing; the ready handshake proves the player bundle (incl.
  Monaco) boots under the CSP; a garbage `.nextrecording` fails closed.
- Deferred to the manual matrix (plan §16.6): visual confirmation of
  play/pause/seek interactions and hide/reopen playhead restore (engine
  logic covered by unit tests; the repo owner prefers eyeballing UI).

## Phase 7 evidence (2026-07-20)

- **Recovery UX**: activation scans only the extension's session
  directory; a non-blocking notification offers "Recover…"; the real
  `nextRecording.recover` command lists interrupted sessions with
  Finalize / Inspect / Discard / Defer (plan §9.8). Context key
  `hasRecoverableSession` kept current.
- **Idempotent finalization**: `finalizeRecoveredSession` recovers the
  durable journal prefix, drops truncated tails, truncates at pre-tail
  corruption (recorded in `finalized.json`), appends explicit
  `session.recovered` + `session.finalized` events, revalidates the full
  replay, rewrites the journal atomically, and packages through the same
  artifact writer. Re-running returns the existing artifact. Validation
  refusal and packaging failures record `failed` + message in session
  metadata and preserve the working directory.
- **Failure injection tests** (all passing at the Phase 7 gate): journal
  write failure after the handle dies (the reviewed implementation now
  makes drain reject promptly; later enqueues are ignored and the durable
  prefix remains intact); truncated tail; pre-tail corruption; missing checkpoint body;
  discarded-session refusal; idempotency; EDH end-to-end crash → finalize
  → artifact passes the fail-closed reader → rescan shows non-recoverable.
- **Scale**: the 60-minute/250k-event fixture flows through the real
  journal writer → artifact writer → reader end-to-end with bounded heap
  growth (asserted) and a >3000-bucket seek index.
- **Diagnostics (plan §17.3)**: "Next Recording" output channel,
  `nextRecording.diagnostics.level` (`off`/`info`/`debug`), structured
  primitive-field formatter (audited by test — no document text, no
  absolute paths can flow through the API shape).
- **Config surface complete (plan §18)**: capture.* (Phase 5) plus
  `playback.defaultSpeed` (flows through recording.metadata into the
  player; persisted webview state wins on reopen) and
  `diagnostics.level`.
- EDH total: 20 integration tests passing.

## Phase 9 evidence (2026-07-20) — core visual milestone RC

- Dev/diagnostic commands (`nextRecording.dev.*`) register only when
  `extensionMode !== Production`: absent from installed VSIX builds, kept
  for EDH tests.
- ADR 0003 records the container decision (ZIP + content-addressed
  integrity, fail-closed reader, atomic finalize order).
- Reproduction fixtures (plan §21.4, synthetic content) committed under
  `fixtures/recordings/` — minimal, multi-document (3 docs/2 groups),
  same-document-two-surfaces, and an intentionally corrupt artifact —
  generated by `scripts/generate-fixture.mjs` through the real storage
  stack and pinned by `test/artifact/checkedInFixtures.test.ts`.
- Full aggregate `bun run check` green: format:check, lint, typecheck
  (3 configs, strict), verify:boundaries, 87 unit/artifact/recovery/
  protocol tests, host+webview build, 20 EDH integration tests.
- VSIX audit caught and fixed a leak: the dev-only benchmark bundle was
  entering the package (vsce re-exclusion after `!dist/**` is unreliable);
  the packaging script now removes `dist/benchmark`. Final VSIX: 9 files,
  916 KB compressed (host 510 KB, player 2.95 MB uncompressed) — only
  `dist/extension.js`, `dist/webview/*`, manifests, README, CHANGELOG.
- Clean-profile install smoke test: the VSIX installs into a fresh
  `--extensions-dir`/`--user-data-dir` via the VS Code 1.129.1 CLI and is
  listed as `channyeintun.next-recording@0.0.1`.
- README rewritten as user-facing docs incl. known limitations; format doc
  marked stable; CHANGELOG updated.
- Deferred: Phase 8 (audio) per plan §12 gating — no audio capability is
  advertised anywhere (manifest `capabilities.audio: false`,
  `docs/test-matrix.md` intentionally not created until the helper spike
  starts). Manual-matrix items (§16.6): visual eyeballing of the player,
  extension-host reload during recording, remote SSH/Dev Container rows,
  light/dark theme pass.

## Post-implementation review (2026-07-20)

This pass reviewed the implementation against its own format, capture,
recovery, and playback invariants. It does not change the approved plan or
the main application.

### Corrections applied

- **Capture continuity:** pending topology is flushed at stop; visible
  surfaces now retain stable recorded group/view-column placement and emit
  corrected state after tab-group reconciliation or a view move. Reopened
  documents preserve version and EOL transitions, and version-only changes
  produce an explicit state checkpoint instead of breaking the next patch
  chain.
- **Capture limits:** initially oversized documents no longer leave a
  provisional ID that can leak into topology. If an edit crosses the selected
  size limit, capture checkpoints the last in-limit state and never persists
  the oversized text. The public setting is capped at the artifact's 20 MiB
  checkpoint ceiling.
- **Playback correctness:** `resume`, shadow-mismatch, and size-limit
  checkpoints are available during forward playback; seek reconstruction
  now includes patch, EOL, resume, version, and language state. Patch bounds
  and version chains fail closed. Rapid asynchronous seeks are generation
  guarded so an older result cannot overwrite a newer slider position.
  Recorded group IDs drive same-document split-surface assignment.
- **Lifecycle and memory:** the player unsubscribes, rejects pending
  requests, disposes Monaco, and clears caches on teardown. The host releases
  its full event array after the last window is copied to the webview,
  checkpoint caches are byte/code-unit bounded, and finalization/recovery
  validate checkpoint bodies one at a time rather than preloading every
  historical body. Failure cleanup resolves the prior operation before
  publishing `idle`, preventing a re-entrant start from inheriting an old
  resolver.
- **Journal durability:** writer failures now make `drain()`/`close()` fail
  instead of silently succeeding; the coordinator records failure metadata
  and stops capture. A queue overload triggers a controlled failure-reason
  stop, including when it first occurs during preparation. The reader uses
  streaming UTF-8 decoding, distinguishes an unterminated crash tail from a
  malformed newline-terminated record, and caps event counts. Concurrent
  closes share one terminal operation, while the crash-test path releases
  timers and the file handle without draining queued events.
- **Artifact hardening:** manifest, integrity, index, event-journal, and
  checkpoint reads have explicit limits; canonical v1 entry names and
  agreeing integrity tables are enforced; uncovered entries, unsafe IDs,
  invalid UTF-8, inconsistent manifest document tables, and checkpoint
  metadata/body mismatches fail closed. Repeated reads no longer consume the
  extraction budget repeatedly. Artifact construction removes failed temp
  files and reopens every checkpoint before the atomic rename.
- **Protocol/UI details:** both sides enforce protocol version 2 and bounded
  payloads, response types are correlated with request IDs, CSP nonces use
  cryptographic randomness, language and explicit EOL state reach Monaco,
  resumed surfaces use the same renderer options, and cancelling a remote
  export no longer reports a successful export.
- **Lifecycle authority:** the hand-written transition flags were replaced by
  an independently pinned XState 5 machine. Stale operation events are
  rejected by session ID, failure cleanup is explicit, and the stop boundary
  now closes capture synchronously before metadata I/O.
- **Toolchain currency:** the extension's independently pinned TypeScript
  compiler was upgraded to the registry `latest`, 7.0.2.
- **Atomic outputs:** metadata/checkpoint and artifact temporary names use
  exclusive randomized files, and failed writes remove their temporary
  output.
- **Regression coverage added:** UTF-8 chunk boundaries, malformed final
  journal records, writer rejection, resume/version replay, invalid patch
  bounds, aggregate payload limits, checkpoint journal cross-checks,
  split-group capture mapping, state-carrying forward playback, stale
  asynchronous seek cancellation, capture-size boundary behavior, explicit
  EOL projection, replay continuity checks, and XState lifecycle/stale-event
  transitions. Synthetic surface events now preserve their surface/document
  association, so the strengthened reducer checks exercise valid topology.

### Remaining high-risk assumptions

- The webview still materializes the complete event stream to support its
  current binary-search/checkpoint seek plan. The host no longer retains a
  duplicate after transfer, but multi-million-event recordings need a paged
  or worker-backed event store before the configured five-million-event
  ceiling can be considered a safe practical limit.
- Surface-to-group correction depends on VS Code's public tab-group view
  settling by the scheduled topology reconciliation. The strengthened EDH
  split-editor assertion must be run on the macOS workstation across the
  supported VS Code floor/current versions.
- The new cache ceiling intentionally reports a player error instead of
  risking webview OOM when required checkpoint text exceeds 64 Mi UTF-16
  code units. A true large-session player would need eviction plus async
  prefetch, not a larger unbounded cache.
- Audio remains deferred, and the existing manual visual/reload/remote/theme
  matrix is still outstanding.

### Review verification status

- `git diff --check` — pass on the Linux VPS.
- `node vscode-extension/scripts/verify-boundaries.mjs` — pass; the extension
  remains isolated from main-app source and machines.
- npm registry `latest` resolves to TypeScript 7.0.2; the extension package
  and lockfile pin it exactly, and that compiler accepts the host, webview,
  and integration-test tsconfigs via `--showConfig`.
- Bun syntax transpilation of all 43 changed TypeScript/TSX files — pass
  (parse-only; not a typecheck or bundle).
- Strict targeted TypeScript 7.0.2 checks — pass for the extension-owned
  XState machine, ordered journal writer, replay reducer/fixtures, playback
  engine, and replay validator.
- Focused Bun tests — 46 pass across the XState lifecycle, ordered writer,
  injected writer failure, journal recovery, schemas, session reducer, replay
  validation, and playback engine.
- The artifact test could not load because this VPS checkout does not have the
  extension dependency `yazl` installed. Full format/lint/typecheck/unit/
  build/EDH/package verification remains intentionally deferred under the
  low-memory VPS policy. Run `bun run check` and the manual matrix on the
  macOS workstation before release; the historical green results below
  predate this review patch set.

## Verification log

| Date       | Phase | Commands                                                                                                                          | Result   |
| ---------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 2026-07-20 | 0     | (docs only — no source yet)                                                                                                       | n/a      |
| 2026-07-20 | 1     | `bun run check` equivalent (format:check, lint, typecheck, verify:boundaries, test:unit, build, test:integration, package)        | all pass |
| 2026-07-20 | 2     | typecheck, lint, verify:boundaries, test:unit (15), build, test:integration (12 incl. 9 capture scenarios)                        | all pass |
| 2026-07-20 | 3     | typecheck, lint, test:unit, benchmark:renderer (12 renderer×fixture runs, all correctness pass)                                   | all pass |
| 2026-07-20 | 4     | typecheck, lint, verify:boundaries, test:unit + test/recovery (49 tests), build, test:integration                                 | all pass |
| 2026-07-20 | 5     | typecheck, lint, test:unit (55), build, test:integration (16 incl. 4 recording-lifecycle scenarios, multi-root workspace)         | all pass |
| 2026-07-20 | 6     | typecheck, lint, test:unit (73 incl. 12 artifact + 3 protocol), build (Monaco player 3.1 MB), test:integration (19)               | all pass |
| 2026-07-20 | 7     | typecheck, lint, test:unit (83 incl. recovery-finalizer, writer-failure, 250k-event scale), test:integration (20)                 | all pass |
| 2026-07-20 | 9     | `bun run check` (format, lint, typecheck, boundaries, 87 unit, build, 20 integration), package, VSIX audit, clean-profile install | all pass |
