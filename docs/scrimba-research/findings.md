# Scrimba Research Findings

Last updated: 2026-06-14

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
- `SnapshotAction` and `KeyframeAction` both deserialize widget/workspace snapshots; keyframes are specialized snapshots.
- `SaveAction` updates a file's `lastSave` and persisted body, and has a `scrim-save-marker`.
- Marker actions contribute visible timeline markers.
- `pushAction(...)` starts editing if possible, or creates a forked branch when editing is not available. Significant actions mark the `Scrim` edited and can trigger autosave-like behavior after repeated changes.
- `newFork(...)` creates a new `Scrim` with `kind: "scribble"` by default, records `origin`, `via_lesson`, `origin_offset`, `origin_index`, and `origin_snapshot`, then seeds it with a snapshot action.
- `trimToAction(...)` rolls the branch back to an action, removes later recordings/commits, and trims the stream buffer to the target byte end.

Medium confidence:

- The stream protocol is optimized around small, relative arrays. Text selection can encode only the changed suffix when the previous selection has the same prefix.
- `SnapshotAction` is used for initial or recovery state, while normal playback applies incremental actions.

## Editing, Branching, And Recording

High confidence:

- `IDEStream` owns both stream mechanics and user-facing actions such as start editing, jump to end, recording, run, progress marking, solution checking, saving, discarding, and exporting.
- `startEditing` syncs to stream end, checks `editablePhi`/`editableΦ`, sets `mode = "edit"`, and reflows the IDE.
- `stopEditing` sets mode back to view.
- Recording starts through `new_recording`/`newΞrecording`, opens `ide-start-rec-dialog`, writes a marker, creates a `ScrimRec`, enables pointer tracking for legacy mode, and can create an `AudioRecording` when microphone input exists.
- Recording stop writes a sync/timeline marker, sets the recording end offset, calls the recording stop path, stages the recording, saves the `Scrim`, and refreshes the timeline.
- `mark_progress`/`markΞprogress` persists progress and last offset on the `Scrim`; when the timeline is near the end it can mark finished and notify Coursera embed completion.
- `check_solution`/`checkΞsolution` snapshots the current file system and calls an exercise wrapper's server-side solution checker.

Medium confidence:

- Editing a non-current or non-editable stream is handled by creating a new branch/scribble and applying the action there.
- Workspace-mode recording staging differs from legacy recording: workspace mode stages through `wsp.sync()` and `ScrimRec.stage().mount()`, while legacy mode enables pointer tracker directly.

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
- Service-worker/iframe infrastructure includes `ide-sw-container`, `ServiceWorkerFrame`, `runner-frame`, `player-frame`, `__sw__.html`, `__sw__blank.html`, and `__sw__tracker.js`.

Medium confidence:

- WebContainer hosts the running project, while `BrowserPage`/tracker infrastructure captures preview state and makes replay deterministic.
- The service-worker frames isolate runner/player origins and route preview/browser requests through Scrimba-controlled message handlers.

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

- Exact binary/network format of persisted streams was not fully decoded.
- Exact backend API endpoints for stream save/load were not fully traced.
- Exact capture source for Monaco events and browser tracker events needs targeted de-minification.
- Branch load/sync semantics need deeper tracing through `IDEBranch.load`, `IDEStream`, and `ScrimStream`.
- The relation between legacy `IDE*` widgets and newer `SIWorkspace` objects needs a dedicated comparison.
