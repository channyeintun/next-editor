# Scrimba Research Findings

Last updated: 2026-06-15

## Scope And Method

This analysis covers only the local bundle artifacts under `tmp/`. It does not use Scrimba documentation, network traffic captures, backend source, or source maps.

Confidence levels:

- High: directly supported by surviving class names, method names, action IDs, or literal strings.
- Medium: inferred from nearby methods and object relationships in minified code.
- Low: plausible but not yet traced end to end.

## Bundle Topology

High confidence:

- `tmp/app.UK3DL7B2.js` is the main Scrimba platform/app bundle. It includes content models, routing, app shells, billing/course UI, AI models, and `Scrim*` models.
- `tmp/chunks/ide.36BDFLCO.js` is the IDE/player/runtime bundle. It includes Monaco integration, the stream protocol, editor/file/browser/widgets, WebContainer execution, timeline UI, transcript/audio tooling, and AI workspace actions.
- `tmp/chunks/chunk.L47Z5YT6.js`, `chunk.TIEUX6A3.js`, `chunk.BJMBBBNU.js`, `tsMode.4DHLWYKR.js`, and `typescript.SIWHZMSK.js` are mostly Monaco/TypeScript/editor-language support.
- `tmp/chunks/chunk.QMCWAF6X.js` is shared UI/runtime infrastructure.
- `tmp/chunks/chunk.TZHF2V3H.js` includes CodeMirror/Lezer-style parser infrastructure.
- `tmp/scrim.blank.json.5TFCQ3DL.js` is a default blank workspace layout/state snapshot.

## Main Mental Model

High confidence:

Scrimba is not just recording screen/video. It records an interactive IDE state machine as a stream of typed actions. Those actions mutate editor text, selections, file tabs, file-system state, browser DOM state, browser history, console logs, pointer state, media chunks, snapshots, keyframes, layout, and timeline markers.

Playback is performed by applying or reverting actions. Seeking is therefore state reconstruction, not video seeking. A timeline position maps to a stream action/offset; `IDEStreamCursor` moves to that target by reverting to a common point and replaying forward, including branch routes.

## Content Model Layer

Located mainly in `tmp/app.UK3DL7B2.js`.

High confidence classes:

- `Scrim`: primary content object. Surviving properties include `kind`, `snapshot`, `initial_files`, `refs`, `origin`, `origin_index`, `origin_offset`, `origin_snapshot`, `via_lesson`, `canonical_course`, `template`, `remote_workspace`, `duration`, `calcduration`, `commits`, `recs`, `head`, `base`, `start`, `end`, `edit_captions`, `fix_raw_final_audio`, and AI-agent access/cost fields.
- `ScrimStream`: stream-related access. Surviving methods include `httpUrl`, `trim`, `load_from_prod`, `previewState`, and `getStateAtIndex`. It references `/legacy/files/`.
- `ScrimSnapshot`: stores snapshot `body` and exposes `object` and `preview`.
- `ScrimCommit`: stores `offset`, `summary`, `desc`, `squashed`, `template`, `snapshot`, and marker/dialog UI.
- `ScrimRec`: recording/audio processing record. Fields include `draft`, `final`, `started`, `name`, `offset`, `end`, `byte_offset`, `duration`; methods include `stop`, `edit_clip`, `generate_captions`, `generate_transcript`, `process`, and `probe`.
- `ScrimClip`: audio/timeline clip abstraction with `audio`, `cuts`, `duration`, `has_captions`, `tl`, range/time conversion helpers, `audioslices`, and `transcribe`.
- `ScrimPractice`: exercise/challenge model with status/progress fields such as `started`, `skipped`, `passed`, `completed`, `progress`, `mark_started`, `reset_solution`, and URL conversion.
- `ScrimPreview`: thumbnail/layout state with `entries`, `sidebar`, `drawer`, `layout`, `main`, `runner`, and computed `html`.
- `ScrimAudio`, `ScrimAudioTrack`, `Caption`, `Captions`: audio/caption/transcript models.
- `ScrimArchiver`, `ViteScrimArchiver`, `WebpackScrimArchiver`, `WSPScrimArchiver`: export/download logic for runnable projects.

Medium confidence:

- A `Scrim` can have multiple branch-like stream heads: teacher/origin, learner solution, exercises, and commits.
- Newer workspace-based scrims use `SIWorkspace`; older scrims use widget/file models directly. The code frequently branches on `legacyPhi`/`legacyΦ`.

## IDE/Runtime Layer

Located mainly in `tmp/chunks/ide.36BDFLCO.js`.

High confidence classes:

- `scrim-view`: main custom element for the interactive IDE/player.
- `IDEStream`: branch/stream facade with role flags for `challenge`, `review`, `scribble`, `solution`, `template`, `playground`, `lesson`, `drafting`, `course`, `public`, `editing`, `recording`, `recordable`, `runnable`, `solvable`, etc.
- `IDEStreamAction`: base reversible action class.
- `IDEStreamCursor`: seek/apply/revert coordinator.
- `IDEBranch`, `IDETrunk`, `IDESolutionBranch`, `IDEBranchTimeline`: branch and timeline state.
- `BaseTimeline`, `ClipTimeline`: media/timeline scheduling, captions, audio, offsets, playback rate, seek/play/pause.
- `IDEEditor`, `IDEFile`, `IDEFS`: Monaco/file-system layer.
- `IDEBrowser`, `BrowserPage`, `IDEBrowserHistory`: browser preview and DOM replay.
- `IDEConsole`: console/log panel.
- `IDEPointer`: pointer rendering/autohide state.
- `SIWorkspace`, `SIFS`, `SIBrowser`, `SIWebContainer`, `SIWebConsole`: newer workspace/runtime model.

## Recording And Playback

High confidence:

