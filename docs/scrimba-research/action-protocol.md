# Scrimba Action Protocol Notes

Last updated: 2026-06-15

Source: `tmp/chunks/ide.36BDFLCO.js`

## Confirmed Protocol Shape

Each stream action is represented by an array. The first array element is a numeric action code. `IDEStreamAction.deserialize(e,t)` dispatches using an opcode map (`hd[e[0]]`). The decorator/helper `Ve(...)` assigns:

- `type` on the action constructor and prototype.
- `strategy` and `diff` options.
- optional `schema` accessors.
- the constructor into the opcode map.

Evidence anchors:

- Opcode map starts near character offset `566697`.
- `Ve(...)` helper starts near character offset `569461`.
- `IDEStreamAction.deserialize` starts near character offset `2293694`.
- `IDEStream.parsedValue`, `syncBuffer`, and `write` are in the `IDEStream` class, bundle segment offset around `2402588-2404862`.
- `IDEStream.load` starts near character offset `2412495`.
- `ScrimStream` starts near character offset `2872606` in `tmp/app.UK3DL7B2.js`.
- `OPBufferChunks`, `OPByteStream`, and `OPDataStream` start near character offsets `880969`, `888236`, and `894263` in `tmp/app.UK3DL7B2.js`.
- `OPDataUpdate` and OP struct/msgpack helpers are in `tmp/app.UK3DL7B2.js`, character offsets `452600-454620`.
- `OP.$pack`, `OP.$unpack`, and `OP.$parse` are in `tmp/app.UK3DL7B2.js`, character offsets `674500-676000`.
- OP object save/diff persistence is in `tmp/app.UK3DL7B2.js`, character offsets `616969-620198` and `1165200-1175200`.
- `SIWorkspace` starts near character offset `1122747` in `tmp/chunks/ide.36BDFLCO.js`; its registration is near `1143423`.
- `scrim-view` starts near character offset `2904227` in `tmp/chunks/ide.36BDFLCO.js`.
- `SIWebContainer` bootstrap/bridge details are in `tmp/chunks/ide.36BDFLCO.js`, character offsets `1159200-1165200`.
- `IDEFile`, `IDEDir`, and `IDEFS` register near character offsets `2479110`, `2486012`, and `2487898`.

## Stream Framing Found So Far

High confidence from `IDEStream`:

- The stream is unpacked with `OP.msgpack.createUnpacker()`.
- `syncBuffer` reads new bytes from `this.stream.chunked.slice(previousReadableOffset, readableSize)` and calls `unpacker.unpackMultiple`.
- Decoded values are handled by `parsedValue(value, byteOffset, localFlag, previousValue)`.
- Numeric decoded values are control/timing markers:
  - positive large values above `16e11` are treated as absolute timestamps.
  - positive smaller values are treated as time deltas and increase the current timestamp/offset.
  - negative values set `lastType` to the next action type (`lastType = -value`).
- Non-numeric decoded values are interpreted as payloads for the current `lastType`.
- `write(action, options)` emits:
  - an absolute timestamp for the first write, or a compact time delta for later writes.
  - a negative action type marker when the action type changes.
  - the action's encoded payload.
- `parsedValue` decodes the payload through the registered action class, attaches byte offset/raw value, adds it to branch arrays, updates text-edit/significant-action indexes, and calls `commitToStream`.

Medium confidence:

- Persisted stream bytes are msgpack-framed sequences containing timing markers, type markers, and compact payload arrays.
- Action offsets represent elapsed timeline time, while byte offsets represent stream byte positions used for trimming/rollback.

## Backing Byte Stream

High confidence from `tmp/app.UK3DL7B2.js`:

- `ScrimStream` is the `Scrim.stream` embedded model and extends `OPDataStream`.
- `ScrimStream.httpUrl` resolves to `${location.origin}/legacy/files/${this.id}`.
- Generic `OPByteStream.httpUrl` resolves to `/op/stream/${this.id}`; Scrim streams override it.
- `OPDataStream.push(...values)` calls `OP.msgpack.packMultiple(...values)` and appends the packed bytes.
- `OPByteStream.append(bytes)` wraps appended bytes in `OPBinaryChunk` with an offset equal to the current known tail/disk size.
- `OPBinaryChunk.$handle()` loads bytes into the target stream's `OPBufferChunks`, flushes authored chunks through `OP.$send`, and reconciles the root object.
- `OPByteStream` fetches stream bytes with `window.fetch(this.httpUrl, { method: "GET" })`; each response-body chunk becomes an `OPBinaryChunk` loaded into the stream.
- `OPBufferChunks.readableSize` is the contiguous prefix ending at `head.tail.end`; if the first loaded fragment does not start at zero, readable size is zero.
- `OPBufferChunks.holes` creates `OPMissingBinaryChunk` records for missing ranges between loaded fragments.
- `OPBinaryChunkRequest.$handle()` serves a requested range by slicing the target stream and sending an `OPBinaryChunk` back to the requester.

High confidence from `IDEStream.load`:

- Loading a trunk branch awaits `scrim.stream` and can call `stream.load_from_prod()` when the local stream verifies as zero bytes.
- Loading a child branch resolves a parent branch and seed action from `origin_index`, `origin_offset`, `ScrimActionRef`, or `seed`.
- If a child branch's stream is empty, Scrimba can seek the parent cursor to the seed action and write a `SNAPSHOT`/`OPSNAPSHOT` into the child stream.
- Branch loading ends by calling `syncBuffer()`, so byte loading and action decoding are separate phases.

## Opcode Map

Extracted from the bundle:

| Code | Name                 |
| ---: | -------------------- |
|    1 | `SET`                |
|    2 | `PATCH`              |
|    3 | `WIDGET_CREATE`      |
|    4 | `LCINSERT`           |
|    5 | `LCDELETE`           |
|    6 | `LCEDIT`             |
|    7 | `LCSELECTION`        |
|    8 | `LAYOUT`             |
|    9 | `BROWSER_LAYOUT`     |
|   10 | `NODE_LAYOUT`        |
|   12 | `POINTER_UPDATE`     |
|   13 | `SYNC`               |
|   16 | `CONSOLE_LOG`        |
|   17 | `CONSOLE_CLEAR`      |
|   18 | `CONSOLE_VAL_EXPAND` |
|   21 | `DOM_MUTATE`         |
|   22 | `DOM_EVENT`          |
|   23 | `DOM_SCROLL`         |
|   24 | `DOM_SELECTION`      |
|   25 | `DOM_FOCUSIN`        |
|   26 | `DOM_HOVERIN`        |
|   27 | `DOM_ACTIVEIN`       |
|   28 | `PAGE_LOAD`          |
|   29 | `PAGE_LOADED`        |
|   30 | `PAGE_LOG`           |
|   31 | `PAGE_REQUEST`       |
|   32 | `PAGE_HISTORY`       |
|   33 | `RECSTART_OLD`       |
|   34 | `RECSTOP_OLD`        |
|   35 | `PING`               |
|   36 | `SNAPSHOT`           |
|   37 | `FORK`               |
|   38 | `BRANCH`             |
|   39 | `TRIM`               |
|   40 | `KEYFRAME`           |
|   42 | `OPSNAPSHOT`         |
|   43 | `OPDELTA`            |
|   44 | `OPROLLBACK`         |
|   50 | `PAGE_UNLOAD`        |
|   61 | `PROCESS_LOG`        |
|  100 | `LOCK`               |
|  101 | `UNLOCK`             |
|  110 | `FS_RENAME`          |
|  111 | `FS_REMOVE`          |
|  112 | `FS_MOVE`            |
|  126 | `WIDGET_FLAG`        |
|  127 | `WIDGET_UNFLAG`      |
|  128 | `WIDGET_APPEND`      |
|  129 | `WIDGET_REMOVE`      |
|  200 | `SIM_BUILD`          |
|  201 | `SIM_RESULT`         |
|  202 | `DOM_FOCUSOUT`       |
|  203 | `DOM_HOVEROUT`       |
|  204 | `DOM_ACTIVEOUT`      |
|  206 | `DOM_INSERT`         |
|  207 | `DOM_RESET`          |
|  210 | `LCSCROLL`           |
|  220 | `COMMIT`             |
|  221 | `SAVE`               |
|  222 | `SEED`               |
|  223 | `EVALUATE`           |
|  224 | `CALL`               |
|  241 | `MSR_START`          |
|  242 | `MSR_CHUNK`          |
|  243 | `MSR_END`            |
|  250 | `VIEW_OPEN`          |
|  251 | `VIEW_CLOSE`         |
|  252 | `VIEW_MOVE`          |
|  253 | `VIEW_PIN`           |

