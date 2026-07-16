# Source code review

Reviewed at commit `7e7d4f0` on 2026-07-15. The review covered the human-authored TypeScript/TSX under `src` (311 included files, approximately 56,000 lines including tests) and followed the main data flows across workspace state, WebContainer synchronization, recording/streaming, persistence, previews, the API client, agent tools, slides, observability, and route composition. Existing tests were read alongside their implementations.

Per the requested scope, `src/components/LandingPage.tsx` and `src/components/ArchitecturePage.tsx` were excluded. The learn page and the top-level `infra`, `tube`, and `remote-runtime` directories were also excluded. Generated/minified vendor code, lockfiles, and compiled artifacts were inventoried but not manually line-reviewed. Shared code called by an included feature remains in scope even when an excluded composition root imports it.

Severity meanings: **P1** should be addressed before relying on the affected workflow for durable or untrusted data; **P2** is an important correctness, privacy, or scalability improvement that can follow the P1 work. No P0 release blocker was found. The most valuable architectural direction is to establish one canonical, revision-aware workspace reconciliation boundary and one explicit finalized-recording manifest; several findings below are symptoms of those two missing contracts.

## Remediation status

All findings below describe the reviewed `7e7d4f0` baseline. Follow-up implementation is now
complete for all 14 items; the original findings and fix plans remain intact as the audit record.

| Finding                               | Implemented remediation                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace path containment            | One typed canonical parser now protects store construction, persistence hydration, ZIP/UI/agent/runtime boundaries, canonical collisions, reserved keys, trailing empty names, and file/directory conflicts. Arbitrary mount trees use null-prototype dictionaries.                                                                               |
| Reverse-sync races and saved baseline | Workspace revisions and runtime generations invalidate stale reads; forward/reverse filesystem work shares serialized queues; external reconciliation preserves the durable snapshot and dirty state.                                                                                                                                             |
| Live SCR3 parity                      | Live streams include whiteboard/chat, append authoritative final metadata, and share one event-track descriptor with one-shot export. Semantic parity covers every track, slides, captions, media references, and idle duration.                                                                                                                  |
| Binary asset durability               | Asset writes reject typed failures, use generation-addressed records, commit before localStorage metadata, serialize overlapping saves, expose recoverable UI state, and leave failed saves dirty.                                                                                                                                                |
| Session-replay privacy                | A stable blocked editor root covers workspace/runtime/agent/API/slides/playback; upload recovery is blocked too. Exception payloads drop preview errors and redact messages, context, breadcrumbs, commands, credentials, request/response data, queries, and person updates. The data contract is documented in `docs/observability-privacy.md`. |
| Slide CSS isolation                   | HTML, markdown, and Google SVG render in sandboxed unique-origin frames. Google animation uses a nonce-restricted, parent-only message bridge; CSP blocks authored scripts, stylesheets, forms, connections, and base changes.                                                                                                                    |
| Bash reconciliation                   | Shell snapshots three-way merge complete file/folder creates, updates, deletes, renames, binary files, entry/active fallback, and concurrent editor edits through the external reconciler and shared runtime mutex.                                                                                                                               |
| Streaming writer memory               | Drained chunks are released, streaming finalization appends a footer without materializing history, writes apply one-at-a-time backpressure, and failure/close delivery is explicit and exactly once.                                                                                                                                             |
| Bash output memory                    | A bounded head/tail accumulator retains at most 20,000 output characters with an exact omission count; timeout is a finite 1–300,000 ms integer and remains independent of output truncation.                                                                                                                                                     |
| Dirty-state completeness              | A symmetric structured diff tracks added/modified/deleted files, encoding and file metadata, folders, project/lesson/entry metadata, and exact return-to-clean transitions.                                                                                                                                                                       |
| API request association               | The pending request is an immutable snapshot keyed by ID; results without that exact snapshot are ignored while the next draft remains editable. Clearing history no longer cancels or corrupts a pending request.                                                                                                                                |
| API response bounds/cancellation      | The iframe incrementally reads at most 1 MiB, rejects oversized declarations, cancels chunked/endless bodies by ID, and ignores late results. Durable history/SCR3 copies have a separate UTF-8-safe 256 KiB cap.                                                                                                                                 |
| Runner command semantics              | Runner/init text is explicitly a sandbox-shell command and executes through `sh -lc`, preserving quotes, escapes, empty arguments, assignments, operators, redirection, and Unicode whitespace.                                                                                                                                                   |
| Resume-after-auth recovery            | The effect is cancellable and caught; transient failures retain the intent and expose retry, while only successful handoff or confirmed terminal outcomes consume it. Unmounts do not hand off or clear pending recovery.                                                                                                                         |