- Actions are encoded as arrays whose first element is a numeric opcode.
- `IDEStreamAction.deserialize(e,t)` dispatches through an opcode-to-class map (`hd[e[0]]`).
- `IDEStream` uses `OP.msgpack.createUnpacker()` to read stream bytes.
- Stream bytes interleave timing markers, negative action-type markers, and compact encoded action payloads.
- `IDEStream.write(...)` writes an initial absolute timestamp or later time deltas, emits a negative type marker when action type changes, then appends the encoded payload.
- `IDEStream.parsedValue(...)` decodes payloads through the current action class, attaches byte offsets, adds actions to stream indexes, updates text-edit/significant-action caches, and calls `commitToStream`.
- Some action classes implement compact encode/decode strategies. Example: `TextInsertAction` can encode repeated adjacent inserts as just a string when the parent insert's post-selection matches the next insert's start.
- Some actions use a `dedupe` strategy, seen on `PAGE_LOADED` and `PAGE_LOG`.
- `SnapshotAction` and `KeyframeAction` both deserialize legacy widget snapshots; keyframes are specialized snapshots.
- `SaveAction` updates a file's `lastSave` and persisted body, and has a `scrim-save-marker`.
- Marker actions contribute visible timeline markers.
- `pushAction(...)` starts editing if possible, or creates a forked branch when editing is not available. Significant actions mark the `Scrim` edited and can trigger autosave-like behavior after repeated changes.
- `newFork(...)` creates a new `Scrim` with `kind: "scribble"` by default, records `origin`, `via_lesson`, `origin_offset`, `origin_index`, and `origin_snapshot`, then seeds it with a snapshot action.
- `trimToAction(...)` rolls the branch back to an action, removes later recordings/commits, and trims the stream buffer to the target byte end.

Medium confidence:

- The stream protocol is optimized around small, relative arrays. Text selection can encode only the changed suffix when the previous selection has the same prefix.
- `SnapshotAction` is used for initial or recovery state, while normal playback applies incremental actions.

## Stream Persistence And Byte Storage

High confidence:

- `Scrim.stream` is an embedded `ScrimStream`; `ScrimStream` extends `OPDataStream`.
- `ScrimStream.httpUrl` overrides the generic stream URL and returns `${location.origin}/legacy/files/${this.id}`.
- Generic `OPByteStream.httpUrl` returns `/op/stream/${this.id}`, so Scrim streams intentionally use a legacy file URL while other byte streams can use the generic endpoint.
- `OPDataStream.push(...values)` serializes values with `OP.msgpack.packMultiple(...values)` and appends the resulting bytes to the byte stream.
- `OPByteStream.append(bytes)` creates an `OPBinaryChunk` with `offset`, `bytes`, and `target`; the chunk handler loads it into `OPBufferChunks` and triggers cloud flush for locally authored data.
- `OPByteStream` resolves its bytes by `fetch(this.httpUrl, { method: "GET" })`, reads `content-length` into `chunked.knownSize` and `verifiedSize`, then streams response-body chunks into `OPBinaryChunk` objects.
- `OPBufferChunks` stores loaded bytes as linked chunks/fragments with `head`, `tail`, `fragments`, `writeOffset`, and `diskSize`.
- `OPBufferChunks.readableSize` only exposes the contiguous readable prefix from byte offset zero. `IDEStream.syncBuffer` decodes only `stream.chunked.slice(previousReadableOffset, readableSize)`.
- Missing byte ranges are represented by `OPMissingBinaryChunk`; `OPBinaryChunkRequest` can answer a request by slicing a loaded chunk and sending an `OPBinaryChunk` back through `OP.$send`.
- `ScrimStream.trim(offset)` delegates to the normal saved-stream trim path when saved, but for unsaved streams trims the local buffer, clears the socket, and resends the retained prefix.
- `ScrimRec.byte_offset` exists as a numeric model field, but this pass found no client-side assignment outside the `ScrimRec` model definition.
- Modern microphone media bytes are not stored in the main action stream. `AudioRecording` writes browser `MediaRecorder` data into a WebM assembler, appends WebM bytes to `MediaStreamRecording.webm`, and patches the finalized WebM stream through `OPBinaryChunk`.
- `MediaStreamRecording.webm` is an embedded `OPByteStream`; non-legacy media URLs resolve to `/legacy/files/${recording.id}.webm`.
- `IDEStream.load()` is the bridge from content model to action stream:
  - It resolves the `Scrim`.
  - For trunk streams, it awaits `scrim.stream`; if the stream is empty and the scrim exists it calls `stream.load_from_prod()`, then awaits the stream again.
  - If the trunk stream is still empty and an `origin_snapshot` exists for an unsaved scrim, it seeds the stream with an `OPSNAPSHOT`.
  - For non-trunk branches, it finds a parent branch from `origin`, `origin_index`, `origin_offset`, or `seed`; links the branch's first action to the parent seed action; and, if needed, writes a snapshot of the parent state into the child stream.
  - It finishes by calling `syncBuffer()` and marking the branch loaded.

Medium confidence:

- Persisted Scrim stream storage is the raw msgpack multi-value byte stream, served from `/legacy/files/<stream-id>` and updated through `OPBinaryChunk` packets.
- `load_from_prod` is an RPC action whose implementation is server-side and not present in the local bundle; it likely exists to backfill or migrate missing legacy stream bytes.
- `verifiedSize` is a server-confirmed byte count, while `readableSize` is the currently contiguous locally available byte count.
- `ScrimRec.byte_offset` may be legacy/server-maintained metadata for relating recording records to stream byte positions, but that relationship is not implemented in visible client code.

## Editing, Branching, And Recording

High confidence:

- `IDEStream` owns both stream mechanics and user-facing actions such as start editing, jump to end, recording, run, progress marking, solution checking, saving, discarding, and exporting.
- `startEditing` syncs to stream end, checks `editablePhi`/`editableΦ`, sets `mode = "edit"`, and reflows the IDE.
- `stopEditing` sets mode back to view.
- Recording starts through `new_recording`/`newΞrecording`, opens `ide-start-rec-dialog`, writes a marker, creates a `ScrimRec`, enables pointer tracking for legacy mode, and can create an `AudioRecording` when microphone input exists.
- Recording stop writes a sync/timeline marker, sets the recording end offset, calls the recording stop path, stages the recording, saves the `Scrim`, and refreshes the timeline.
- `mark_progress`/`markΞprogress` persists progress and last offset on the `Scrim`; when the timeline is near the end it can mark finished and notify Coursera embed completion.
- `check_solution`/`checkΞsolution` snapshots the current file system and calls an exercise wrapper's server-side solution checker.

