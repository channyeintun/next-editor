# Scrimba Record And Replay Research

Last updated: 2026-06-15

## Scope

This is the focused record/replay summary from the local bundle artifacts under `tmp/`. It intentionally ignores analytics, monitoring, growth/product UI, billing, and unrelated platform features.

Confidence labels:

- High: directly supported by local bundle class names, method names, opcodes, literals, or exact source spans.
- Medium: inferred from adjacent code paths in the same local bundle.
- Blocked locally: required artifact or backend implementation is referenced but absent from this repo.

## Executive Summary

High confidence:

Scrimba records an interactive IDE state machine, not a screen video. A scrim stream is a msgpack-backed byte stream of timed, typed action payloads. Playback reconstructs IDE state by applying and reverting actions, so seeking is state-machine traversal rather than video seeking.

The record/replay stack has five main layers:

1. `Scrim` content records and `ScrimStream` byte storage.
2. `IDEStream` action loading, writing, parsing, branching, trimming, and recording lifecycle.
3. Reversible `IDEStreamAction` subclasses for editor text, legacy widgets, file/view state, browser DOM/page state, console logs, pointer frames, workspace OP diffs, and markers.
4. `IDEStreamCursor` replay traversal, including branch-aware compare/apply/revert.
5. Timeline, audio, browser iframe, and pointer renderers that expose play/pause/seek UI over the action cursor.

Completion verdict:

Practical understanding: complete.

This document is enough to explain how Scrimba record/replay works in practice and how its main parts fit together.

Exact end-to-end implementation: not complete.

The remaining gaps are not broad exploration gaps. They are specific missing implementation surfaces:

- the service-worker tracker path behind `/__sw__tracker.js`, especially for selection and active-state capture;
- the exact bootstrap-side logic from `/assets/webcontainer.RMFWBHQ3.mjs?file`;
- backend implementations for stream persistence, chunk serving, and `load_from_prod()`.

## Stream Format And Storage

High confidence:

- `Scrim.stream` is a `ScrimStream`, which extends `OPDataStream`.
- `ScrimStream.httpUrl` resolves to `/legacy/files/<stream-id>`, while generic `OPByteStream.httpUrl` resolves to `/op/stream/<id>`.
- `OPDataStream.push(...values)` serializes values with `OP.msgpack.packMultiple(...)` and appends the bytes to an `OPByteStream`.
- `IDEStream.syncBuffer()` reads only the contiguous prefix of `stream.chunked`, then decodes new bytes through `OP.msgpack.createUnpacker().unpackMultiple(...)`.
- Numeric decoded values are stream controls:
  - large positive values are absolute timestamps;
  - smaller positive values are time deltas;
  - negative values select the next action type.
- Non-numeric decoded values are payloads for the current action type and are deserialized through the opcode-to-class map.
- `IDEStream.write(action, options)` emits timestamp/delta markers, emits a negative type marker when the action type changes, then appends the action's encoded payload.
- `OPBinaryChunk`, `OPBufferChunks`, and `OPBinaryChunkRequest` handle byte-range loading, authored byte flushing, contiguous readable-size calculation, and missing-range serving.

Blocked locally:

- The server-side store for `/legacy/files/<stream-id>`, `/op/stream/<id>`, and `OPBinaryChunk` persistence is not present.
- `ScrimStream.load_from_prod()` is an RPC declaration/call path only; its backend implementation is not in the local artifacts.

## Recording Capture

High confidence:

- Text capture lives in `TextModel.setupMonaco()`. It wraps Monaco `model.applyEdits`, turns simple inserts into `LCINSERT`, simple deletes into `LCDELETE`, complex edits into `LCEDIT`, and captures selection changes through `LCSELECTION` or by attaching selection data to the preceding text action.
- Monaco scroll changes are observed, but the visible producer writes `scrollTop`/`scrollLeft` widget state. `LCSCROLL` exists as an opcode and `TextScrollAction`, but a local string/offset scan found no producer outside enum/action-class references.
- `tmp/tracker.4FYFXZYK.iife.js` is the standalone preview tracker. Its `WebStreamWriter` initializes with `[9, pvn, serialize($doc), serialize($location)]`, starts with `[1, serialize(root)]`, and posts callback messages to `window.parent` or `OP_ELECTRON_TRACKER`.
- The standalone tracker serializes child-list mutations as `[2, target, previousSibling, removed[], added[]]`, text mutations as `[3, target, text]`, property sync as `[4, node, prop, value]`, attribute sync as `[5, node, attr, value]`, focus changes as `[6]/[7]`, asset or stylesheet resolution as `[8, kind, url, payload]`, hover sync as `[10, node]`, and console logs as `[11, level, serializedArgs]`.
- The standalone tracker monkeypatches form-control setters and history methods, intercepts console/error/unhandledrejection, and listens to `input`, `focus`, `blur`, `scroll`, `hashchange`, `popstate`, `pointermove`, `pointerdown`, and `pointerup`.
- `select` and `selectionchange` listeners are present in the standalone tracker but currently no-op, and no explicit active-state producer is visible there.
- Browser preview capture still flows through `runner-frame.handle(...)`, but two input shapes are visible locally: standalone tracker callback actions (`append`, `event`, `resolveAsset`, and generic `on${action}` dispatch such as `keycombo`) and older/service-worker `actions` arrays of real stream opcodes plus location/history/pageload/loader messages.
- Pointer capture is handled by `pointer-tracker`, which listens for pointer, keyboard, and browser preview `browserevent` messages. It stamps coordinates, flags, hover target, layout, and previous frame, then pushes `IDEPointerUpdateAction` while recording or debugging outside workspace mode.
- Modern workspace capture uses `SIWorkspace.sync()`, which compares `$stream` and `$plain`, pushes an initial `OPSNAPSHOT` when needed, and emits `OPDELTA` for subsequent diffs.
- Modern microphone capture uses `AudioRecording` and browser `MediaRecorder`; WebM bytes are assembled and appended to `MediaStreamRecording.webm`, an embedded `OPByteStream`. These bytes are not stored in the main action stream.
- `MSR_START`, `MSR_CHUNK`, and `MSR_END` opcodes exist, but `MSR_CHUNK` has no local producer. Modern media persistence uses the separate WebM byte stream path.
- Recording starts through `IDEStream.new_recording` / `newΞrecording`, creates a `ScrimRec`, writes markers, enables pointer tracking for legacy mode, and may create an `AudioRecording`.
- Recording stop writes a sync/timeline marker, sets recording end offset, stops/stages media, saves the `Scrim`, and refreshes the timeline.

Blocked locally:

- `/__sw__tracker.js` is referenced by the service-worker/container path but not present as a standalone artifact file.
- The added `headless.html`, `headless-siO4QJGT.js`, `webcontainer.5162ecc8.js`, `iframe.main.5162ecc8.js`, and `semver-Zyv2pDaP.js` identify the external StackBlitz runtime shell, but the bundle-mounted `/assets/webcontainer.RMFWBHQ3.mjs?file` bootstrap text and backend implementations are still not visible locally.

## Replay And Seeking

High confidence:

- `IDEStream.load()` resolves the `Scrim`, loads the trunk or branch stream, seeds empty child branches with `SNAPSHOT` or `OPSNAPSHOT` when needed, calls `syncBuffer()`, and marks the branch loaded.
- `IDEStreamCursor` owns replay traversal. It tracks the current action, current target, active branch path, and apply/revert stack.
- `IDEStreamCursor.lineage(action)` walks from an action up through branch seed links.
- `IDEStreamCursor.compare(current, target)` finds whether replay can step forward, must revert on the same branch, or must route across a branch ancestry boundary.
- `IDEStreamCursor.sync(target)` reverts to the shared point, applies forward actions, crosses branch routes through child branch first actions, updates `currentAction`, enters the current branch, stops editing if replay moved past an editable branch tip, and notifies marked targets through `synced_`.
- `commitWithCursor` and `revertWithCursor` on actions are the reversible replay boundary. Actions mark affected targets so UI components can refresh after sync.

## Replay Action Domains