## Target IDs

The same opcode section defines negative target IDs:

|  ID | Target           |
| --: | ---------------- |
|  -1 | `WORKSPACE`      |
|  -2 | `CONSOLE`        |
|  -3 | `SIMULATOR`      |
|  -4 | `INSPECTOR`      |
|  -5 | `AGENT`          |
|  -6 | `STREAM`         |
|  -7 | `BROWSER`        |
|  -8 | `FS`             |
|  -9 | `PRIMARY_EDITOR` |
| -10 | `EXPLORER`       |
| -11 | `DEPENDENCIES`   |
| -12 | `SLIDES`         |
| -13 | `SIDEBAR`        |
| -14 | `POINTER`        |
| -15 | `SCM`            |

The list continues after the extracted snippet and should be extended in a later pass.

## DOM Mutation Subprotocol

`BrowserPage.applyMutations` uses a separate DOM mutation enum (`ro.MUTS`):

| Code | Mutation          |
| ---: | ----------------- |
|    1 | `RESET`           |
|    2 | `INSERT`          |
|    3 | `REMOVE`          |
|    4 | `INIT`            |
|    5 | `INSERT_AFTER`    |
|    6 | `INSERT_ADJACENT` |
|   10 | `SETATTR`         |
|   11 | `SETPROP`         |
|   12 | `SETTEXT`         |
|   13 | `REFLOW`          |

Known attribute/property name aliases:

| Code | Name      |
| ---: | --------- |
|    1 | `class`   |
|    2 | `value`   |
|    3 | `checked` |
|    4 | `style`   |

Known insert-adjacent positions:

- `beforebegin`
- `afterbegin`
- `beforeend`
- `afterend`

## Action Semantics Found So Far

### Text Actions

`TextEditAction` (`LCEDIT=6`) applies text model edits and restores previous selection on revert.

`TextInsertAction` (`LCINSERT=4`) is significant and stores:

- target id in `params[0]`
- start line/column or range data in `params[1]`/`params[2]`
- inserted string in `params[3]`
- optional `selAfter` in `params[4]`

It can compact adjacent inserts by encoding only the inserted string when the previous insert's post-selection equals the next insert start.

`TextDeleteAction` (`LCDELETE=5`) is significant and stores a deletion range in `params[1..4]`, with optional `selAfter` in `params[5]`.

`TextSelectionAction` (`LCSELECTION=7`) can compact repeated selections by storing only the changed suffix.

Producer notes:

- Scrimba's `TextModel.setupMonaco()` overrides Monaco `model.applyEdits`.
- Single simple insertions become `LCINSERT`.
- Single deletions become `LCDELETE`.
- Multi-edit or complex edit arrays become `LCEDIT`.
- Selection changes are either attached to the preceding text action or emitted as `LCSELECTION`.
- `editor-widget` captures Monaco scroll changes, but the current producer found in this pass writes `scrollTop`/`scrollLeft` attributes rather than emitting `LCSCROLL`.
- A repo-wide string/offset scan found only three local `LCSCROLL` occurrences: opcode enum, `TextScrollAction`, and documentation. This supports "no local producer" at high confidence; legacy/other-bundle use remains unknown.

### Snapshot And Keyframe

`SnapshotAction` (`SNAPSHOT=36`) loads legacy widget serialized state. It:

- assigns widget state into branch read state during stream commit.
- deserializes widgets in parent-before-child order.
- skips widgets of type `audio` during widget deserialization.
- restores prior widget data on revert.

`KeyframeAction` (`KEYFRAME=40`) subclasses `SnapshotAction`.

### Workspace OP Actions