## Branch Semantics

High confidence:

- Branch identity is primarily stored on `Scrim` records, not only as stream actions.
- `IDEStream.newFork(options)` captures the current IDE state as a snapshot and builds a new `Scrim` with:
  - default `kind: "scribble"`
  - `owner: OP.user`
  - `origin: this.scrim`
  - `via_lesson: this.lesson`
  - `origin_offset: currentOffset`
  - `origin_index: currentAction.index`
  - `origin_snapshot: snapshot`
  - `spiv: 100` for workspace mode, otherwise `4`
- `newFork` seeds the new scrim stream with `OPSNAPSHOT` when the snapshot has `entries`, otherwise `SNAPSHOT`.
- `IDEStream.createBranch(options)` wraps `newFork` and creates the in-memory branch object for the new scrim.
- `IDEStream.createScribble(...)` forces `kind: "scribble"`, loads the branch, and opens the new scrim head.
- `IDEStream.pushAction(...)` creates a branch automatically when an action is pushed while the current stream is not editable.
- `IDEStream.load()` resolves child branch ancestry through:
  - `scrim.origin` plus `origin_index`
  - `scrim.origin` plus `origin_offset`
  - `ScrimActionRef`
  - `scrim.seed`
- When a parent seed action is found, `IDEStream.load()` sets `parent`, `seed`, `tail`, and `first.prev`, then adds the child branch to the parent branch set.
- `IDEStreamCursor.lineage(...)` walks from an action through branch seeds to build a branch ancestry list.
- `IDEStreamCursor.compare(current, target)` finds a shared ancestor and returns a revert target plus an optional forward route across branches.
- `IDEStreamCursor.sync(...)` reverts to the shared point, steps forward, and follows branch routes by applying the first action of the next branch when crossing a seed.
- Opening a `ScrimPractice` without an existing solution creates a new solution branch with `{ exercise, kind: "solution" }`, loads it, saves the child scrim, and opens it.
- `ScrimPractice.reset_solution` follows the same solution-branch creation pattern from the exercise offset, then reloads the page.
- `ForkAction`, `BranchAction`, `SeedAction`, and `TrimActionAction` classes exist in the action bundle but are minimal in the inspected client code. The operational branch behavior above lives mostly in `IDEStream`, `IDEStreamCursor`, and `ScrimPractice`.
- `scrim-view.sync(...)` treats the current route as a branch-selection signal. It filters route objects into scopes, finds the last routed `Scrim` or `CourseEntry`, resolves an in-memory branch with `branchForModel(...)`, loads that branch, and targets the cursor at the route scope or branch.
- `scrim-view.open(...)` uses `toΞurl()` when opening normal scrims/streams. If the target is already the current branch's scrim, it replaces the path; otherwise it navigates to the generated path.
- `scrim-view.open(ScrimPractice)` creates a solution branch only when the practice has no existing solution: it seeks to the exercise offset, creates a branch with `{ exercise, kind: "solution" }`, optionally names it, loads it, saves the child scrim, and opens it. Existing solutions are opened directly.
- Nested URL generation is client-visible:
  - `Scrim.asΞurl` appends scribbles to `via_lesson` or `origin`, and appends exercise solutions to the exercise scrim URL.
  - `Scrim.toΞurl` nests under the origin's matched route when available, otherwise uses `/<scrim-id>`.
  - `IDEStream.toΞurl` uses its matched route base, otherwise `parent.toΞurl() + /<scrim-id>`, otherwise `/ide/<scrim-id>`.
  - `ScrimPractice.toΞurl` appends the practice-specific suffix to the parent scrim/stream URL.

Medium confidence:

- Editing a non-current or non-editable stream is handled by creating a new branch/scribble and applying the action there.
- Workspace-mode recording staging differs from legacy recording: workspace mode stages through `wsp.sync()` and `ScrimRec.stage().mount()`, while legacy mode enables pointer tracker directly.
- `COMMIT=220` is assigned in the opcode table, but this pass did not find a registered `CommitAction` class; visible commit markers are represented by `ScrimCommit` content models.

## Commit And Marker Semantics

High confidence:

- `COMMIT=220` exists in the opcode enum, but no active `CommitAction` registration or producer was found in `tmp/chunks/ide.36BDFLCO.js`.
- Visible commits are modeled as `ScrimCommit` content records in `tmp/app.UK3DL7B2.js`.
- `ScrimCommit` stores `offset`, `summary`, `desc`, `squashed`, `template`, and `snapshot`.
- `ScrimCommit.marker_offset` returns the commit `offset`, so commits participate in timeline marker placement by model metadata rather than by a decoded stream action in the inspected client.
- `ScrimCommit.as_label` falls back to `"Unnamed commit"` when no summary is set.
- `ScrimCommit.opΞownΞdialog()` renders `ide-commit-dialog` with the commit model as `value`.
- `IDEStream.opΞcommitΞdialog()` renders the same `ide-commit-dialog` with the active branch.
- `ide-commit-dialog` labels the first commit flow as `"Save Scrim"` and later flows as `"Commit"`.
- The dialog edits `value.summary`, supports an `"Update template"` toggle when `scrim.templateΦ` is true, and supports a `"Squash Changes"` toggle bound to `value.squashed`.
- The dialog submit action validates `this.value` when a validator exists and emits `resolve` with `this.value`; commit persistence/creation is not implemented directly in the dialog body.
- `scrim-commit-marker` is the marker UI, and a `ScrimCommit` marker adapter exposes `opΞownΞmarker(...)` to render it.
- `IDEStream.segments` treats a first `ScrimCommit` marker with `squashed` enabled as a segment base/start, filters later markers by `marker_offset`, and builds clip/timeline segments from `ScrimRec` arrays.
- `IDEStream.trimToAction(...)` removes `scrim.commits` whose `offset` is at or after the trim target, alongside later recordings and byte stream data.

