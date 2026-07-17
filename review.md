# Source architecture and performance review

Date: 2026-07-17

Scope: `src/`, its direct dependencies, and the Cloudflare collaboration Durable Object that sits on the critical path for `src/collaboration/upstashRoomProvider.ts`. This is a design review only; no implementation has been changed.

## Executive conclusion

I would **not replace React, React Router, XState, Yjs, Monaco, WebContainer, rrweb, MessagePack, or fflate wholesale**. They are reasonable choices for this product. A framework migration is unlikely to make the application 3–5× faster because the expensive work is caused by data flow and transport decisions, not those frameworks.

There are, however, several targeted changes where a 3–5× improvement is credible:

1. Put the new-room collaboration write-ahead log in the room Durable Object's SQLite storage, then acknowledge and broadcast through the Durable Object output gate. The server currently waits for an external Upstash Redis write before either action. Removing that network hop is the best candidate for a 3–5× reduction in edit-to-remote latency when Redis RTT is the dominant part of the trace.
2. Make a Monaco edit event the single incremental input to collaboration, workspace state, recording, and WebContainer sync. The current path repeatedly turns the whole editor/Y.Text into strings and recomputes project-wide derived state. For a small edit in a large file, changing work from proportional to document/project size to proportional to edit size can readily exceed 3–5×.
3. Stop serializing and posting the entire preview DOM after mutation batches, currently as often as once per animation frame. rrweb is already recording DOM mutations. Request a sanitized full snapshot only at checkpoints that need one. On a dynamic page this can eliminate nearly all full-snapshot work between those checkpoints.
4. Make recording download/storage genuinely streaming. The SCR3 reader currently retains all compressed bytes while also retaining decoded records, and repeatedly copies all decoded record references into snapshots. A sliding parser plus delta delivery and OPFS storage can make peak compressed-buffer memory bounded instead of proportional to recording size.

The exact multipliers depend on project size, page activity, and network topology. They should be treated as benchmark targets, not promises. The exact savings I could establish statically are:

- Base64 makes an `n`-byte Yjs update `4 * ceil(n / 3)` characters. For normal-sized payloads that is 33.3% wire expansion; binary is exactly 25% smaller than the equivalent base64 text before counting its JSON envelope and conversion copies.
- The injected vendored rrweb bundle is 434,513 bytes raw / 101,602 bytes gzip. A local Rolldown build exporting only `record` and `takeFullSnapshot` from the installed rrweb is 184,117 bytes raw / 56,171 bytes gzip: 57.6% less raw and 44.7% less gzip. This was an isolated bundle diagnostic, not a measured production chunk delta.
- Collaboration-specific client code in `CollaborationContext`, the provider, project adapter/protocol, relative-position logic, and cursor labels is about 3,284 lines. A standard Yjs binary protocol and Monaco binding can remove a meaningful part of that, but room permissions, control events, asset handling, and migration logic remain product-specific.

## Priority order

| Priority | Change                                                                | Main result                                                             | Confidence                                                                 |
| -------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| P0       | Durable Object SQLite hot log; async cold replication                 | Removes external Redis RTT from every new-room edit before broadcast    | High confidence in causality; 3–5× latency is a benchmark candidate        |
| P0       | Incremental Monaco/Y.Text/workspace event pipeline                    | Removes whole-file and whole-project work from ordinary typing          | High; likely over 3–5× CPU/allocation improvement for large files/projects |
| P0       | On-demand runtime DOM snapshots                                       | Removes repeated `outerHTML`, regex, allocation, and `postMessage` work | High; gain scales with DOM size and mutation frequency                     |
| P1       | `y-monaco` plus Yjs v13-compatible `y-protocols` binary framing       | Less custom code, no base64 update path, native edit/cursor deltas      | High on wire/LOC savings; latency benefit must be measured                 |
| P1       | Incremental SCR reader plus delta delivery; OPFS for large recordings | Much lower peak memory and fewer growing-array copies                   | High on memory shape; storage latency depends on browser/device            |
| P1       | Recorder-only rrweb build and split record/replay packages            | 44.7% smaller gzip in the local injection spike                         | High for injected bundle; production chunk must be re-measured             |
| P1       | Binary asset handles instead of base64 in workspace state             | 25% fewer payload bytes plus fewer encode/decode copies                 | High                                                                       |
| P2       | Native `fetch`, shared slides implementation, dependency cleanup      | Lower LOC/dependency surface                                            | High, but not a 3–5× runtime win                                           |