## P1 — Workspace paths are normalized but never made canonical or root-contained

`normalizeWorkspacePath` only strips leading separators, converts backslashes, collapses repeated separators, and trims (`src/types/workspace.ts:214-219`). It leaves `..`, `.`, canonical aliases such as `a/../b`, control characters, and object-special names such as `__proto__` intact. Those paths can enter through inline file creation (`src/components/FileSidebar.tsx:402-419`), unconfirmed agent file writes (`src/agent/tools/workspaceFs.ts:75-90`), and ZIP entries (`src/utils/workspaceZipImport.ts:255-302`). ZIP import also silently overwrites canonical duplicates and does not reject file/directory conflicts.

The same values later become plain-object keys in `createWorkspaceTree` and filesystem operands in `syncWorkspaceProject` (`src/contexts/webContainerRuntimeSupport.ts:292-360`, `388-463`). Two store entries can therefore alias one runtime path, traversal-shaped paths can target a different runtime location than the UI represents, and `__proto__` can change the prototype of an intermediate tree instead of creating a normal entry. This breaks the core invariant that one workspace path identifies exactly one file and can cause silent loss or overwrite during import, mount, or synchronization.

### Fix plan

1. Introduce one trusted path parser that returns a canonical relative path or a typed error. Resolve `.` segments, reject traversal above the root, reject control characters/empty terminal names, and define platform-independent rules for separators and reserved names.
2. Apply it at every trust boundary: local persistence hydration, ZIP/recording import, UI create/rename/upload, agent tools, and runtime reverse sync. Reject canonical duplicates and file/directory conflicts before mutating state.
3. Rebuild `files`, `folders`, `entryFilePath`, and each `file.path` from validated paths in `normalizeProject`; do not retain caller-owned record keys unchanged.
4. Use `Map` or null-prototype dictionaries while constructing arbitrary filename trees, then convert to the WebContainer shape only after validation.
5. Add targeted tests for nested `../`, backslash traversal, canonical collisions, `__proto__`, and file-versus-folder conflicts across ZIP, store, and WebContainer adapters.

## P1 — WebContainer reverse sync can overwrite newer edits and reset the saved baseline

`requestReverseSync` snapshots `currentProject`, awaits a complete recursive runtime read, and then applies the result with `loadProject` (`src/contexts/WebContainerRuntimeProviderImpl.tsx:80-123`). It never verifies that the workspace revision is still the same after the await. Reverse scans are not serialized, so a slower older scan can finish after a newer scan or after an editor/forward-sync change. Most calls also omit a runtime generation (`:77`, `:173`, `:186`), allowing an already-running scan to survive a runtime reset.

Applying the result via `WorkspaceProvider.loadProject` creates a `savedSnapshot` equal to the runtime result (`src/contexts/WorkspaceProvider.tsx:174-200`). The store then replaces its saved baseline and increments `saveVersion` (`src/stores/workspaceStore.ts:1007-1038`) even though nothing was durably written to local storage. A package install that produces a lockfile can consequently clear unrelated dirty state; a reload can then lose changes that the UI had started reporting as saved.