High confidence:

- Widget/state actions:
  - `CreateWidgetAction` commits or reverts widget creation and marks the target.
  - `RemoveWidgetAction` commits or reverts widget deletion.
  - `ConfigSetAction` updates target/widget data or `SIObject` state, stores prior value, and updates stream read state during parsing.
  - `PatchAction` merges patch data and stores prior value for revert.
  - `SyncAction` is a no-op replay boundary.
- File/view/layout actions:
  - `FSRenameAction`, `FSMoveAction`, and `FSRemoveAction` mutate legacy file entries and editor views.
  - `LayoutAction`, `BrowserLayoutAction`, and `NodeLayoutAction` restore previous layout data on revert.
  - `ViewOpenAction` / `ViewCloseAction` update editor group item lists; `ViewMoveAction` and `ViewPinAction` exist as minimal registered actions.
- Console/page actions:
  - `ConsoleAction` subclasses apply/revert through `IDEConsole`.
  - `PageRequestAction`, `PageLoadAction`, `PageLoadedAction`, and `PageHistoryAction` create/select `BrowserPage` instances, update browser URL/status/initial state, and clear console on page load.
  - `PageLoadedAction` and `PageLogAction` use a dedupe strategy.
- DOM actions:
  - `DOMAction` attaches actions to the last page, resolves DOM nodes by path, and only commits/reverts when the page is syncing.
  - `DOMResetAction` clears/rebuilds page root children and reindexes nodes.
  - `DOMMutateAction` calls `BrowserPage.applyMutations(...)` and reverts through `revertMutations(...)`.
  - `DOMSelectionAction`, `DOMScrollAction`, `DOMFocusInAction`, `DOMHoverInAction`, and `DOMActiveInAction` update page selection, scroll, focus, hover, and active state with stored prior values for revert.
- Pointer actions:
  - `IDEPointerUpdateAction` delta-encodes pointer coordinates, links frames, captures target/layout snapshots, groups frames into `PointerUpdateGroup`, and commits/reverts by updating the pointer widget keyframe.
- Workspace OP actions:
  - `IDEOPSnapshotAction` applies whole `SIWorkspace` snapshots and stores reverse diffs.
  - `IDEOPDeltaAction` applies incremental workspace diffs and reverts through stored reverse diff paths.
  - `SIRollbackAction` computes and applies a diff from stream state to a target snapshot.
- Save/marker actions:
  - `SaveAction` records `lastSave` and stored file body.
  - Generic marker actions and `ScrimCommit` model markers drive timeline marker rendering, but no local registered `COMMIT=220` action producer/class was found.

## Browser Replay

High confidence:

- `BrowserPage` is the replay document model. It stores URL/status/log/history/loading state, serialized HTML/attributes, focus/hover/active/selection state, and node indexes.
- `BrowserPage.applyMutations(...)` interprets the DOM mutation subprotocol: reset, insert, remove, init, insert-after, insert-adjacent, set attribute, set property, set text, and reflow.
- `BrowserPage` rewrites assets/styles, maps path ids to DOM nodes, applies pseudo-state classes, and applies selection to text/input/textarea nodes.
- `player-frame` waits for the player service-worker frame, loads `/__sw__blank.html`, and renders a replayed `BrowserPage` into its iframe.
- `runner-frame` is the live preview capture side; `player-frame` is the replay side.

Blocked locally:

- `/__sw__.html`, `/__sw__blank.html`, and `/__sw__tracker.js` are referenced but not present as standalone artifact files. The bundle contains the surrounding message handlers, not the frame/tracker source.

## Timeline, Audio, And Controls

High confidence:

- `BaseTimeline` defines offset/time conversion, clip duration/progress, clamping, current time/current offset, and audio schedule/unschedule hooks.
- `ClipTimeline` wraps audio playback for a clip. It preloads a single audio source when available, sets audio playback rate from `ide.pbr`, plays/pauses the audio element, reacts to seeking/seeked/pause events, and unschedules audio on leave/dispose.
- `IDEBranchTimeline` maps action offsets to timeline time, exposes `targetAction`, `seekToOffset`, `seekTo`, skip-forward/backward, play state, playback rate, current time, and current offset. It uses keyframes/clips to jump to meaningful positions when skipping.
- `scrim-play-controls` wires UI/hotkeys to playback:
  - space toggles timeline playback when not editing;
  - left/right skip backward/forward;
  - shift+comma / shift+period adjust playback speed;
  - the visible play button calls `timeline.toggle(...)`.