Medium confidence:

- Commit metadata is persisted as Scrim model data, while `COMMIT=220` is either legacy, server-side, or reserved for another bundle path not present under `tmp/`.
- Squashed commits hide or collapse individual edits in commit history/timeline segmentation rather than changing the raw action stream bytes in the visible client code.

## Capture Paths

High confidence:

- Text capture is implemented in Scrimba's `TextModel`, not directly in the `IDEEditor` wrapper.
- `TextModel.setupMonaco()` creates the Monaco model and overrides `model.applyEdits`.
- The overridden `applyEdits`:
  - blocks edits on readonly files.
  - calls the native `applyEdits`.
  - marks the batch as significant and preapplied when the IDE is not syncing.
  - emits `LCINSERT` for a single text insertion whose range array has two items.
  - emits `LCDELETE` for a single deletion.
  - emits `LCEDIT` for multi-edit or complex edits.
- `editor-widget` wires Monaco selection changes to `file.model.onDidChangeCursorSelection(...)`.
- `TextModel.onDidChangeCursorSelection(...)` appends selection state to a preceding `LCINSERT`, `LCDELETE`, or `LCEDIT` when possible; otherwise it emits `LCSELECTION` while editing, or stores `file.localSel` while only viewing.
- `TextModel.flushEvents()` sends one queued event through `file.push_(type, params, state)` or batches multiple events through `file.batch_(pairs, state)`.
- Legacy/widget objects implement `push_(type, params, state)` by looking up the action class from the opcode table, building it, and handing it to `ide.cursor.pushAction(...)`.
- Monaco scroll changes are observed in `editor-widget`. The current bundle writes `file.localScroll` and, while editing, assigns `file.scrollTop`/`file.scrollLeft`; those property setters go through widget attributes and can become normal `SET` actions. `TextScrollAction`/`LCSCROLL` exists, but a current producer was not found.
- A later repo-wide string/offset scan found only three `LCSCROLL` occurrences in local artifacts: the opcode enum, the `TextScrollAction` registration/body, and documentation. That supports "no local producer" at high confidence, but not "never used historically."
- Browser preview capture flows through `runner-frame.handle(...)`.
- For tracker messages of type `actions`, `runner-frame` iterates tracker-provided `[opcode, params]` arrays and pushes them through the browser widget with `this.data.push_(opcode, params)`.
- Browser focus/hover/active actions are filtered out unless the pointer tracker is enabled.
- `DOM_MUTATE` actions are dropped for locally initiated pages, avoiding recording local replay mutations as new capture events.
- `PAGE_LOG` payloads can be redacted through `ME.env.redact(...)` before being pushed.
- Other runner messages are converted directly into stream actions or browser state:
  - `domevent` is emitted as an IDE `browserevent` for pointer tracking.
  - `location` updates browser URL state.
  - `history` writes `PAGE_HISTORY`.
  - `pageload` writes `PAGE_LOAD`.
  - `loader:busy`/`loader:done` update loading state.
- The service-worker/container request path returns a tracker URL (`/__sw__tracker.js`) for preview requests.
- WebContainer mode fetches `/assets/tracker.4FYFXZYK.iife.js` and installs it with `webcontainer.setPreviewScript(...)`.
- Pointer capture is handled by the `pointer-tracker` custom element.
- `pointer-tracker` listens globally for `pointermove`, `pointerup`, `pointerdown`, `keydown`, and custom `browserevent`.
- `pointer-tracker.stamp(...)` records `{ x, y, flags, hover, time, targetLayout, prev }` and pushes an `IDEPointerUpdateAction` while recording or debugging outside workspace mode.
- `IDEPointerUpdateAction` uses a schema of `["x", "y", "flags", "hover", "angle", "pressure"]`, delta-encodes coordinates relative to the previous pointer action, and groups pointer updates into `PointerUpdateGroup` segments.
- `IDEPointerUpdateAction.commitToStream(...)` links each pointer action to the previous pointer frame and calls `analyzeAndGroup(...)`.
- Pointer grouping tracks target snapshots by `sref`, pointer-down/up state, movement distance, elapsed time, speed, and target changes; long gaps and slow/stopped motion can break groups.
- `PointerUpdateGroup.finish(...)` analyzes accumulated angles/movement, can mark frames as splitting points, and can split a group at sharp direction changes.
- `ide-pointer-widget` is the replay cursor renderer. It finds the nearest unskipped pointer frame, maps recorded positions to local IDE coordinates, updates hover/hidden/button state, animates target movement through `drawTarget(...)`/`draw()`, and triggers `pointer-wave` click feedback.
- `PointerFrame` is a timeline/editor marker for pointer frames; it flags pressed/up/down/splitting state and stores `data-ref` from the pointer frame's `sref`.
- Modern microphone recording uses `AudioRecording`, `MediaRecorder`, and `MediaStreamRecording`.
- `AudioRecording.onrecdataavailable(...)` collects browser `MediaRecorder` blobs and writes them into a local WebM assembler.
- `AudioRecording.onrecstart(...)` can create a `MediaStreamRecording`, appends WebM data to `model.webm`, and patches the final WebM stream through `OPBinaryChunk`.
- `MediaStreamRecording.webm` is an embedded `OPByteStream`; its non-legacy URL is `/legacy/files/${this.id}.webm`.
- `MSR_START`, `MSR_CHUNK`, and `MSR_END` opcodes exist. This pass found only minimal `MediaStreamStartAction`/`MediaStreamEndAction` classes; `MSR_CHUNK` appears only in the opcode enum in the inspected bundle.
- A later repo-wide string/offset scan found no local `MSR_CHUNK` occurrence outside the opcode enum and documentation. Its producer, if any, is outside these artifacts.