### Fix plan

1. Give every workspace mutation a monotonically increasing revision and capture it with each reverse scan. Before applying, re-read the revision and runtime generation; discard/requeue or merge if either changed.
2. Serialize reverse reads with the existing forward-sync queue so reads and writes cannot cross in flight, and invalidate all pending work on reset.
3. Add a dedicated `reconcileExternalFilesystem` store transaction that atomically applies a diff while preserving the user's durable `savedSnapshot`; reserve `loadProject` for an intentional project replacement.
4. Cover a deferred reverse read followed by an editor edit, two scans resolving out of order, and reset during a scan. Assert both file contents and dirty/saved state.

## P1 — Live SCR3 output silently omits tracks and authoritative final metadata

`RecordingStreamBridge` tracks and emits frames, slides, preview, workspace, runtime, and cursor records, but not the session's whiteboard or chat records (`src/storage/recordingStreamSink.ts:19-28`, `138-166`; session fields are in `src/core/src/machine/types.ts:128-131`). The SCR3 format and one-shot exporter already support both kinds (`src/storage/streamingRecordingCodec/format.ts:73-86`; `encode.ts:320-328`), so this is divergence rather than a format limitation.

The bridge writes its immutable header at recording start with `duration: 0` and without the final slides, captions, tracks, clusters, or snapshots (`src/storage/recordingStreamSink.ts:87-105`). The footer carries only an index (`src/storage/streamingRecordingCodec/format.ts:251-274`). Decode therefore derives duration only from the last segment timestamp and reads slide definitions only from header metadata (`src/storage/streamingRecordingCodec/decode.ts:142-168`). Idle time after the last event is truncated, and slide events can reference definitions that the stream never contains. This contradicts the public promise that the live bytes form the same replayable SCR3 stream as the exporter (`src/core/src/types.ts:252-278`).

### Fix plan

1. Add whiteboard and chat counters/segments to the bridge immediately.
2. Version the stream with an authoritative final-manifest segment (or an extensible footer) containing final duration, slide definitions, tracks, clusters, captions, snapshots, and external media references. Make the decoder merge it over provisional header metadata.
3. Define one parity contract shared by live and one-shot encoders instead of maintaining separate hand-written track lists.
4. Add a contract test that decodes both paths for a recording containing every track, an idle tail, slides, captions, and external media metadata, and compares their semantic recording output.

## P1 — Binary assets are marked saved before IndexedDB persistence succeeds

The local-storage snapshot intentionally strips base64 asset bytes (`src/stores/workspaceStore.ts:79-105`). `saveProject` writes that stripped snapshot, starts `persistWorkspaceAssets` without awaiting it, and immediately calls `markSaved` (`src/contexts/WorkspaceProvider.tsx:140-171`). However, `persistWorkspaceAssets` catches its own failures and resolves successfully, and absence of IndexedDB is also treated as success (`src/storage/workspaceAssetStore.ts:89-106`). The caller's `.catch` can never surface those failures.

On an IndexedDB open, quota, transaction, or availability failure, local storage contains only empty binary payloads while the UI reports a clean saved state. On reload the asset cannot be reconstructed. This is a silent durable-data-loss path for uploaded images, audio, fonts, and other base64 workspace files.

### Fix plan

1. Make asset persistence reject with a typed error (including an explicit unsupported-storage error) instead of logging and resolving.
2. Make `saveProject` asynchronous and mark the snapshot saved only after both metadata and asset persistence complete. Surface a recoverable save error in the UI and keep the project dirty.
3. Store a shared generation/manifest for metadata and asset records so a reload cannot combine two different saves after a partial failure.
4. Add fake-IndexedDB tests for unavailable storage, open failure, quota/transaction failure, and overlapping saves; assert that binary content remains recoverable and dirty state is retained on failure.

## P1 — Session replay privacy rules do not cover agent and runtime output