- Clip/studio editing uses a separate `ide-scrim-control` path that schedules audio slices and edits ranges; that is timeline editing, not the normal lesson/player replay path.

## Branches And Replay

High confidence:

- Branch identity is stored on `Scrim` model records through `origin`, `origin_index`, `origin_offset`, `origin_snapshot`, `via_lesson`, and `kind`.
- `IDEStream.newFork(...)` captures the current IDE state as `SNAPSHOT` or `OPSNAPSHOT`, creates a child `Scrim` with `kind: "scribble"` by default, and seeds its stream.
- `IDEStream.load()` links child branch first action to the parent seed action, so cursor lineage can cross parent/child replay boundaries.
- Exercise solutions are ordinary branch scrims with `kind: "solution"` and an `exercise` reference.
- Nested route/path behavior is client-visible in `scrim-view.sync/open`, `Scrim.asΞurl`, `Scrim.toΞurl`, `ScrimPractice.toΞurl`, and `IDEStream.toΞurl`.

## Local Completion And Blockers

High confidence:

The local bundle-side record/replay architecture is now traced across storage, capture, action protocol, action replay, cursor seeking, timeline/audio controls, browser replay, pointer replay, workspace OP replay, and branch replay.

Under a practical bundle-research criterion, this is complete.

Under the stricter criterion "can exactly tell how recording and replay are implemented", it is not complete yet, because the remaining missing pieces are still part of the real implementation rather than optional background context.

The remaining unknowns require artifacts or server code that are not present locally:

- `/assets/webcontainer.RMFWBHQ3.mjs?file`
- `/__sw__.html`
- `/__sw__blank.html`
- `/__sw__tracker.js`
- server implementation for `/legacy/files/<id>`, `/op/stream/<id>`, `OPBinaryChunk` persistence, and `ScrimStream.load_from_prod()`

Local searches that support the blocker statement:

- `tmp/tracker.4FYFXZYK.iife.js`, `tmp/headless.html`, `tmp/headless-siO4QJGT.js`, `tmp/webcontainer.5162ecc8.js`, `tmp/iframe.main.5162ecc8.js`, and `tmp/semver-Zyv2pDaP.js` are now present locally and cover the standalone tracker plus the StackBlitz headless runtime shell.
- Filename and string/offset search still find no standalone `/__sw__.html`, `/__sw__blank.html`, `/__sw__tracker.js`, or `/assets/webcontainer.RMFWBHQ3.mjs?file` source text outside bundle references.

## Key Evidence Spans

Character offsets are zero-based half-open ranges.