## The hot path today

An ordinary editor change fans out into several forms of whole-state work:

```text
Monaco model change
  ├─ editor.getValue() → workspace project clone → dirty/sidebar/editor recomputation
  │                                      └─ syncVersion → scan project → full-file WebContainer write
  ├─ Y.Text.toString() / full-string affix scan → Yjs update
  │                                      └─ 75 ms batch → base64 JSON → Durable Object
  │                                                                  └─ await Upstash → ack/broadcast
  └─ encode previous + next full strings → WASM diff → recording frame

Preview DOM mutation
  ├─ rrweb mutation recording
  └─ documentElement.outerHTML → regex over full HTML → cross-frame full-string postMessage
```

That duplication, rather than a slow rendering framework, is the central issue.

## 1. Live collaboration

### Findings

- `src/collaboration/upstashRoomProvider.ts:36,317-360` uses a fixed 75 ms batch window. During continuous traffic this contributes 0–75 ms before network work (about 37.5 ms median and 71 ms p95 if arrivals are uniformly distributed); an isolated edit can pay the full window.
- `movePendingUpdatesToOutbox()` calls `Y.mergeUpdates([...batch, update])` while building every candidate and then merges the final batch again (`upstashRoomProvider.ts:336-360`). That repeatedly merges/copies the same prefix.
- The WebSocket abstraction accepts only strings, and document messages are Zod-validated JSON containing base64 (`upstashRoomProvider.ts:66-74,833-840`; `src/collaboration/yjsUpdates.ts:13-47`). This adds the exact base64 expansion above, a JSON envelope, intermediate binary strings, and byte-by-byte decode copies.
- Bootstrap always downloads and applies the room snapshot followed by every paged update (`upstashRoomProvider.ts:698-739`). It does not exchange a Yjs state vector and send only the missing difference.
- `flushOutbox()` waits for one acknowledgement before sending the next update (`upstashRoomProvider.ts:774-813`). One slow acknowledgement causes head-of-line blocking.
- `projectCollaborationDocument()` reconstructs the node tree, sorts children/paths, builds maps, and calls `Y.Text.toString()` for every text file (`src/collaboration/projectDocument.ts:390-510`). `nodeAtPath()` invokes this full projection even for a single lookup (`:561-568`). Cursor publication also invokes it (`src/contexts/CollaborationContext.tsx:572-595,751-766`).
- `replaceFileContent()` converts the full `Y.Text` to a string, scans its common prefix/suffix against the next full editor string, and writes chunked replacements in separate transactions (`projectDocument.ts:522-541,580-612`). Monaco and Yjs already expose incremental edits, so this work is avoidable.
- The workspace adapter rebuilds its `Y.Text`-to-node map on every Yjs transaction and converts each changed text to a full string (`src/collaboration/workspaceAdapter.ts:30-56`).
- Most importantly, `infra/worker/collaboration/roomDurableObject.ts:465-488` awaits `appendCollaborationUpdate(redis, ...)` before sending the acknowledgement or broadcasting. Remote collaborators therefore wait on an external Upstash call for every edit. The Wrangler migration already declares this class as SQLite-backed (`infra/wrangler.toml:121-123`), but its room document is not stored there.

### Recommended architecture

#### A. Make the Durable Object the hot durable authority for new rooms

For each room, store an append-only, idempotent update table and compacted snapshot in that room's private SQLite storage:

- In the WebSocket message handler, validate authorization and limits, insert the update keyed by `updateId`, and update the per-room sequence in one storage transaction.
- Perform the local SQLite write, then invoke the acknowledgement and broadcast without awaiting any external service. Durable Object output gates hold outbound messages until storage writes succeed; failed writes discard the messages. This preserves the important “durable before visible” property without waiting on another region/service.
- Compact updates into a Yjs snapshot using a Durable Object alarm. Keep the update tail needed for reconnects.
- Replicate compacted snapshots to R2 or Redis asynchronously only if cross-system backup/analytics is required. Redis/QStash should not be on the interactive path for new rooms.
- Retain the existing Upstash transport for legacy rooms during migration. Select behavior by the existing protocol/transport version instead of attempting an in-place flag day.
- Preserve `updateId` deduplication and enforce role/version checks in the Durable Object. Client-side read-only state is not a security boundary.

This change should be implemented with timing fields around receive, durable insert, ack, broadcast, and remote apply. If the existing Upstash append is a large fraction of edit-to-remote p95, this is the most likely 3–5× latency win in the codebase.

Durable Objects have a fixed placement after creation. Choose the initial location deliberately (normally near the room creator) and measure geographically mixed rooms; no protocol library can remove speed-of-light latency to a poorly placed room.

#### B. Bind Monaco directly to `Y.Text`