PostHog session recording is enabled with a stated requirement that user code not reach third-party replays, but the global block selector covers only Monaco and Excalidraw (`src/main.tsx:18-24`). Agent transcripts, tool output, errors, and command confirmations render as ordinary DOM (`src/components/agent/AgentPanel.tsx:406-510`). Runner, shell, and console output render outside either blocked selector (`src/components/TerminalPanel.tsx:424-430`, `549-670`). These surfaces commonly contain pasted source, filesystem paths, tokens printed by commands, request data, and other secrets. Only the API-key input is explicitly marked `ph-no-capture` (`src/components/agent/AgentPanel.tsx:685-695`).

Masking inputs does not protect text that later appears as a DOM text node. The present configuration can therefore send materially sensitive workspace data to PostHog despite the inline privacy claim.

### Fix plan

1. Default-block the complete editor/workspace/runtime/agent/slide area with `ph-no-capture` or a stable root selector, then selectively opt in only non-sensitive navigation chrome if product analytics requires it.
2. Document a data classification for filenames, source, preview content, agent messages, tool calls, terminals, API requests/responses, slides, and recording playback.
3. Add a browser-level privacy check using sentinel source/tool/terminal strings and assert that the session-recorder payload contains none of them.
4. Review exception capture separately so thrown errors and breadcrumbs do not include source, commands, API bodies, or credentials.

## P2 — Sanitized slides can still apply CSS to the host application

The slide sanitizer removes scripts, iframes, event handlers, and dangerous URL schemes, but allows `<style>` elements and nearly arbitrary CSS declarations (`src/utils/sanitizeSlideContent.ts:1-49`). Sanitized HTML and SVG are then inserted directly into the application's document (`src/components/CustomSlideRenderer.tsx:14-35`; `src/components/GoogleSvgSlide.tsx:20-40`). A raw or imported slide can include a nested style rule targeting `body`, buttons, dialogs, or shared class names, allowing it to hide controls, spoof surrounding UI, trigger remote CSS resources, or make the editor unusable without executing JavaScript.

This is an isolation gap at an untrusted recording/import boundary. Attribute filtering cannot provide document isolation because CSS selectors intentionally operate outside the slide subtree when markup shares the host document.

### Fix plan

1. Render authored/imported HTML and SVG in a sandboxed, unique-origin iframe with a narrow message protocol. Keep presentation controls outside that frame.
2. As an interim mitigation, reject `<style>` and URL-bearing CSS, and apply a property allowlist to `style` attributes. If style elements are a product requirement, parse and scope selectors with a real CSS parser rather than regular expressions.
3. Add regression tests proving slide CSS cannot alter a sentinel host element, load an external stylesheet/resource unexpectedly, or cover host controls.

## P2 — Agent bash reconciliation ignores deletions and renames

After a confirmed shell command, `foldContainerChangesIntoStore` reads the full runtime project but only creates or updates files present in that result (`src/agent/tools/bash.ts:53-72`). It never removes store files that disappeared in the container or reconciles folders and the entry path. Thus `rm file` appears successful to the agent while the editor/export still contains the file; `mv old new` creates the new path but leaves the old one. The two workspace representations then remain divergent and a later write can resurrect stale content.

### Fix plan

1. Reuse the revision-aware workspace reconciler proposed for reverse sync. Diff the complete runtime snapshot against the current project and atomically apply deletes (deepest first), creates, updates, folders, entry path, and active-file fallback.
2. Preserve the durable saved baseline so shell-generated changes remain visibly unsaved until the user saves.
3. Coordinate the agent command with runtime forward/reverse queues so a concurrent editor write cannot be overwritten.
4. Add focused tests for `rm`, `mv`, recursive directory deletion, binary files, entry-file deletion, and an editor change made while the runtime scan is pending.

## P2 — The “streaming” writer retains and recopies the entire recording