## Browser Preview Replay

High confidence:

`BrowserPage` is the DOM replay engine. It:

- Creates an isolated HTML document named `Player`.
- Stores serialized HTML and attributes.
- Tracks URL, status, logs, history, loading/loaded state, hover/focus/active node, selection, and snapshot.
- Indexes DOM nodes so mutation actions can refer to nodes by path/index.
- Applies and reverts mutation arrays with mutation codes such as insert, remove, set text, set attribute, set property, reflow.
- Rewrites asset URLs to `/blobs/` or object URLs for SVGs.
- Rewrites inline styles and stylesheet URLs.
- Applies pseudo-state classes for focus/hover/active.
- Applies selection to normal text nodes and to `input`/`textarea` selection ranges.

Medium confidence:

- Scrimba records live browser DOM deltas from a tracker script, then replays them in `BrowserPage` rather than driving a real browser session for every historical state.
- Browser console logs are separate stream actions (`PageLogAction`) that also push UI toast/log entries.

## Runtime Execution

High confidence:

- `SIWebContainer` uses the WebContainer API and sets `WEBCONTAINER=true`.
- It boots with `workdirName: "projects"`.
- It mounts a `.bootstrap.mjs` script and spawns `node .bootstrap.mjs`.
- It sets `PATH=/bin:/usr/bin:/usr/local/bin:/tmp/bin`.
- It listens for `port`, `preview-message`, and `server-ready`.
- It can spawn `/bin/jsh --osc` terminals.
- It has an opt-out path via local storage key `WEBCONTAINER_OFF` and skips in embed mode.
- The bundled client points to `/assets/webcontainer.RMFWBHQ3.mjs?file` for the WebContainer bootstrap asset and `/assets/tracker.4FYFXZYK.iife.js` for the preview tracker asset.
- Service-worker/iframe infrastructure includes `ide-sw-container`, `ServiceWorkerFrame`, `runner-frame`, `player-frame`, `__sw__.html`, `__sw__blank.html`, and `__sw__tracker.js`.
- The standalone service-worker/player/tracker HTML or JS artifacts and the WebContainer bootstrap/tracker assets are not present as standalone artifact files under `tmp/` or elsewhere in this repo; the client bundle only references the URLs and implements the message handlers around them.

Medium confidence:

- WebContainer hosts the running project, while `BrowserPage`/tracker infrastructure captures preview state and makes replay deterministic.
- The service-worker frames isolate runner/player origins and route preview/browser requests through Scrimba-controlled message handlers.

## Runtime Request Routing

High confidence:

- `ServiceWorkerFrame.send(message)` is a thin `contentWindow.postMessage(message, "*")` wrapper.
- `ide-sw-container.setup()` creates `ready`, `player`, and `runner` promises, chooses a container id from local storage keys shaped like `sw:cwN`, locks that id for 24 hours, and refreshes the lock every 1.5 seconds.
- `ide-sw-container.origin(suffix)` rewrites the current origin with a container subdomain of the form `<container-id>` or `<container-id>-<suffix>`.
- `ide-sw-container.render()` creates:
  - a runner service-worker iframe at `<container-origin>/__sw__.html?<container-id>`.
  - a player service-worker iframe at `/__sw__.html?<container-id>`.
  - global `message` and `unload` listeners.
- `ide-sw-container.handleMessage(event)` accepts messages from the runner/player service-worker frames, resolves ready promises on `"ready"`, and forwards message payloads to `scrim-view.oncontainermessage(...)`.
- The reply function created by `handleMessage` preserves request correlation by negating positive `ref` values before sending responses back to the originating frame.
- `scrim-view.container` lazily creates the `ide-sw-container`.
- `scrim-view.oncontainermessage(...)` handles service-worker/container request types:
  - `getState`: returns `toContainerSnapshot()`.
  - `request`: forwards to `browser-widget.oncontainermessage(...)` and returns browser history plus tracker URL `${origin}/__sw__tracker.js`.
  - `resolveImportMap`: asks `IDEDependencies` to resolve imports from legacy `IDEFile` widgets.
  - `resolveFile`: resolves files through `IDEFS`, handles `/_env_`, optional bundle generation, catchall paths, Imba compilation, JS/TS transform, and script response wrapping.
- `browser-widget.oncontainermessage(...)` records the current request and pushes non-history-navigation request URLs into `IDEBrowserHistory`.
- `runner-frame.go(url)` encodes non-HTTPS URLs through `IDEBrowser.encodeURI(...)` and forces a reload when only hash state changes.
- `runner-frame.handle(event)` accepts messages from its preview iframe and routes:
  - `actions` arrays into stream actions while editing.
  - `domevent` into IDE `browserevent`.
  - `location` into browser URL state.
  - `history` into `PAGE_HISTORY` plus local history state.
  - `pageload` into `PAGE_LOAD`.
  - `loader:busy`/`loader:done` into browser loading state.
- `player-frame` waits for `ide.container.player`, loads `/__sw__blank.html`, and renders replayed `BrowserPage` state into its iframe window.
- `SIWebContainer.init()` creates a separate bridge path for WebContainer:
  - boots WebContainer with `workdirName: "projects"`.
  - prefetches `/assets/webcontainer.RMFWBHQ3.mjs?file` and `/assets/tracker.4FYFXZYK.iife.js`.
  - mounts the fetched bootstrap text into `.bootstrap.mjs`.
  - spawns `node .bootstrap.mjs` with `OP.origin` and `OP_ORIGIN`.
  - installs the fetched tracker script with `webcontainer.setPreviewScript(...)`.
  - listens for WebContainer `port` and `server-ready` events.
  - calls `workspace.serverΞready(port, origin)` for normal ports.
  - creates a bridge iframe for reserved port `8123`.
  - accepts bridge `ArrayBuffer` messages, parses them through `OP.$parse(...)`, applies `OPDataUpdate` values as store patches, and otherwise forwards parsed OP packets through `OP.$handle(...)`.
  - sends queued outbound bridge messages after the iframe posts `"open"`.
  - packs non-`Uint8Array` bridge messages with `OP.$pack(...)`, copies them into a new `Uint8Array`, and sends them with `postMessage(..., "*")`.