Add [`y-monaco`](https://github.com/yjs/y-monaco) for the active collaborative model. It maps Monaco changes to `Y.Text` operations and can render remote selections/cursors from awareness. This can replace the active-file full `getValue()` / `setValue()` reconciliation and a substantial amount of relative-position and decoration code.

Important boundaries:

- Continue using the application control plane for membership, invites, role changes, host actions, R2 assets, and recording policy.
- Scope `Y.UndoManager` origins carefully so remote edits and programmatic playback/model replacement are not added to local undo history.
- Keep a feature-flagged fallback until IME composition, multi-cursor edits, file switches, reconnection, and read-only transitions pass integration tests.
- Do not let `y-monaco` mutate a read-only model merely because awareness connected; server enforcement still wins.

#### C. Reuse the standard binary Yjs wire protocol

Use the Yjs v13-compatible release of [`y-protocols`](https://github.com/yjs/y-protocols) for sync and awareness framing over the existing authenticated Durable Object WebSocket. The current project is on Yjs 13, so pin a compatible stable version rather than following Yjs 14 package-transition examples blindly.

This does **not** require adopting the simple `y-websocket` server. The existing server has product-specific authorization and durability requirements. Reusing the standard binary sync/awareness messages gives the useful parts:

- `ArrayBuffer` WebSocket messages rather than base64 JSON for document/awareness data;
- state-vector negotiation and missing-update responses;
- established awareness expiry semantics;
- compatibility with `y-monaco` and optional local persistence.

Keep small JSON control messages if that remains clearer. Version the binary document protocol separately, negotiate it at connection time, and support old/new clients during rollout.

Optional: add [`y-indexeddb`](https://github.com/yjs/y-indexeddb) as a per-room local cache. Returning participants can hydrate immediately and exchange only state-vector differences. If enabled, add TTL/LRU eviction, clear data after sign-out/access revocation, and document that shared content persists on the device.

#### D. Make batching adaptive

Cloudflare recommends batching high-frequency messages, so changing 75 ms to zero is not automatically better. A reasonable starting policy is:

- one animation frame (about 16 ms) when the WebSocket is healthy and traffic is light;
- 50–75 ms when update rate or server backpressure rises, or on the legacy SSE/HTTP path;
- immediate flush on blur, save, recording stop, room leave, and before a control operation that requires all edits durable;
- caps by merged byte size and update count;
- merge once per chosen batch, not once for every candidate prefix.

Benchmark Durable Object request/CPU cost as well as client latency. The target is a better latency/throughput curve, not simply the smallest timer.

### What not to adopt for collaboration

- **Do not switch from Yjs to Automerge.** It would require rewriting document schema, provider, Monaco integration, awareness, undo, snapshots, and migrations without addressing the external Redis RTT or whole-project projection work.
- **Do not replace the whole system with Liveblocks or PartyKit solely for performance.** Depending on the deployment choice, that changes hosting, authorization, persistence, cost, and data ownership. It may reduce operational code but does not prove lower latency for this workload.
- **Treat Cloudflare PartyServer / `y-partyserver` as a future spike, not the immediate production replacement.** It supplies reconnection/buffering and standard Yjs hooks and could eventually remove provider/server LOC. Its current public Yjs adapter still calls out gaps such as read-only mode, while this application already depends on role enforcement, durable acknowledgements, custom control messages, asset hydration, and migration from Upstash.
- **Do not use [`yjs-cf-ws-provider`](https://github.com/TimoWilhelm/yjs-cf-ws-provider) as the production provider.** Its own documentation describes it as a learning/demonstration project and points production users elsewhere.

## 2. Editor, workspace state, and WebContainer

### Findings

- `CodeEditor` handles `onDidChangeModelContent` by reading `editor.getValue()` and updating the workspace (`src/components/CodeEditor.tsx:278-295,696-705`).
- Model reconciliation compares `model.getValue()` with the workspace string and may call `model.setValue()` (`src/monaco/models.ts:59-77`). This is another whole-document read and can disturb editor semantics unless heavily guarded.
- Every file-content change clones the project/file maps, increments preview and sync versions, rebuilds editor/sidebar slices, and recomputes dirty state across all files (`src/stores/workspaceStore.ts:153-193,603-655,1131-1164`). Sidebar topology has not changed, but it is still derived and compared.
- Every `syncVersion` causes `WebContainerRuntimeProviderImpl` to fetch the full project and queue a sync (`src/contexts/WebContainerRuntimeProviderImpl.tsx:556-574`). `syncWorkspaceProject()` constructs maps/sets and scans prior and next projects before overwriting the changed file (`src/contexts/webContainerRuntimeSupport.ts:438-509`).
- The queue coalesces while an asynchronous sync is already running, but otherwise normal typing can start a sync per change (`src/contexts/useWebContainerWorkspaceSync.ts:170-212`).
- Recording content deltas encode the entire previous and next strings and run the WASM diff (`src/core/src/utils/frameDelta.ts:47-61`). The algorithm is appropriate for arbitrary rewrites, but ordinary Monaco typing already provides the exact changed ranges.

### Recommendation: one incremental edit event

Define one internal event from Monaco, roughly:

```ts
type TextEditEvent = {
  fileId: string;
  path: string;
  beforeVersion: number;
  afterVersion: number;
  changes: readonly { offset: number; deleteLength: number; text: string }[];
};
```

Use it as the common input:

- `y-monaco` applies the edits directly to `Y.Text` in collaborative sessions.
- Workspace state updates only the changed file and only that path's dirty status. Maintain `dirtyPaths` incrementally against the saved snapshot.
- A separate `treeVersion` changes only for create/delete/move/rename/folder operations. Sidebar lists and sorted topology subscribe to it, not to content keystrokes.
- WebContainer sync keeps a latest-value map keyed by path. Coalesce writes for roughly 50–100 ms per path (tune it), then perform one whole-file `writeFile`, since that is the available filesystem primitive. Flush on explicit run/save and lifecycle boundaries. Keep the existing efficient initial `instance.mount(createWorkspaceTree(project))` path (`src/contexts/useWebContainerWorkspaceSync.ts:143-164`); the change is only for subsequent content edits.
- Recording can store a versioned “apply these edits” delta for ordinary Monaco changes. Retain the existing verified DMP delta as a fallback for bulk replace, imported/remote state, preview HTML, agent rewrites, and periodic keyframes. A new delta variant requires an SCR format/version migration and replay desync tests.

This avoids four independent full-string pipelines. It also gives one place to define ordering for IME composition and Monaco multi-edit events.

### State-management decision

Keep XState. Replacing it with Zustand, Jotai, Redux, or MobX would move the same expensive derivations into different APIs. The useful change is separating topology state, per-file content state, and transient runtime queues, then subscribing to narrower revisions/selectors.

`@tanstack/react-virtual` is installed but unused. Use it for a flattened visible file-tree row list only if real projects reach roughly 1,000+ visible nodes and profiling shows DOM/layout cost. Otherwise remove the dependency; virtualization does not fix the current per-keystroke project scans.

## 3. Preview capture and rrweb

### Findings

- The injected runtime script installs a `MutationObserver` across the whole document. At most once per animation frame after mutations, it evaluates `document.documentElement.outerHTML`, runs a full-string regex to remove scripts, and posts the result to the parent (`src/contexts/webContainerRuntimeSupport.ts:206-212`).
- At the same time, rrweb observes and records the DOM mutation stream. The full HTML message is retained as `lastRuntimeSnapshotRef` and used for recording finalization/refresh fallbacks (`src/components/preview/usePreviewMessageBridge.ts:233-245`; `src/components/preview/usePreviewController.ts:593-641`; `src/core/src/machine/captureActions.ts:687`).
- The code injects a checked-in 434 KB rrweb UMD into every runtime preview even though the iframe only needs `record` and `takeFullSnapshot`.
- The project depends on the legacy aggregate `rrweb` package for both host replay and iframe recording. Current rrweb guidance splits those concerns into `@rrweb/record` and `@rrweb/replay`.
- `inlineImages: true` is intentional because the WebContainer origin disappears after the session. It improves replay fidelity, but full snapshots can duplicate image bytes and incur synchronous serialization work. It should not simply be disabled without a replacement for project-served assets.

### Recommendations

1. Replace continuous snapshot push with request/response. Inject a listener for a host message such as `NEXT_EDITOR_REQUEST_RUNTIME_SNAPSHOT`; serialize once, attach a monotonic DOM version/request ID, and reply. Request at recording start/finalization, explicit refresh/checkpoint, agent DOM inspection, route/load boundaries, and fallback recovery. Rate-limit and coalesce concurrent requests.
2. Let rrweb remain the mutation stream. Do not maintain a second full-DOM stream merely to keep the latest fallback warm. If polling is needed during preview refresh, request snapshots at the existing 100 ms polling points rather than forcing every page mutation to serialize.
3. Switch to `@rrweb/record` and `@rrweb/replay`. Generate a recorder-only IIFE at build time from a pinned dependency, serve/inject it from the application origin, and keep it offline-capable. Do not load it from a CDN. Lazy-load the replay package only on routes/modes that replay.
4. Add a build assertion or size budget for the injected recorder. The local spike's 56,171-byte gzip size is a useful first ceiling, but behavior tests must cover checkpoints, scroll/input, stylesheets, images, and replay recovery before removing the vendored file.
5. Later, replace same-origin image inlining with content-addressed asset capture where practical: persist each image blob once and let replay snapshots refer to the captured asset. Keep `inlineImages` until that path is proven because broken replay images are worse than the storage win.

Keep rrweb itself. Reimplementing DOM serialization, mutation ordering, input/scroll/media behavior, and replay would be a large correctness regression risk.

## 4. Recording, storage, and memory

### What is already good

- SCR3's append-only segmented design is the right shape for crash-resilient recording and progressive playback.
- MessagePack plus per-segment deflate is compact and interoperable with the existing stream.
- The Rust/WASM DMP codec is small and verified. It should stay as the general-purpose delta fallback.
- The codec worker transfers input/output byte buffers for whole-recording encode/decode, avoiding copies on those boundaries.

### Findings

- Segment encode uses synchronous `zlibSync` (`src/storage/streamingRecordingCodec/format.ts:186,233`). Live segment construction can therefore create main-thread bursts even though whole-recording codec operations have a worker path.
- `createStreamingRecordingReader()` grows one `Uint8Array` by doubling and never discards bytes already parsed (`src/storage/streamingRecordingCodec/decode.ts:399-445`). A 100 MB download retains approximately that compressed input in addition to decoded records; growth can transiently retain old and new backing arrays.
- `getRecording()` slices every accumulated event array (`decode.ts:644-666`). URL loading calls it after each 512 KiB of downloaded data (`src/hooks/useUrlLoader.ts:16,332-380`). The number of reference copies grows with both record count and the number of progressive snapshots and can approach quadratic aggregate copying.
- IndexedDB load calls `getAll()` for every stored segment and then allocates a second contiguous result (`src/storage/IndexedDBRecordingStore.ts:181-212`; `concatSegments()` at `:154-168`). Peak memory can hold all individual segment buffers plus the concatenated file.
- `appendSegments()` counts all existing segments to discover the next sequence number on every append (`IndexedDBRecordingStore.ts:275-290`). Sequence should be metadata maintained by the writer, not a repeated index count.
- Binary workspace files are stored as `ArrayBuffer` in IndexedDB, converted to base64 on hydration, kept in project state as strings, converted back for WebContainer, and embedded in a base64 data URL for preview (`src/storage/workspaceAssetStore.ts:156-175,288-320`; `src/contexts/webContainerRuntimeSupport.ts:505-508`; `src/components/BinaryFilePreview.tsx:40`).
- Agent streaming receives cumulative assistant message snapshots and computes a general DMP delta for each snapshot (`src/agent/agentLoop.ts:237-254`). Normal streamed text is append-only.

### Recommendations

#### A. Make the reader truly streaming

- Replace the single growing input with a sliding/ring buffer that retains only the unconsumed header/segment/footer tail. Track total bytes separately for limits and progress.
- The current footer finder scans against the retained stream. Preserve SCR3 compatibility with a careful parser that retains enough tail to distinguish an incomplete segment from the footer; if that makes correctness too fragile, introduce an explicit terminal record in SCR4 while keeping the old reader.
- Expose decoded deltas (`newFrames`, `newPreviewEvents`, etc.) with stable cursors. Add them to the machine rather than constructing fresh full arrays every 512 KiB. Construct a complete immutable `Recording` once at finalization or on explicit request.
- Add a 100 MB/long-recording test that asserts peak retained compressed-buffer capacity, not only decoded equality.

#### B. Use OPFS for large sequential recordings

Use the browser's [origin-private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) for SCR streams above a conservative threshold, with metadata/search fields in IndexedDB and an IndexedDB fallback:

- append SCR3 bytes directly from a worker using a `FileSystemSyncAccessHandle` where supported;
- stream them back into the reader rather than `getAll()` plus concatenation;
- keep camera/audio blobs either as separate OPFS files or existing Blob records, based on measured behavior;
- retain explicit export/import because OPFS is origin-private and may be cleared by the browser/user.

An `idb` wrapper could reduce IndexedDB boilerplate, but it would not fix the memory shape. OPFS plus streaming is the performance change; `idb` is optional LOC cleanup.

#### C. Move live compression off the main thread

Route segment MessagePack/deflate work through a long-lived codec worker and transfer completed byte buffers back. Preserve segment order with a sequence number and bounded in-flight queue. Flush it at recording finalization.

Do not blindly replace fflate with native `CompressionStream`. [`CompressionStream`](https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream) is useful for genuinely streaming, larger payloads and is worker-capable, but per-segment compression ratio/startup cost must be benchmarked and it does not cover every fflate use. First move the known synchronous work off-main; then compare fflate and native deflate on representative segment sizes.

#### D. Store binary assets as binary

Change workspace binary entries from “base64 content string” to a descriptor such as `{ kind: "asset", assetId, mimeType, size }`. Keep the Blob/bytes once in IndexedDB or OPFS, use object URLs for UI preview, and produce `Uint8Array` only when writing to WebContainer or uploading. Recording/project export can stream the asset bytes into its container format.

This saves exactly 25% versus the equivalent base64 payload length and also removes repeated base64 conversion/data-URL allocations. It is especially relevant because room limits permit multi-megabyte assets.

#### E. Fast-path append-only agent output

If the next cumulative assistant message starts with the previous snapshot, emit only the appended suffix in a simple delta. Use DMP only when the provider revises prior text. If the SDK exposes stable raw text-delta events, consume those directly. This is lower priority than editor typing but follows the same incremental principle.

## 5. LOC and dependency opportunities

### Remove Axios and React Query unless another server-state use is imminent

`@tanstack/react-query` and Axios are used only for the landing-page GitHub star count (`src/App.tsx`, `src/queryClient.ts`, `src/hooks/useGitHubStars.ts`). A small hook using `fetch`, an `AbortController`, and a module/session cache can preserve the current “fetch once, hide on error” behavior. Then remove the global `QueryClientProvider`, `queryClient.ts`, Axios, and React Query.

This is primarily dependency/LOC and bundle cleanup, not a meaningful interaction-latency optimization. Keep React Query if near-term work will add several real server-state queries with invalidation, pagination, and mutations; one badge does not justify it by itself.

### Share the two slides implementations

`src/hooks/useSlides.ts` (287 lines) and `src/hooks/useSlidesController.ts` (282 lines) contain nearly duplicate slide state/event logic. The controller is used internally; `useSlides` is exported from the public core entrypoint. Extract one pure slide controller/reducer and have both APIs wrap it, or make the public hook delegate to the same store-backed implementation. This should remove roughly 200–250 lines while preserving the public API. It is a clearer LOC win than adding a new state library.

### Keep Zod

Zod is used broadly at trust boundaries and is also present through other dependencies. Replacing it with Valibot or handwritten guards would produce migration churn and would not remove all Zod bytes. Optimize only schemas proven hot; the collaboration binary data plane can parse a small fixed header without applying Zod to every byte payload while still validating JSON control messages.

### Split large orchestration modules, but do not add a framework for it

`workspaceStore.ts`, `usePreviewController.ts`, the editor machine, `upstashRoomProvider.ts`, capture actions, and `CollaborationContext.tsx` are large because they combine multiple protocols/lifecycles. Split them along tested state-machine boundaries (transport, sync, awareness, room control; preview refresh, rrweb, runtime bridge) after the data-flow changes. This improves reviewability and test isolation but should not be presented as a runtime optimization.

## Library/framework decision table

| Existing/candidate                                | Decision                        | Reason                                                                                         |
| ------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| React 19 + React Router                           | Keep                            | Not implicated in the traced hot paths                                                         |
| XState                                            | Keep                            | Lifecycle complexity is real; narrow events/selectors and data instead of migrating stores     |
| Yjs                                               | Keep                            | Correct CRDT choice with a strong provider/binding ecosystem                                   |
| `y-monaco`                                        | Add                             | Direct Monaco ↔ `Y.Text` edits and awareness cursors; removes custom full-string plumbing      |
| Yjs v13-compatible `y-protocols`                  | Add                             | Standard binary sync/awareness and state vectors over the existing authenticated socket        |
| `y-indexeddb`                                     | Optional                        | Faster repeat-room bootstrap/offline cache, with privacy and eviction requirements             |
| PartyServer / `y-partyserver`                     | Watch/spike                     | Potential LOC reduction, but current product-specific role/durability gaps block a direct swap |
| Monaco                                            | Keep                            | Editor replacement would be costly and would not fix project/store/transport work              |
| WebContainer                                      | Keep                            | The issue is full-project sync frequency, not the runtime itself                               |
| rrweb                                             | Keep, split packages/build      | Correct domain library; inject recorder-only code and lazy-load replay                         |
| MessagePack + fflate                              | Keep                            | Reasonable SCR segment format; move compression off-main before changing codecs                |
| OPFS browser API                                  | Add for large recordings/assets | Sequential append/read and lower copying than IDB `getAll()` concatenation                     |
| Axios + React Query                               | Remove for current use          | One session-cached, noncritical GET does not need either                                       |
| `@tanstack/react-virtual`                         | Use conditionally or remove     | Helpful only for genuinely large visible trees; currently unused                               |
| Automerge / a new UI state framework / CodeMirror | Do not migrate                  | High rewrite cost; none addresses the identified causes                                        |

## Measurement plan and acceptance gates

Instrument before changing protocols so the result is attributable.

### Collaboration

Measure `Monaco change → provider enqueue → socket send → DO receive → durable append → broadcast → remote receive → Y.Text/model apply` using one trace/update ID. Test:

- 1, 5, and 20 active clients;
- same-region and intercontinental pairs;
- continuous typing, paste of 64 KiB, reconnect with an offline edit tail, and read-only role changes;
- p50/p95/p99 remote-apply latency, bytes/edit, DO CPU, storage operations, reconnect bytes, and duplicate rate.

Acceptance: no durability/ordering regression; at least 2× p95 improvement for the common case, with 3–5× expected only if the Upstash trace proves dominant; binary document bytes at least 25% below the equivalent base64 field before protocol-header differences.

### Editor/workspace/WebContainer

Test 10/100/1,000-file projects and 10 KiB/100 KiB/1 MiB active files with normal typing, multi-cursor edits, IME, format-document, and remote edits. Capture scripting time, allocations, long tasks, React commits, projection calls, and WebContainer writes.

Acceptance: ordinary single-character edits do not project every collaboration file or rebuild sidebar topology; at most one coalesced WebContainer write per path per window; no >50 ms main-thread task in the 100 KiB case; at least 3× lower edit-path CPU/allocation in the 1 MiB case.

### Preview

Use a 5,000-node page with attribute/text animation and a framework page producing frequent DOM mutations. Compare scripting time, `outerHTML` calls, posted bytes, long tasks, and rrweb fidelity.

Acceptance: no continuous full-DOM messages; snapshots only for explicit checkpoints; no loss in refresh/recording recovery tests; injected recorder no larger than the verified recorder-only spike unless a documented feature accounts for it.

### Recording/storage

Use 10/100/500 MB synthetic SCR streams and a real long recording. Measure time to first playable prefix, peak JS heap, retained compressed-buffer capacity, progressive snapshot copy time, storage append p95, and final export integrity.

Acceptance: input buffer stays bounded near the largest incomplete segment/tail rather than total download; progressive updates append only new records; no `getAll()` plus whole-file concatenation on the OPFS path; byte-exact round trips and existing corrupt-stream limits remain enforced.

## Suggested implementation sequence

1. Add the measurement spans/counters above and preserve a reproducible baseline.
2. Remove continuous runtime snapshots and build the recorder-only rrweb injection. These are isolated and high-confidence.
3. Introduce the incremental workspace/topology split and per-path WebContainer write queue without changing recording format.
4. Move new-room persistence to Durable Object SQLite behind a transport/protocol version; keep legacy Upstash rooms readable.
5. Add `y-monaco`, binary sync/awareness, state-vector bootstrap, and adaptive batching behind feature flags.
6. Add the streaming reader delta API and OPFS path. Then evaluate an SCR4 edit-delta variant and binary asset descriptors.
7. Do the low-risk LOC cleanup: native star-count fetch, shared slides controller, unused dependency removal, and module splitting.

If only one latency project is approved, choose Durable Object SQLite after instrumentation. If only one client-performance project is approved, choose the incremental Monaco/workspace/WebContainer event path. If only one low-risk optimization is approved, choose on-demand preview snapshots.

## Primary references

- [Yjs Monaco binding](https://github.com/yjs/y-monaco)
- [Yjs protocols](https://github.com/yjs/y-protocols)
- [Yjs provider and persistence ecosystem](https://github.com/yjs/yjs)
- [Yjs WebSocket provider](https://github.com/yjs/y-websocket)
- [Cloudflare Durable Object WebSocket best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Durable Object SQLite storage and output gates](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare Durable Object data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Cloudflare PartyServer repository](https://github.com/cloudflare/partykit)
- [`y-partyserver` adapter status](https://github.com/cloudflare/partykit/blob/main/packages/y-partyserver/README.md)
- [rrweb guide and split packages](https://github.com/rrweb-io/rrweb/blob/main/guide.md)
- [WebContainer filesystem API](https://webcontainers.io/api)
- [Origin-private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- [Compression Streams API](https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream)

Suggested commit message: `docs: add source architecture performance review`