`IDEOPSnapshotAction` (`OPSNAPSHOT=42`) applies a whole `SIWorkspace` snapshot. It:

- treats its first parameter as the snapshot.
- creates `SIWorkspace.new()` and assigns `ide` if no workspace exists yet.
- calls `workspace.commitΞdiffΞfromΞstream(snapshot, action)` to apply the stream snapshot.
- stores the previous workspace `$plain` state for revert bookkeeping.
- reverts through `workspace.revertΞdiffΞfromΞstream(...)` when the snapshot contains a stored reverse diff.

`IDEOPDeltaAction` (`OPDELTA=43`) applies an incremental workspace diff by calling `workspace.commitΞdiffΞfromΞstream(params, action)` and reverts through `workspace.revertΞdiffΞfromΞstream(params, action)`.

`SIRollbackAction` (`OPROLLBACK=44`) computes a diff from `workspace.$stream` to a target snapshot and applies/reverts that diff.

Producer notes:

- `scrim-view.toSnapshot(...)` delegates to `workspace.toSnapshot(...)` when `SIWorkspace` exists; legacy scrims instead serialize widgets into `{ seed, ref, spiv, widgets }`.
- `SIWorkspace.sync()` turns changed workspace objects into stream actions. If the branch has no actions, it first pushes `IDEOPSnapshotAction` with a sanitized clone of `$stream`.
- The same sync pass computes `$diff($stream, $plain)` and pushes `IDEOPDeltaAction` when there is an incremental diff.
- `SIWorkspace.resetWithSnapshot(...)` and `cleanSnapshot(...)` are the snapshot import/cleanup path for templates, fresh scrims, and reset-to-stream behavior.
- Legacy `SNAPSHOT`/`KEYFRAME` actions hydrate widget state; workspace `OPSNAPSHOT`/`OPDELTA` hydrate `SIWorkspace` state.
- `SIWorkspace.host` resolves to `scrim.remote_workspace` when present, otherwise a per-scrim `WCWorkspace` from the global `SWC` singleton.
- `SIWorkspace.ready` boots the host/provider, merges local state for `LocalWorkspace`, pushes workspace file entries to the host, and emits `hostΞready`.
- `SIWorkspace.pushΞtoΞhost` traverses `workspace.fs`, clones entries into a host `entries` payload, and calls `host.merge(...)` on first push.
- Changed `SIObject`s sync to their upstream/provider objects through `syncΞtoΞhost`; provider changes can be staged and later pushed to the host.
- `WCWorkspace.merge`, `install`, `webfetch`, and `serializeDir` are bridge/RPC-facing actions, so their concrete host-side effects are outside the visible client class bodies.
- `HostWorkspace.$changed(...)` throttles inherited `save()`. The inherited OP object save path stages roots and delegates to the object's store; the visible server-backed common store saves by computing an OP diff, sending `OPStorePush.new({ diff })`, awaiting a response, and applying returned values/errors.
- Local/session store save paths write sanitized root state to browser storage and broadcast packed deltas to other tabs.

### Browser/Page Actions

`PageLoadAction` (`PAGE_LOAD=28`) creates or selects a `BrowserPage`, assigns HTTP status and URL, updates `IDEBrowser.page`, and clears the console.

`PageRequestAction` (`PAGE_REQUEST=31`) creates/selects a `BrowserPage` for the requested URL and points the browser at it.

`PageLoadedAction` (`PAGE_LOADED=29`) uses `dedupe` strategy and sets the page initial state when first applied.

`PageHistoryAction` (`PAGE_HISTORY=32`) updates browser URL from history payload data.

`PageLogAction` (`PAGE_LOG=30`) also uses `dedupe`. It pushes/pops console log entries and suppresses the in-browser Babel transformer warning.

`DOMResetAction` (`DOM_RESET=207`) clears the replay document root, focus/active/hover/selection state, and node index, while retaining the prior root children for revert.

`DOMMutateAction` (`DOM_MUTATE=21`) calls `BrowserPage.applyMutations` and records errors on the target page.