| Area                                     | File                           | Source span               | Character span    |
| ---------------------------------------- | ------------------------------ | ------------------------- | ----------------- |
| `IDEStreamAction` base                   | `tmp/chunks/ide.36BDFLCO.js`   | `5338:11338-5338:14763`   | `2293464-2296889` |
| Widget/state action cluster              | `tmp/chunks/ide.36BDFLCO.js`   | `5338:15013-5338:20378`   | `2297139-2302504` |
| Text action cluster                      | `tmp/chunks/ide.36BDFLCO.js`   | `5338:20610-5338:23580`   | `2302736-2305706` |
| Layout/console/page action cluster       | `tmp/chunks/ide.36BDFLCO.js`   | `5338:23752-5338:37049`   | `2305878-2319175` |
| DOM replay action cluster                | `tmp/chunks/ide.36BDFLCO.js`   | `5338:38425-5338:41529`   | `2320551-2323655` |
| Media/recording action cluster           | `tmp/chunks/ide.36BDFLCO.js`   | `5338:41722-5338:42798`   | `2323848-2324924` |
| Layout/widget/view/misc action cluster   | `tmp/chunks/ide.36BDFLCO.js`   | `5338:43204-5338:49476`   | `2325330-2331602` |
| Workspace OP action cluster              | `tmp/chunks/ide.36BDFLCO.js`   | `5338:49586-5338:51905`   | `2331712-2334031` |
| `AudioRecording`                         | `tmp/chunks/ide.36BDFLCO.js`   | `5338:76886-5338:82911`   | `2359012-2365037` |
| `IDEStreamCursor`                        | `tmp/chunks/ide.36BDFLCO.js`   | `5338:83074-5338:87274`   | `2365200-2369400` |
| `IDEStream`                              | `tmp/chunks/ide.36BDFLCO.js`   | `5340:4212-5340:68750`    | `2382265-2446803` |
| `TextModel`                              | `tmp/chunks/ide.36BDFLCO.js`   | `5340:90312-5341:748`     | `2468365-2472551` |
| `BrowserPage`                            | `tmp/chunks/ide.36BDFLCO.js`   | `5653:613-5653:13553`     | `2493739-2506679` |
| `runner-frame`                           | `tmp/chunks/ide.36BDFLCO.js`   | `5653:18554-5653:21731`   | `2511680-2514857` |
| `player-frame`                           | `tmp/chunks/ide.36BDFLCO.js`   | `5653:22104-5653:23413`   | `2515230-2516539` |
| Standalone tracker core                  | `tmp/tracker.4FYFXZYK.iife.js` | `431-904`                 | `n/a`             |
| Standalone tracker bridge/bootstrap      | `tmp/tracker.4FYFXZYK.iife.js` | `923-987`                 | `n/a`             |
| Headless runtime entry                   | `tmp/headless.html`            | `1-37`                    | `n/a`             |
| Headless runtime bootstrap               | `tmp/headless-siO4QJGT.js`     | `1`                       | `n/a`             |
| `editor-widget`                          | `tmp/chunks/ide.36BDFLCO.js`   | `5653:52509-5653:65135`   | `2545635-2558261` |
| `ide-pointer-widget`                     | `tmp/chunks/ide.36BDFLCO.js`   | `5653:90262-5653:97681`   | `2583388-2590807` |
| `pointer-tracker`                        | `tmp/chunks/ide.36BDFLCO.js`   | `5655:76081-5655:80641`   | `2712579-2717139` |
| `BaseTimeline`                           | `tmp/chunks/ide.36BDFLCO.js`   | `5655:23143-5655:28095`   | `2659641-2664593` |
| `ClipTimeline`                           | `tmp/chunks/ide.36BDFLCO.js`   | `5655:28430-5655:30775`   | `2664928-2667273` |
| `IDEBranchTimeline` seek/play core       | `tmp/chunks/ide.36BDFLCO.js`   | `5655:186516-5655:194852` | `2823014-2831350` |
| `scrim-play-controls`                    | `tmp/chunks/ide.36BDFLCO.js`   | `5655:132398-5655:140061` | `2768896-2776559` |
| `ide-scrim-control` clip editor playback | `tmp/chunks/ide.36BDFLCO.js`   | `5655:239930-5655:257485` | `2876428-2893983` |
| `SIWorkspace`                            | `tmp/chunks/ide.36BDFLCO.js`   | `516:35244-520:8874`      | `1122747-1143225` |
| `SIWebContainer` bridge                  | `tmp/chunks/ide.36BDFLCO.js`   | `521:4018-523:1180`       | `1159200-1165200` |
| `ScrimStream`                            | `tmp/app.UK3DL7B2.js`          | `738:940-738:2463`        | `2872606-2874129` |
| `ScrimRec`                               | `tmp/app.UK3DL7B2.js`          | `739:43206-739:48806`     | `2934102-2939702` |
| `MediaStreamRecording`                   | `tmp/app.UK3DL7B2.js`          | `827:47367-827:50218`     | `3292226-3295077` |
| `OPDataStream`/byte stream storage       | `tmp/app.UK3DL7B2.js`          | `129:205977-129:224711`   | `876046-894780`   |