`createStreamingRecordingWriter` retains every appended chunk for its full lifetime (`src/storage/streamingRecordingCodec/encode.ts:66-88`). `drainPending` advances an index but does not release drained chunks, and each call copies pending bytes (`:191-195`). `finalize` then concatenates the entire retained stream into another allocation (`:185-190`). `RecordingStreamBridge.finish` invokes that full concatenation and discards its result before draining only the footer (`src/storage/recordingStreamSink.ts:115-128`).

In addition, every bridge flush queues a copied byte array behind an uncapped promise chain (`src/storage/recordingStreamSink.ts:295-303`). A slow sink holds all pending writes while the writer still holds all original chunks. A long recording can therefore require multiple times its encoded size in memory at stop and defeat the purpose of incremental streaming; sink rejection is also fire-and-forget at the hook boundary (`src/hooks/useRecordingStreamSink.ts:43-48`).

### Fix plan

1. Split “append footer” from “materialize all bytes.” Keep a one-shot `toUint8Array` API for export, but let streaming mode finalize without allocating the historical stream.
2. Release drained chunk references while retaining only absolute byte length and the compact footer index.
3. Add bounded backpressure between capture and the sink, with an explicit pause/fail/drop policy and an `onError` path visible to the host application.
4. Test byte parity after many drains, retained-byte bounds, a slow/rejecting sink, and exactly-once close/failure semantics.

## P2 — Bash output is capped only after unbounded accumulation

The bash tool advertises a 20,000-character result cap, but it concatenates every output chunk into one string until the process exits and truncates only afterward (`src/agent/tools/bash.ts:44-50`, `136-165`). A noisy command can consume large browser memory during the default 60-second window. The optional timeout schema also has no positive lower bound or reasonable maximum (`:15-21`).

### Fix plan

1. Drain process output continuously into a bounded head/tail or ring buffer and track the omitted character count without retaining omitted data.
2. Bound individual chunks before concatenation and validate timeout as a finite positive integer within a documented maximum.
3. Preserve enough tail output for error diagnosis and make timeout/abort status independent of output truncation.
4. Add a synthetic many-chunk test that asserts retained output remains bounded and the omission count and exit/timeout message are correct.

## P2 — Dirty-state computation misses deletions and project metadata changes

`getDirtyFilePaths` iterates only current files and compares only their content (`src/stores/workspaceStore.ts:108-135`). A file present in the saved snapshot but deleted from the current project is invisible. Folder-only changes, `lessonType`, `entryFilePath`, encoding, language/name metadata, and other structural changes are also ignored even though their mutators call `withDirtyState` (for example deletion at `:841-945` and lesson type at `:982-1005`).

The resulting `hasUnsavedChanges` is not a reliable persistence invariant: valid project mutations can leave the UI clean and suppress the expected save warning.

### Fix plan

1. Compare normalized project snapshots symmetrically, including added/modified/deleted files, encoding and relevant file metadata, folders, entry path, lesson type, and active-file persistence where applicable.
2. Represent dirty state as a structured diff (added, modified, deleted, and project-metadata flags) so UI messages and reconciliation can use the same truth.
3. Add create/delete/revert, rename, empty-folder, entry-path, lesson-type, and encoding-only tests, including a complete round trip back to clean state.

## P2 — API responses are associated with the editable draft, not the sent request

`useApiClient.send` snapshots method, path, headers, and body for `postMessage`, but stores only the pending ID before calling `markSending` (`src/components/preview/useApiClient.ts:84-115`). The request controls remain editable while a response is pending (`src/components/preview/ApiClientPanel.tsx:145-210`). When the result arrives, `receiveResult` builds history from whatever method/path/headers/body are currently in the store (`src/stores/apiClientStore.ts:108-121`). Editing the next request during a slow call therefore labels the previous response with the wrong request and records incorrect history.

### Fix plan