`DOMSelectionAction`, `DOMScrollAction`, `DOMFocusInAction`, `DOMHoverInAction`, and `DOMActiveInAction` update page selection/scroll/focus/hover/active state and revert to prior state.

Producer notes:

- `runner-frame.handle(...)` receives tracker messages from the preview iframe.
- Tracker messages of type `actions` contain action pairs shaped like `[opcode, params]`; each pair is passed to `browser-widget.push_(opcode, params)` when the IDE is editing.
- Focus/hover/active DOM actions are ignored unless pointer tracking is enabled.
- `DOM_MUTATE` actions are skipped for local browser pages.
- `PAGE_LOG` values are optionally redacted before being pushed.
- `ide-sw-container` forwards service-worker/container messages into `scrim-view.oncontainermessage(...)`.
- `scrim-view.oncontainermessage(...)` serves `getState`, preview `request`, `resolveImportMap`, and `resolveFile` messages for the runner/player infrastructure.
- Preview `request` responses include the browser history state and tracker URL `${origin}/__sw__tracker.js`.
- The service-worker/container request handler exposes a tracker script URL at `/__sw__tracker.js`.
- WebContainer preview mode installs `/assets/tracker.4FYFXZYK.iife.js` through `setPreviewScript(...)`.
- WebContainer bridge messages are a separate OP-packed path handled by `SIWebContainer` through a bridge iframe and `OP.$parse(...)`.

### WebContainer OP Bridge

High confidence:

- `SIWebContainer.init()` prefetches `/assets/webcontainer.RMFWBHQ3.mjs?file` and `/assets/tracker.4FYFXZYK.iife.js`.
- It boots WebContainer with `workdirName: "projects"`, mounts fetched bootstrap text as `.bootstrap.mjs`, spawns `node .bootstrap.mjs` with `OP.origin`, and sets `OP_ORIGIN` in the spawned process environment.
- It installs the fetched tracker script with `webcontainer.setPreviewScript(...)`.
- WebContainer `server-ready` for reserved port `8123` creates a hidden iframe bridge pointed at that port's URL.
- When the bridge iframe posts `"open"`, `SIWebContainer` sets `readyState = 1` and flushes queued outbound messages.
- Bridge `ArrayBuffer` messages are copied into `Uint8Array`, parsed through `OP.$parse(...)`, and handled as follows:
  - parsed array payloads use their second element;
  - `OPDataUpdate` values patch `SIWebContainer.store`;
  - other parsed OP messages go through `OP.$handle(message, SIWebContainer)`.
- `SIWebContainer.send(...)` packs non-`Uint8Array` messages with `OP.$pack(...)`, copies the bytes into a new `Uint8Array`, and sends the bytes to the bridge iframe with `postMessage(..., "*")`; messages queue until the iframe is open.
- `OPDataUpdate` is an `OPStruct`-style array with `value`, `id`, and `rev` accessors.

Blocked locally:

- The bootstrap file itself is not present as a standalone local artifact, so the bridge-side implementations of `WCWorkspace.merge`, `install`, `webfetch`, and `serializeDir` are not visible.

### Pointer Actions

`IDEPointerUpdateAction` (`POINTER_UPDATE=12`) stores pointer coordinates, button/key flags, hover target, and optional angle/pressure data.

Producer notes:

- `pointer-tracker` listens for pointer events, keyboard events, and browser preview `browserevent` messages.
- `pointer-tracker.stamp(...)` captures `x`, `y`, `flags`, `hover`, `time`, `targetLayout`, and a link to the previous pointer sample.
- Pointer actions are pushed while recording or debugging outside workspace mode.
- `IDEPointerUpdateAction` delta-encodes `x` and `y` against the previous pointer update and can group samples into `PointerUpdateGroup` segments.

### Media Capture

The protocol defines `MSR_START=241`, `MSR_CHUNK=242`, and `MSR_END=243`.

Current client evidence:

- `MediaStreamStartAction` and `MediaStreamEndAction` exist, but are minimal.
- `MSR_CHUNK` appears only in the opcode enum in this inspected bundle; no class registration or active producer was found.
- Modern microphone capture uses `AudioRecording` plus browser `MediaRecorder`; chunks are assembled into WebM and appended to `MediaStreamRecording.webm`, an embedded `OPByteStream`.
- `MediaStreamRecording.url` resolves non-legacy recordings to `/legacy/files/${this.id}.webm`.
- `ScrimRec.byte_offset` exists as model metadata but was not assigned by visible client code in this pass.
- A repo-wide string/offset scan found no local `MSR_CHUNK` occurrence outside the opcode enum and documentation.

### File/View Actions

`CreateWidgetAction` (`WIDGET_CREATE=3`) creates a legacy widget from serialized config, commits/reverts add state, and marks the target for refresh.

`RemoveWidgetAction` (`WIDGET_REMOVE=129`) commits/reverts legacy widget deletion.

`ConfigSetAction` (`SET=1`) updates widget data or modern `SIObject` state, records the prior value, and updates stream read state during parsing.

`PatchAction` (`PATCH=2`) merges patch data into widget data and stores previous state for revert.

`SyncAction` (`SYNC=13`) is a no-op synchronization boundary.

`LayoutAction` (`LAYOUT=8`), `BrowserLayoutAction` (`BROWSER_LAYOUT=9`), and `NodeLayoutAction` (`NODE_LAYOUT=10`) update layout state and restore prior layout values on revert.

`FSRenameAction` (`FS_RENAME=110`) renames a legacy filesystem entry, and can call the target remote rename path for local trunk changes.

`FSMoveAction` (`FS_MOVE=112`) moves an entry between parent directories and reverts by restoring the previous parent.

`FSRemoveAction` (`FS_REMOVE=111`) removes a target entry.

`ViewOpenAction` (`VIEW_OPEN=250`) pushes a widget/file into an editor group, marks it opened, and closes the oldest unpinned view when needed.

`ViewCloseAction` (`VIEW_CLOSE=251`) removes a widget/file from the group and reopens the previous active view when appropriate.

`ViewMoveAction` (`VIEW_MOVE=252`) and `ViewPinAction` (`VIEW_PIN=253`) are registered but minimal in the inspected bundle.

`SaveAction` (`SAVE=221`) records the target's `lastSave`, stores current contents into the target body, and has a `scrim-save-marker`.

`ConsoleClearAction`, `ConsoleLogAction`, and `ConsoleValExpandAction` delegate commit/revert to `IDEConsole.apply(...)` and `IDEConsole.revert(...)`.

### Commit/Marker Actions

`COMMIT=220` is assigned in the opcode enum.

Current client evidence:

- No registered `CommitAction` class or active `COMMIT=220` producer was found in `tmp/chunks/ide.36BDFLCO.js`.
- Commit markers visible in the player/editor are `ScrimCommit` content records, not decoded stream actions in the inspected client path.
- `ScrimCommit` stores `offset`, `summary`, `desc`, `squashed`, `template`, and `snapshot`.
- `ScrimCommit.marker_offset` returns the commit offset.
- `ScrimCommit.opΞownΞdialog()` and `IDEStream.opΞcommitΞdialog()` both render `ide-commit-dialog`.
- `ide-commit-dialog` mutates/validates a commit-like `value`, emits `resolve`, and exposes toggles for template updates and squashed commits; it does not itself write a `COMMIT=220` stream action in the visible client code.
- `scrim-commit-marker` and the `ScrimCommit` marker adapter render commit markers in timeline UI.
- `IDEStream.segments` uses squashed first commit markers as segment bases and filters later markers by `marker_offset`.
- `IDEStream.trimToAction(...)` deletes commits whose offsets are at or after the trim target.

### Cursor/Playback

`IDEStreamCursor` maintains:

- current branch
- current action
- current target
- stack of currently applying/reverting actions
- branch path for cross-branch routing

To seek, it compares the current action and target action, reverts to the nearest shared point, then applies actions forward. If a route crosses branches, it follows branch-specific first/next action links. After sync, marked targets receive `synced_` callbacks if present.

Additional local evidence:

- If the cursor has not applied the trunk seed yet, sync applies trunk action zero first.
- If the target action is the direct next action, sync commits it without a full compare route.
- `compare(...)` returns `{ revertTo }`, `{ stepTo }`, or `{ revertTo, route }` depending on same-branch ordering or shared branch ancestry.
- `apply(action, previous)` reverts back to the expected previous action if the requested action is not adjacent, pushes the action onto the stack, commits it, and sets the branch `currentAction`.
- `revert(action)` pushes the action onto the stack, runs `revertWithCursor`, clears reverting state, and returns `action.prev`.
- If replay leaves an editing branch with later actions available, the cursor calls `currentBranch.stopEditing()`.

### Timeline Playback

High confidence:

- `BaseTimeline` provides time/offset conversion, clamping, duration/progress, current offset/time, and schedule/unschedule audio hooks.
- `ClipTimeline` preloads audio, sets audio playback rate from `ide.pbr`, plays/pauses the audio element, responds to seeking/seeked/pause events, and unschedules audio when leaving playback.
- `IDEBranchTimeline.seekToOffset(offset, ...)` maps the stream offset to timeline time, calls `seekTo(time, ...)`, and unschedules current playback.
- `IDEBranchTimeline.seekTo(time, ...)` clamps time to timeline duration, anchors the timeline clock, and updates the underlying animation current time.
- `IDEBranchTimeline.skipΞforward/backward` jumps by 10 seconds or to nearby keyframes/clip boundaries.
- `IDEBranchTimeline.playbackRate` updates the underlying animation or simple clip audio playback rate, pausing/resuming as needed.
- `scrim-play-controls` maps play button and spacebar to timeline toggle, left/right to skip backward/forward, and shift+comma / shift+period to playback speed changes.
- `ide-scrim-control` is a separate clip-editor playback path that schedules audio slices and selection ranges; it is not the normal lesson/player replay path.

Branch details:

- `IDEStream.newFork(...)` creates a new `Scrim` with `origin`, `origin_index`, `origin_offset`, and `origin_snapshot` fields, then seeds its stream with a snapshot.
- `IDEStream.load()` resolves branch parents from `origin_index`, `origin_offset`, `ScrimActionRef`, or `seed`.
- A child branch's first action is linked to the parent seed action through `first.prev`.
- `IDEStreamCursor.lineage(...)` walks seed links upward; `compare(...)` finds the shared branch ancestor.
- `sync(...)` can revert on the current branch, apply forward on the same branch, and then cross into child branch action lists via the computed route.
- Exercise solutions are normal branches with `kind: "solution"` and an `exercise` reference.
- `ForkAction`, `BranchAction`, `SeedAction`, and `TrimActionAction` are present but minimal in the inspected client bundle; the durable branch relationship is mainly model metadata plus snapshot seeding.

## Implementation Implications

For a Scrimba-like system, the core engine needs:

1. A compact typed action protocol.
2. A reversible application model for each target domain.
3. Periodic snapshots/keyframes for fast recovery and bounded seek cost.
4. A cursor capable of branch-aware apply/revert traversal.
5. Deterministic preview capture/replay, including DOM mutations and console logs.
6. A workspace-state diff protocol for modern scrims, separate from legacy widget snapshots.
7. Separate media/caption timeline synchronization.

## Open Protocol Questions

- What exact server-side store receives `OPBinaryChunk` packets?
- What exactly does the `ScrimStream.load_from_prod` RPC do?
- Are `/legacy/files/<id>` responses always raw msgpack stream bytes, or can they be transformed by the backend?
- Is `MSR_CHUNK` legacy/reserved, or is it produced only by a missing tracker/bundle artifact? The local artifacts contain no producer.
- Is `ScrimRec.byte_offset` populated server-side, by legacy clients, or by another bundle not present under `tmp/`?
- How exactly are commit records persisted server-side, and is `COMMIT=220` still used outside this bundle?
- How are branch marker offsets encoded in persisted `Scrim` records beyond the client-side `marker_offset` model API?
- What are the host-side implementations of `LocalWorkspace.merge`, `WCWorkspace.merge`, `WCWorkspace.install`, `WCWorkspace.webfetch`, and `WCWorkspace.serializeDir`? The visible client bridge is traced, but the bootstrap/host implementation artifact is missing locally.