- `OP.$pack(...)` is a thin wrapper around msgpack packing and `OP.$parse(...)` delegates to `OP.$unpack(...)`. `OPDataUpdate` is an `OPStruct`-style array with `value`, `id`, and `rev` accessors.

Medium confidence:

- There are two related but distinct runtime message paths: legacy service-worker/container requests for preview files and tracker injection, and WebContainer OP bridge messages for modern host/provider operations.
- The exact source files for `/__sw__.html`, `/__sw__blank.html`, and `/__sw__tracker.js` are not present as standalone local artifacts in this research bundle.

## Workspace Split And Snapshot Compatibility

High confidence:

- The main IDE shell is registered as `scrim-view` in `tmp/chunks/ide.36BDFLCO.js`; its class starts near character offset `2904227`.
- `scrim-view.setup()` always installs the legacy widget set (`IDEFS`, `IDEBrowser`, `IDEEditor`, `IDEAgent`, `IDESlides`, `IDEPointer`, and others).
- `SIWorkspace` is created only for non-legacy scrims: `this.scrim.legacyΦ || (this.workspace = SIWorkspace.new(), ...)`.
- For fresh non-legacy scrims, setup calls `workspace.resetWithSnapshot(Scrim.BaseSnapshot)`. If a `host` query parameter resolves to an OP object, Scrimba stores it as `scrim.remote_workspace`, switches the scrim to `kind: "playground"`, and saves shortly after.
- `scrim-view.toSnapshot(options)` is the compatibility boundary:
  - if `this.workspace` exists, it delegates to `this.workspace.toSnapshot(options)`.
  - otherwise it serializes legacy widgets into `{ seed, ref, spiv, widgets }`.
- `scrim-view.get_fs_snapshot()` is another compatibility boundary:
  - workspace scrims return `workspace.fs.get_snapshot()`.
  - legacy scrims return `{ content, path }` objects from `IDEFile` widgets.
- Legacy `SnapshotAction` (`SNAPSHOT`) deserializes widget snapshots in parent-before-child order and restores prior widget data on revert.
- Workspace `IDEOPSnapshotAction` (`OPSNAPSHOT`) and `IDEOPDeltaAction` (`OPDELTA`) apply OP-style diffs into `SIWorkspace`.
- `IDEOPSnapshotAction.commit()` creates `SIWorkspace.new()` if `this.wsp` does not exist yet, assigns `ide`, and commits the snapshot diff into the workspace.
- `SIWorkspace.resetWithSnapshot(snapshot)` cleans a cloned snapshot, diffs current `$plain` state against it, preserves the local workspace id, and applies the diff to `$plain`.
- `SIWorkspace.toSnapshot(options)` clones `$plain` with sanitization and passes it through `cleanSnapshot`.
- `SIWorkspace.cleanSnapshot(...)` strips volatile ids/revisions and, depending on options, prunes template-only state, unmounted entries, slides, agent/dom state, and assistant-panel state.
- `SIWorkspace` installs a `$plain.$changed` hook. Changes are added to `workspace.changes`; non-editing local changes set `has_local_changes`, file-buffer/name edits set `has_local_file_changes`, and file changes can force a scribble branch.
- `SIWorkspace.sync()` processes `workspace.changes` by syncing changed `SIObject`s to their host providers, computing `$diff($stream, $plain)`, pushing an initial `IDEOPSnapshotAction` when the branch has no actions, then pushing `IDEOPDeltaAction` for incremental diffs.
- `SIObject.syncΞtoΞhost()` compares a workspace object with its upstream/provider object, writes changed fields to the provider, stages the provider, and records the object in `workspace.pushables`.
- `SIObject.syncΞfromΞhost()` copies provider fields back into the workspace object.
- `SIFile` stores modern workspace file state with `body`, local `buffer`, optional `asset`, selection anchors, and language metadata.
- `SIDir.get_snapshot()` returns Scrimba exercise-checker style file snapshots: `{ content: file.buffer || file.body, path: file.path }`.
- `SIDir.toWCTree()` builds a WebContainer-compatible `{ directory: ... }` tree, while `SIFile.toWCTree()` returns `{ file: { contents } }`.
- Legacy `IDEFile` remains a widget/action target. It serializes local scroll/selection state, edits content through `LCEDIT`, removes itself through `FS_REMOVE`, and moves through `FS_MOVE`.
- Legacy `IDEDir.mkdir(...)`, `IDEDir.mk(...)`, and `IDEDir.mkfile(...)` create file-system entries as widgets through `ide.createWidget(...)`.

Medium confidence:

- `SIWorkspace` is the modern authoritative editable state for non-legacy scrims, while legacy widgets remain present for UI compatibility, routing, and older action streams.
- `OPSNAPSHOT`/`OPDELTA` represent whole-workspace and incremental workspace state, replacing many legacy per-widget file-system operations for new scrims.
- Runtime/container snapshots currently still have a legacy path through `scrim-view.toContainerSnapshot()`, which reads `IDEFile` widgets. Modern WebContainer state is likely mediated through `SIWorkspace` host/provider sync rather than this legacy helper.

## Workspace Host/Provider Sync

High confidence:

- `SIWorkspace.host` and `SIWorkspace.remote` resolve to `branch.scrim.remote_workspace || SWC.workspaceForScrim(scrim)`.
- `SWC` is a singleton `SIWebContainer` instance: `globalThis.SWC = SIWebContainer.new()`.
- `SIWebContainer.workspaceForScrim(scrim)` returns a `WCWorkspace` keyed as `"wcws0" + scrim.id` inside the WebContainer OP store.
- `Scrim.remote_workspace` is an OP reference to `HostWorkspace`; the new-scrim-from-folder path creates a `LocalWorkspace`, stores it on `remote_workspace`, and uses `Scrim.BaseSnapshot`.
- `SIWorkspace.ready` awaits `host.boot(workspace)`, marks the host state pushable, merges `$plain` into `LocalWorkspace` hosts, pushes workspace state to the host when not already pushing, then calls `hostΞready`.
- `SIWorkspace.pushΞtoΞhost` traverses `workspace.fs` and sends cloned file entries to `host.merge({ entries })` on first boot/push. Later pushes use host diff/save behavior.
- `HostWorkspace` is a base host model. Its `$send` throws unless implemented by a subclass, and its `$changed` throttles `save()`.
- `HostWorkspace.$changed(...)` creates a throttled function that calls inherited `save()` and runs it for change flags that include deserialized/plain state changes. It does not implement custom persistence itself.
- `LocalWorkspace` extends `HostWorkspace`. It sends through a `SILocalHost` socket (or Electron store when available), has a no-op client-side `boot`, and exposes `merge` as an RPC action.
- `WCWorkspace` extends `HostWorkspace`. It embeds a `HostFSRoot`, sends through `SWC.send(...)`, and exposes `boot`, `install`, `merge`, `webfetch`, and `serializeDir` as WebContainer/bridge-facing actions.
- `LocalWorkspace.merge` is an atomic RPC action with `callback=false`; its host-side merge implementation is not in this client class body.
- `WCWorkspace.webfetch`, `serializeDir`, `install`, and `merge` are RPC actions with `callback=false`; their concrete bridge/host implementations are not in this client class body.
- `WCWorkspace.boot` is a visible client action: it calls `SWC.boot(this, workspace)`, logs the host boot, marks the host as booted, and then runs `install(...)` once.
- `WCWorkspace.download_as_zip` is client-side helper logic: it awaits `serializeDir(path)`, imports JSZip through `ScrimArchiver.jszip`, builds a zip tree from the serialized directory, and triggers a browser download.
- `HostFSEntry` is the shared host file entry base; `HostFile` and `HostDir` persist to/read from a host filesystem.
- `HostDir.pullFromDisk(...)` crawls the host directory, creates `HostFile`/`HostDir` entries for disk nodes, skips `.DS_Store`, records inode data, and recurses.
- `HostDir.watch()` uses host `fs.watch(...)` and `onfsevent(...)` to mark removed nodes, create new host entries, or refresh changed file bodies.
- `HostFile.syncFromDisk(...)` reads files under 2 MB from disk and stores either text `body` or binary data depending on content.
- `HostFile.body_set`, `binary_set`, and `asset_set` write workspace/provider changes back to disk when the file has a path/inode.
- `HostFile.read` calls `read_rpc`, then copies returned `body` into `$cloud.body` and `$plain.body`.
- `OPObject.$save(...)` is the inherited save path for `HostWorkspace`: it stages unstaged roots, checks parent/virtual constraints, then delegates to `this.$$store.save(this, options, presaveResult)`.
- For the visible server-backed common store, `save(...)` computes an OP diff, optionally merges referenced unsaved objects/assets, wraps the diff in `OPStorePush.new({ diff })`, sends it, awaits the response, and applies returned per-id values or errors.
- For local/session stores, visible save logic writes sanitized root state into `localStorage`/`sessionStorage` and broadcasts a packed delta to other tabs.
- Therefore, after `HostWorkspace.$changed` fires, visible persistence is normal OP object/store diff persistence. The WebContainer bridge is used for `WCWorkspace` RPC actions, not for the inherited `HostWorkspace.save()` path in the inspected code.
- `SIWebContainer.init()` boots the WebContainer with `workdirName: "projects"`, mounts `.bootstrap.mjs`, spawns `node .bootstrap.mjs`, installs the preview tracker script, and creates a bridge iframe for OP-packed messages.
- `SIWebContainer.spawn(...)` sets `PATH`, `WEBCONTAINER=true`, and `cwd=this.host.ns` before calling WebContainer `spawn`.
- `SIRunner.run` waits for `workspace.ready`, saves all workspace files, optionally runs an init command once, then starts the configured run command through `SWC.spawn(...)`.
- `SIRunner.fileΞsaved(...)` reruns or runs the runner when `run_on_save` is enabled.
- `SITerminal.start` waits for `workspace.ready` and connects the remote host terminal; `SIWebContainer.newterm(...)` creates `/bin/jsh --osc` terminals.

Medium confidence:

- For modern scrims, the authoritative runtime file tree is the host/provider graph reached from `SIWorkspace.host`, not the legacy `scrim-view.toContainerSnapshot()` helper.
- `LocalWorkspace.merge`, `WCWorkspace.merge`, `WCWorkspace.install`, `WCWorkspace.webfetch`, and `WCWorkspace.serializeDir` are RPC/bridge actions; their actual host-side implementations are not visible in the client bundle.

## Workspace And Default State

High confidence:

`tmp/scrim.blank.json.5TFCQ3DL.js` defines a blank workspace with:

- `layout`: horizontal root layout.
- `main`: vertical split.
- `drawer`: contains runner/console/terminal.
- `runner`: disabled by default.
- `sidebar`: hidden/collapsed by position.
- `browser`: visible/floating with absolute geometry.
- `fs`: excludes `node_modules`, `.DS_Store`, `package-lock.json`, hidden directories; groups config files.
- `entries`: includes one main view, one browser view, and one terminal/console entry.

## Comparison With This Repo

High confidence from `docs/core.md`, `docs/data-flow.md`, `docs/state-machines.md`, and `src/`:

- Next Editor currently records as structured `Recording` artifacts, not as Scrimba-compatible append-only action streams.
- The local recording format is versioned (`2 | 3`) and stores `frames`, `keyframeInterval`, optional slide/preview/workspace/runtime/cursor event arrays, optional audio, and optional workspace/runtime snapshots.
- Frame compression is array-based:
  - first frame is always a keyframe.
  - every configured keyframe interval can store a keyframe when content changed.
  - intermediate frames store `FrameDelta` objects only when something changed.