1. Store an immutable request snapshot under its request ID when sending, and require `receiveResult`/timeout to consume that snapshot.
2. If future concurrent requests are desired, use a map keyed by ID; otherwise keep one pending snapshot but allow the next draft to be edited independently.
3. Add a deferred-response test that edits every request field before resolution and asserts both visible history and recorded request/response events retain the sent values.

## P2 — API response reads are unbounded and parent timeout does not cancel them

The script injected into the runtime preview calls `res.text()` and posts the complete body back to the parent (`src/utils/apiClientBridge.ts:35-38`). It has no byte limit, streaming guard, or `AbortController`. The parent timeout only forgets its pending ID; it sends no cancellation message, so a large or endless response continues consuming memory and network work in the iframe even after the UI reports a timeout. Successful bodies are then retained in API-client history and can also enter recordings.

### Fix plan

1. Read the response stream incrementally with a documented byte ceiling, report truncation metadata, and reject early from `Content-Length` when possible.
2. Add request-ID-scoped cancellation messages and an `AbortController` map in the iframe; cancel on timeout, runtime reset, iframe replacement, and unmount.
3. Bound retained history/recording response bytes independently of the display limit.
4. Test oversized declared and chunked bodies, an endless stream canceled by timeout, and a late result after cancellation.

## P2 — Runner commands use whitespace splitting instead of command semantics

`parseCommand` implements `trim().split(/\s+/)` (`src/contexts/webContainerRuntimeSupport.ts:466-474`) and its result is passed directly to `WebContainer.spawn` for init and runner processes (`src/contexts/useWebContainerRuntimeSession.ts:405-433`, `507-535`). The settings UI presents these fields simply as commands (`src/components/TerminalPanel.tsx:710-732`). Quoted arguments, escaped spaces, empty arguments, and environment assignments are therefore passed incorrectly; pipes and redirections are treated as literal arguments.

### Fix plan

1. Choose and document one contract: store structured `{ command, args }`, or intentionally execute free-form text via `sh -lc`. Structured commands are safer; shell mode is more compatible but should be labeled as such.
2. If retaining a text-to-argv path, use a maintained shell-quoting parser rather than a custom split and reject unsupported operators explicitly.
3. Add tests for quoted/escaped spaces, empty arguments, environment assignments, Unicode whitespace, and any supported shell operators.

## P2 — Resume-after-auth clears recovery state before the recording is loaded

The resume effect starts a detached async function with no catch or cancellation guard (`src/components/CodeRoute.tsx:36-59`). It clears the resume intent before verifying sign-in and before `RecordingStorage.loadById` completes. `loadById` can reject on IndexedDB or decode failure (`src/storage/RecordingStorage.ts:254-264`), producing an unhandled rejection while permanently removing the only retry pointer. The ref is already marked handled, so even a transient failure cannot retry during that mount.

### Fix plan

1. Wrap the workflow in a cancellable async effect with explicit `try/catch`, and avoid state updates after unmount.
2. Clear the intent only after a successful modal handoff, an explicit user dismissal, or a confirmed terminal condition such as canceled sign-in/missing recording. Retain it on transient storage/decode failures.
3. Surface a compact retry/error state rather than silently dropping a signed-in user's pending upload.
4. Test rejected intent load, rejected recording load, missing recording, canceled sign-in, successful resume, and unmount during each await.

Remediation verification honored the repository's low-memory constraint: no full suite, build, or
repository-wide typecheck was run. Seventeen focused test files covering the affected paths passed
(128 tests total), including workspace path/import/persistence/sync races, binary save failures and
overlap, SCR3 parity/backpressure, slide isolation, PostHog privacy, bash bounds/reconciliation,
API request/response/cancellation behavior, and auth-resume recovery. `git diff --check` also passed.
The changed-file linter was attempted with one thread, but this checkout's Oxlint process panicked
inside `oxc_allocator`; it was not retried as a broader or more memory-intensive command.