- Text deltas use `{ prefixLen, suffixLen, insert }`, backed by WASM common-affix helpers when available.
- Position and selection deltas are numeric line/column deltas.
- Optional frame fields include Monaco `viewState`, mouse cursor, slide state, current slide index, and preview state.
- Playback reconstructs a frame by finding the nearest prior keyframe and applying deltas forward.
- Timeline lookup uses a linear scan from the previous index with binary-search fallback, similar in spirit to Scrimba's seek optimization but over immutable frame arrays rather than reversible action objects.
- Workspace recording in this repo stores full `WorkspaceRecordingSnapshot` objects in `workspaceEvents`, deduped by equality checks.
- Runtime recording similarly stores full `RuntimeRecordingSnapshot` objects in `runtimeEvents`, also deduped by equality checks.
- Repo storage uses `src/storage/recordingCodec.ts`: magic `"SCRM"`, binary format version `2`, compressed SuperJSON via `pako`, and concatenated audio data referenced by placeholders.
- Repo WebContainer sync is React/provider driven:
  - `useWebContainerWorkspaceSync` mounts a generated WebContainer tree from `WorkspaceProject`.
  - subsequent project changes are queued through `syncWorkspaceProject(...)`.
  - `WebContainerRuntimeProvider` can reverse-sync filesystem changes after terminal output or terminal input by reading the WebContainer project back into workspace state.
- Repo runtime state is modeled as snapshots with status, preview port/url, terminal sessions, command state, console lines, and panel UI state.

Implementation gap versus Scrimba:

- Scrimba's core timeline is an append-only, msgpack-backed, reversible action stream with per-domain actions (`LC*`, DOM/page actions, pointer actions, workspace OP diffs, branch markers).
- Next Editor's core timeline is a compressed sequence of full editor frames and timestamped snapshot/event arrays.
- Scrimba has branch-aware stream cursors with apply/revert traversal across parent/child scrim branches; this repo has playback state machines but no equivalent branch lineage model.
- Scrimba's modern workspace path records OP-style workspace snapshots/diffs (`OPSNAPSHOT`/`OPDELTA`) and syncs a host/provider graph; this repo records full workspace snapshots/events and syncs WebContainer from `WorkspaceProject`.
- Scrimba stores streams as server-backed byte streams with `OPBinaryChunk`/`OPByteStream`; this repo stores/export recordings as complete binary artifacts with compressed JSON and concatenated audio.
- Scrimba captures browser replay as deterministic DOM/page actions from tracker infrastructure; this repo has preview state/events and iframe interaction capture utilities, but not the same DOM mutation action protocol.

## Export/Download

High confidence:

`ScrimArchiver` and subclasses generate runnable project exports. Evidence:

- Uses JSZip via `https://esm.sh/jszip`.
- Adds README, package.json, config files.
- Detects React, Vue, Svelte, Imba, JS, TS, HTML, Babel, old React.
- `ViteScrimArchiver` writes `vite.config.js` and uses commands like `vite build` and `vite preview`.
- `WebpackScrimArchiver` writes `webpack.config.js` and supports Babel, Svelte, TypeScript, and webpack watch.

Medium confidence:

- The export path exists partly to let users run embedded lessons locally when editing is not supported inside an embed.

## UI Composition

High confidence:

The main player element `scrim-view` composes:

- header: `ide-header`
- browser: `browser-widget`
- slides: `slides-widget`
- sidebar: `sidebar-widget`
- center/editor: `editor-widget`, `ide-editor-tab`
- console panel: `ide-console-panel`
- pointer: `ide-pointer-widget`, `pointer-tracker`
- controls: `scrim-play-controls`
- clip editor/studio: `ide-clip-editor`
- transcript: `ide-transcript-modal`, `ide-transcript-editor`, `ide-transcript-segment`

The UI state toggles flags for studio, recording, live, editing, gated, workspace, drafting, solution, mode, focus, browser focus, slides focus, and collapsed sidebar.

## AI Workspace Features

High confidence:

The bundle includes AI action models in both app and IDE layers:

- App layer: `AIModel`, `AIService`, `OpenAIService`, `AnthropicService`, `OPAI*` provider/model/request/response classes.
- IDE layer: `AIAction`, `AIThread`, `AIRunCommandAction`, `AIReadFileAction`, `AIWriteFileAction`, `AIReplaceInFileAction`, `AIWebSearchAction`, `AIRequestPlanApprovalAction`, and UI components such as `panel-assistant-view`.
- `AIRunCommandAction` has approval states and can run commands through the WebContainer if allowed.

Medium confidence:

- Modern Scrimba workspace exercises can include AI-assistant access gates and credit/spend tracking on `Scrim`.

## Known Unknowns

- Exact server-side storage implementation for `OPBinaryChunk` persistence is not visible in the local bundle.
- Exact `load_from_prod` RPC behavior and production backfill endpoint are not visible in the local bundle.
- Exact external browser tracker implementation is not visible because `/assets/tracker.4FYFXZYK.iife.js` is referenced but not present as a standalone artifact file under `tmp/` or elsewhere in this repo.
- Exact WebContainer bootstrap implementation is not visible because `/assets/webcontainer.RMFWBHQ3.mjs?file` is referenced but not present as a standalone artifact file under `tmp/` or elsewhere in this repo.
- `LCSCROLL` has no producer in the local artifacts outside the enum/action-class references; determining whether it is legacy-only needs another bundle/source artifact.
- `MSR_CHUNK` has no local producer; modern media bytes are stored through `MediaStreamRecording.webm`/`OPByteStream`.
- Server-side commit persistence semantics around `COMMIT=220` are not visible; client-side `ScrimCommit` model/UI semantics have been traced.
- Host-side implementations of `LocalWorkspace.merge`, `WCWorkspace.merge`, `WCWorkspace.install`, `WCWorkspace.webfetch`, and `WCWorkspace.serializeDir` are not visible in the client class bodies or available local bootstrap artifacts.
