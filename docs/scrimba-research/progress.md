# Scrimba Research Progress

Last updated: 2026-06-15

## Current Status

This is a bundle-level research pass. It identifies the major architecture, action protocol, client-side stream persistence path, capture/branch behavior, nested route behavior, the legacy-vs-modern workspace split, the modern workspace host/provider path, runtime request routing, WebContainer OP bridge shape, host save/diff persistence path, and key differences from this repo's current recording architecture, but does not fully de-minify every class or server RPC boundary.

Overall status: partial, usable handoff.

Progress tracking rule: every completed source area must be recorded with file spans. Because the Scrimba bundles are minified into very long lines, line spans are written as `line:column` and character spans are the reliable skip markers. Character offsets below are zero-based half-open ranges unless a row says otherwise.

## File Inventory And Research Status

| File                                |   Size | Status                                 | Summary                                                                                                                                                                                         |
| ----------------------------------- | -----: | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tmp/app.UK3DL7B2.js`               | 3.8 MB | Partially researched                   | Main platform/app bundle. Contains `Scrim*` content models, course/app/routing UI, AI provider/model objects, archivers, captions/audio models.                                                 |
| `tmp/chunks/ide.36BDFLCO.js`        | 2.8 MB | Partially researched, highest priority | IDE/player/runtime bundle. Contains action protocol, stream cursor, branches, timeline, Monaco-facing editor models, browser DOM replay, WebContainer runtime, workspace, AI workspace actions. |
| `tmp/scrim.blank.json.5TFCQ3DL.js`  |   2 KB | Researched                             | Default blank workspace layout/state snapshot.                                                                                                                                                  |
| `tmp/index.ZRFBPBWE.css`            | 1.1 MB | Not deeply researched                  | CSS for app/IDE. Has a `sourceMappingURL` to a missing CSS map. Useful later for UI class mapping.                                                                                              |
| `tmp/chunks/chunk.L47Z5YT6.js`      | 1.8 MB | Lightly classified                     | Monaco/editor infrastructure. Contains VS Code/Monaco code and language/editor behavior.                                                                                                        |
| `tmp/chunks/chunk.QMCWAF6X.js`      | 476 KB | Lightly classified                     | Shared UI/runtime framework, DOMPurify/marked-like support, Imba-ish runtime pieces.                                                                                                            |
| `tmp/chunks/chunk.TZHF2V3H.js`      | 256 KB | Lightly classified                     | CodeMirror/Lezer-style parser infrastructure.                                                                                                                                                   |
| `tmp/chunks/tsMode.4DHLWYKR.js`     |  24 KB | Lightly classified                     | Monaco TypeScript mode worker integration.                                                                                                                                                      |
| `tmp/chunks/chunk.BJMBBBNU.js`      |   6 KB | Lightly classified                     | Monaco TypeScript language contribution support.                                                                                                                                                |
| `tmp/chunks/chunk.TIEUX6A3.js`      |   5 KB | Lightly classified                     | Monaco TypeScript language setup/import shim.                                                                                                                                                   |
| `tmp/chunks/typescript.SIWHZMSK.js` |  <1 KB | Lightly classified                     | Imports TypeScript support chunks.                                                                                                                                                              |
| `tmp/chunks/chunk.5UVTBFB6.js`      |   1 KB | Lightly classified                     | Tiny shared module/bootstrap helper.                                                                                                                                                            |
| `tmp/arrow.HORQ22FG.png`            |   4 KB | Not researched                         | Static asset, probably cursor/pointer UI.                                                                                                                                                       |

## Completed Research Tasks

- Mapped file sizes, line counts, and bundle roles.
- Extracted import structure for major JavaScript bundles.
- Extracted custom element registrations.
- Extracted focused global model names related to Scrim, IDE, actions, timeline, browser, workspace, and AI.
- Extracted class-local method summaries for key Scrim and IDE classes.
- Extracted action opcode table and target IDs.
- Extracted partial stream framing behavior from `IDEStream.parsedValue`, `syncBuffer`, and `write`.
- Extracted client-side stream persistence behavior from `IDEStream.load`, `ScrimStream`, `OPDataStream`, `OPByteStream`, `OPBufferChunks`, `OPBinaryChunk`, and `OPBinaryChunkRequest`.
- Extracted capture paths for Monaco text edits/selections/scroll state, browser tracker action messages, pointer tracking, and modern audio recording.
- Extracted pointer replay/rendering path through `IDEPointerUpdateAction`, `PointerUpdateGroup`, `ide-pointer-widget`, `pointer-wave`, and `PointerFrame`.
- Extracted DOM mutation subprotocol.
- Extracted branch/editing/recording behavior from `IDEStream`.
- Extracted branch ancestry, fork creation, cursor route traversal, and exercise solution branch creation.
- Extracted workspace split between legacy `IDEFile`/`IDEFS` widget state and modern `SIWorkspace`/`SIFS` OP-diff state.
- Extracted host/provider sync path through `HostWorkspace`, `LocalWorkspace`, `WCWorkspace`, `HostFile`/`HostDir`, `SIWorkspace.host`, and `SIWebContainer`.
- Extracted host/provider RPC surface: `LocalWorkspace.merge`, `WCWorkspace.merge`, `WCWorkspace.install`, `WCWorkspace.webfetch`, and `WCWorkspace.serializeDir` are visible as RPC actions with hidden callback implementations; `WCWorkspace.boot` is the visible client action that calls `SWC.boot(...)` and one-time `install(...)`.
- Extracted runtime request routing through `ide-sw-container`, `ServiceWorkerFrame`, `runner-frame`, `player-frame`, `scrim-view.oncontainermessage`, and `SIWebContainer` bridge handling.
- Deepened WebContainer bridge handling: bundled references point to `/assets/webcontainer.RMFWBHQ3.mjs?file` and `/assets/tracker.4FYFXZYK.iife.js`; `SIWebContainer` mounts `.bootstrap.mjs`, creates a bridge iframe on reserved port `8123`, parses bridge `ArrayBuffer` messages through `OP.$parse`, applies `OPDataUpdate` patches, and sends messages with `OP.$pack` plus `postMessage`.
- Deepened route/path behavior for nested scribbles and exercise solutions through `scrim-view.sync/open`, `Scrim.asΞurl`, `Scrim.toΞurl`, `ScrimPractice.toΞurl`, and `IDEStream.toΞurl`.
- Deepened host save persistence after `HostWorkspace.$changed`: visible client code throttles inherited `save()`, `OPObject.$save()` delegates to the object's `$$store`, and the server-backed common store sends an `OPStorePush` diff.
- Extracted commit/marker UI semantics around `ScrimCommit`, `scrim-commit-marker`, `ide-commit-dialog`, and `IDEStream.segments`; no active registered `COMMIT=220` action class was found in the inspected client bundle.
- Extracted media persistence semantics around `ScrimRec.byte_offset`, `AudioRecording`, `MediaStreamRecording`, and `MSR_*`; `MSR_CHUNK=242` appears only in the opcode enum in this bundle.
- Confirmed that `/__sw__.html`, `/__sw__blank.html`, `/__sw__tracker.js`, `/assets/tracker.4FYFXZYK.iife.js`, and `/assets/webcontainer.RMFWBHQ3.mjs?file` are referenced by the bundle but not present as standalone artifact files under `tmp/` or elsewhere in this repo. Only bundle/documentation/source-code string references were found.
- Confirmed by string/offset scan that `LCSCROLL` has no producer in the local artifacts outside the opcode enum and `TextScrollAction` class, and `MSR_CHUNK` has no local occurrence outside the opcode enum.
- Compared Scrimba's action stream architecture with this repo's frame/delta recording, workspace/runtime snapshot, storage codec, and WebContainer provider approach.
- Inspected `scrim.blank.json` manually.
- Wrote durable research docs:
  - `README.md`
  - `findings.md`
  - `action-protocol.md`
  - this `progress.md`

## Completed Evidence Ranges

Coverage note: these ranges have been inspected and summarized for architecture/protocol research. Future agents can skip them for the same high-level questions, but should reopen a targeted method if they need exact statement-by-statement behavior.

### `tmp/app.UK3DL7B2.js`

| Area                     | Minified symbol | Completed source span   | Character span    | Notes                                                                 |
| ------------------------ | --------------- | ----------------------- | ----------------- | --------------------------------------------------------------------- |
| `WebViewStream`          | `AAe`           | `738:492-738:852`       | `2872158-2872518` | Load-from-production RPC action model.                                |
| `ScrimStream`            | `ice`           | `738:940-738:2463`      | `2872606-2874129` | Scrim byte stream URL, trim, preview state.                           |
| `ScrimPractice`          | `Yi`            | `738:3991-738:14478`    | `2875657-2886144` | Exercise/practice branch creation and solution reset.                 |
| `ScrimSnapshot`          | `EH`            | `739:57575-739:58270`   | `2948471-2949166` | Snapshot body/object preview model.                                   |
| `ScrimRec`               | `Ql`            | `739:43206-739:48806`   | `2934102-2939702` | Recording model, `byte_offset`, stop/process/caption actions.         |
| `ScrimClip`              | `w5`            | `739:39444-739:41578`   | `2930340-2932474` | Audio/timeline clip abstraction.                                      |
| `ScrimAudio`             | `hj`            | `739:49052-739:50094`   | `2939948-2940990` | Audio embed with WebM stream/captions/offset.                         |
| `ScrimCommit`            | `C5`            | `739:53664-739:56394`   | `2944560-2947290` | Commit marker model, summary/squash/template/snapshot fields, dialog. |
| `ScrimPreview`           | `ab`            | `741:768-741:3583`      | `2951961-2954776` | Preview/layout snapshot model.                                        |
| `Scrim`                  | `gr`            | `746:4688-746:34618`    | `2965115-2995045` | Primary scrim content object, refs, recs, commits, stream/head/base.  |
| `Caption`                | `Tj`            | `827:42373-827:43485`   | `3287232-3288344` | Caption part model.                                                   |
| `Captions`               | `MC`            | `827:43559-827:45131`   | `3288418-3289990` | Caption collection/transcript support.                                |
| `MediaStreamRecording`   | `Jp`            | `827:47367-827:50218`   | `3292226-3295077` | Media recording model, WebM byte stream.                              |
| `ScrimAudioTrack`        | `IC`            | `827:51737-827:53847`   | `3296596-3298706` | Audio track/caption model.                                            |
| `ScrimArchiver`          | `Vqt`           | `859:29-859:3596`       | `3363596-3367163` | Export/archive base.                                                  |
| `WSPScrimArchiver`       | `zqt`           | `859:3685-859:4833`     | `3367252-3368400` | Workspace export variant.                                             |
| `ViteScrimArchiver`      | `Bqt`           | `859:4928-868:6`        | `3368495-3370172` | Vite export path.                                                     |
| `WebpackScrimArchiver`   | `Wqt`           | `868:102-876:611`       | `3370268-3372986` | Webpack export path.                                                  |
| `OPBinaryChunkRequest`   | `TO`            | `129:205977-129:207010` | `876046-877079`   | Missing-range request handler.                                        |
| `OPBinaryChunk`          | `T_`            | `129:208345-129:210816` | `878414-880885`   | Byte chunk load/flush/patch behavior.                                 |
| `OPBufferChunks`         | `mYe`           | `129:210900-129:214926` | `880969-884995`   | Contiguous readable byte buffer/fragments.                            |
| `OPByteStream`           | `P_`            | `129:218167-129:224050` | `888236-894119`   | Fetch/append/trim byte stream.                                        |
| `OPDataStream`           | `ZYe`           | `129:224194-129:224711` | `894263-894780`   | Msgpack multi-value append layer.                                     |
| `OPDataUpdate`/structs   | `JNe`           | `122:46363-122:48383`   | `452600-454620`   | `OPStruct`, `OPDataUpdate` value/id/rev shape, packed array structs.  |
| OP pack/parse helpers    | n/a             | `129:4431-129:5931`     | `674500-676000`   | `OP.$pack`, `$unpack`, `$parse` msgpack helpers.                      |
| `OPObject.$save`         | `an`            | `128:62524-128:65753`   | `616969-620198`   | Autosave and inherited save delegation into `$$store.save`.           |
| `OPCommonData.save`      | `AX`            | `146:1623-146:5073`     | `1165200-1168650` | Store diff save path, local store save, `OPStorePush` start.          |
| OP server update path    | `p2`            | `146:5073-146:11623`    | `1168650-1175200` | `OPStorePush` response handling and `OPDataUpdate` patch handling.    |
| `ScrimPractice.toΞurl`   | `Yi`            | `738:13934-738:14584`   | `2885600-2886250` | Practice URL suffixing relative to parent scrim/stream.               |
| `Scrim.asΞurl/toΞurl`    | `gr`            | `746:23973-746:24623`   | `2984400-2985050` | Nested scribble/exercise-solution URL construction.                   |
| `HostFSEntry`            | `z$`            | `900:12050-900:15148`   | `3685495-3688593` | Host file-system entry base.                                          |
| `HostFile`               | `qE`            | `900:15228-900:18043`   | `3688673-3691488` | Host file sync/read/write model.                                      |
| `HostDir`                | `B$`            | `900:18117-900:21432`   | `3691562-3694877` | Host directory crawl/watch model.                                     |
| `HostFSRoot`             | `Xfe`           | `900:21506-900:22303`   | `3694951-3695748` | Host FS root model.                                                   |
| `HostWorkspace`          | `j0`            | `901:1814-901:4327`     | `3702036-3704549` | Base host workspace and save throttle.                                |
| `HostWorkspace.$changed` | `j0`            | `901:1628-901:4398`     | `3701850-3704620` | Exact throttled `save()` trigger and `$cloud`/`$send` behavior.       |
| `LocalWorkspace`         | `W$`            | `901:4428-901:6385`     | `3704650-3706607` | Local host/RPC workspace.                                             |
| `WCWorkspace`            | `la`            | `901:6553-901:12049`    | `3706775-3712271` | WebContainer host/RPC workspace.                                      |
| `AppIDE`                 | `Xk`            | `157:83927-157:85489`   | `1965690-1967252` | App-level IDE route/wrapper.                                          |

### `tmp/chunks/ide.36BDFLCO.js`

| Area                         | Minified symbol | Completed source span     | Character span    | Notes                                                                               |
| ---------------------------- | --------------- | ------------------------- | ----------------- | ----------------------------------------------------------------------------------- |
| Opcode/target enum           | n/a             | `41:38849-41:39090`       | `567982-568223`   | Includes `COMMIT=220`, `MSR_START=241`, `MSR_CHUNK=242`, `MSR_END=243`, target ids. |
| `SIObject`                   | `J2`            | `41:41234-41:43657`       | `570367-572790`   | Modern workspace object base.                                                       |
| `SIPointer`                  | `Ml`            | `41:45222-41:47908`       | `574355-577041`   | Modern/live pointer state model.                                                    |
| `si-pointer-view`            | `R_`            | `41:48918-41:51377`       | `578051-580510`   | Modern/live pointer view renderer.                                                  |
| `SIRunner`                   | `Fs`            | `41:127455-42:2856`       | `656588-666527`   | Modern runner command execution.                                                    |
| `SITerminal`                 | `rp`            | `41:115660-41:117635`     | `644793-646768`   | Modern terminal model.                                                              |
| `SIBrowser`                  | `ap`            | `42:30907-42:33290`       | `694578-696961`   | Modern browser view model.                                                          |
| `SIWebConsole`               | `AG`            | `42:88417-42:88848`       | `752088-752519`   | Modern web console model.                                                           |
| `SIFSEntry`                  | `dn`            | `516:5336-516:10783`      | `1092839-1098286` | Modern filesystem entry base.                                                       |
| `SIFile`                     | `Xa`            | `516:10858-516:15269`     | `1098361-1102772` | Modern file model.                                                                  |
| `SIDir`                      | `Yo`            | `516:15339-516:20898`     | `1102842-1108401` | Modern directory/snapshot/WebContainer tree model.                                  |
| `SIFS`                       | `qh`            | `516:22002-516:24518`     | `1109505-1112021` | Modern filesystem root wrapper.                                                     |
| `SIWorkspace`                | `Pi`            | `516:35244-520:8874`      | `1122747-1143225` | Modern workspace snapshots, diffs, sync, host provider.                             |
| `SIWebContainerPort`         | `Cp`            | `521:4542-521:5552`       | `1159724-1160734` | WebContainer port model.                                                            |
| `SIWebContainer`             | `Qf`            | `521:5610-523:1172`       | `1160792-1165192` | WebContainer boot, bridge, spawn, tracker install.                                  |
| `SIWebContainer` assets/boot | `Qf`            | `521:4018-521:7618`       | `1159200-1162800` | Bootstrap/tracker asset URLs, WebContainer boot start, reserved port setup.         |
| `SIWebContainer` bridge/send | `Qf`            | `521:7418-523:1180`       | `1162600-1165200` | Bridge iframe, OP-packed `ArrayBuffer` receive/send and `postMessage`.              |
| `IDEStreamAction`            | `Jp`            | `5338:11338-5338:14763`   | `2293464-2296889` | Base reversible action and decode path.                                             |
| `SnapshotAction`             | `iw`            | `5338:16068-5338:17254`   | `2298194-2299380` | Legacy widget snapshot action.                                                      |
| `BranchAction`               | `rw`            | `5338:17424-5338:17516`   | `2299550-2299642` | Minimal branch action.                                                              |
| `ForkAction`                 | `sw`            | `5338:17669-5338:17740`   | `2299795-2299866` | Minimal fork action.                                                                |
| `KeyframeAction`             | `aw`            | `5338:19425-5338:19496`   | `2301551-2301622` | Specialized snapshot/keyframe action.                                               |
| `TextEditAction`             | `hw`            | `5338:20610-5338:21191`   | `2302736-2303317` | Multi-edit action.                                                                  |
| `TextInsertAction`           | `dw`            | `5338:21352-5338:22062`   | `2303478-2304188` | Insert action and compact encode.                                                   |
| `TextDeleteAction`           | `uw`            | `5338:22231-5338:22501`   | `2304357-2304627` | Delete action.                                                                      |
| `TextSelectionAction`        | `pw`            | `5338:22673-5338:23331`   | `2304799-2305457` | Cursor/selection action.                                                            |
| `TextScrollAction`           | `mw`            | `5338:23509-5338:23580`   | `2305635-2305706` | Scroll action class; producer not found.                                            |
| `PointerUpdateGroup`         | `gw`            | `5338:24296-5338:26475`   | `2306422-2308601` | Pointer update group.                                                               |
| `IDEPointerUpdateAction`     | `_w`            | `5338:26653-5338:30377`   | `2308779-2312503` | Pointer action delta encoding.                                                      |
| `FSMoveAction`               | `vw`            | `5338:31074-5338:31719`   | `2313200-2313845` | Filesystem move action.                                                             |
| `PageLoadAction`             | `Ew`            | `5338:34835-5338:35340`   | `2316961-2317466` | Page load action.                                                                   |
| `PageLogAction`              | `h3`            | `5338:37170-5338:38193`   | `2319296-2320319` | Console/page log action.                                                            |
| `DOMMutateAction`            | `Aw`            | `5338:39069-5338:39404`   | `2321195-2321530` | DOM mutation action.                                                                |
| `RecStartAction`             | `Dw`            | `5338:41722-5338:41877`   | `2323848-2324003` | Legacy recording start action.                                                      |
| `RecStopAction`              | `Hw`            | `5338:42049-5338:42120`   | `2324175-2324246` | Legacy recording stop action.                                                       |
| `MediaStreamAction`          | `Phe`           | `5338:42263-5338:42289`   | `2324389-2324415` | Base media stream action.                                                           |
| `MediaStreamStartAction`     | `Bw`            | `5338:42407-5338:42546`   | `2324533-2324672` | Minimal `MSR_START` action.                                                         |
| `MediaStreamEndAction`       | `Nw`            | `5338:42727-5338:42798`   | `2324853-2324924` | Minimal `MSR_END` action.                                                           |
| `TrimActionAction`           | `Fw`            | `5338:42970-5338:43041`   | `2325096-2325167` | Minimal trim action.                                                                |
| `MarkerAction`               | `Gw`            | `5338:44828-5338:45499`   | `2326954-2327625` | Generic timeline marker action.                                                     |
| `ViewOpenAction`             | `Qw`            | `5338:46305-5338:46771`   | `2328431-2328897` | Editor/view open action.                                                            |
| `ViewCloseAction`            | `Yw`            | `5338:46939-5338:47339`   | `2329065-2329465` | Editor/view close action.                                                           |
| `SaveAction`                 | `d3`            | `5338:47976-5338:48529`   | `2330102-2330655` | File save action and marker.                                                        |
| `SeedAction`                 | `Zw`            | `5338:48723-5338:48794`   | `2330849-2330920` | Minimal seed action.                                                                |
| `IDEOPDeltaAction`           | `tx`            | `5338:49586-5338:50695`   | `2331712-2332821` | Workspace OP diff action.                                                           |
| `IDEOPSnapshotAction`        | `ix`            | `5338:50865-5338:51361`   | `2332991-2333487` | Workspace OP snapshot action.                                                       |
| `SIRollbackAction`           | `rx`            | `5338:51540-5338:51905`   | `2333666-2334031` | Workspace rollback action.                                                          |
| `AudioRecording`             | `Xhe`           | `5338:76886-5338:82911`   | `2359012-2365037` | Browser `MediaRecorder`, WebM assembly, OP byte patching.                           |
| `IDEStream`                  | `Bt`            | `5340:4212-5340:68750`    | `2382265-2446803` | Branch/stream loading, parsing, writing, recording, trimming, commit dialog.        |
| `IDEStream.toΞurl`           | `Bt`            | `5340:43347-5340:43797`   | `2421400-2421850` | Branch URL fallback: route base, parent URL, or `/ide/<id>`.                        |
| `IDETrunk`                   | `zde`           | `5340:69325-5340:69351`   | `2447378-2447404` | Trunk stream class.                                                                 |
| `IDEBranch`                  | `cL`            | `5340:69429-5340:69534`   | `2447482-2447587` | Branch stream class.                                                                |
| `IDESolutionBranch`          | `hL`            | `5340:69610-5340:69852`   | `2447663-2447905` | Solution branch class.                                                              |
| `TextModel`                  | `$ue`           | `5340:90312-5341:748`     | `2468365-2472551` | Monaco model wrapper, `applyEdits` override, text/selection event producers.        |
| `IDEFile`                    | `Z0`            | `5341:827-5341:7306`      | `2472630-2479109` | Legacy file model.                                                                  |
| `IDEFS`                      | `Cx`            | `5341:14448-5341:16094`   | `2486251-2487897` | Legacy filesystem model.                                                            |
| `BrowserPage`                | `ML`            | `5653:613-5653:13553`     | `2493739-2506679` | Browser DOM replay engine.                                                          |
| `IDEBrowserHistory`          | `Bue`           | `5653:13645-5653:14605`   | `2506771-2507731` | Browser history model.                                                              |
| `ServiceWorkerFrame`         | `DL`            | `5653:15179-5653:15367`   | `2508305-2508493` | Service-worker iframe sender.                                                       |
| `ide-sw-container`           | `HL`            | `5653:15526-5653:18193`   | `2508652-2511319` | Service-worker runner/player container.                                             |
| `runner-frame`               | `NL`            | `5653:18554-5653:21731`   | `2511680-2514857` | Live preview iframe and tracker message handler.                                    |
| `player-frame`               | `VL`            | `5653:22104-5653:23413`   | `2515230-2516539` | Replay iframe rendering `BrowserPage`.                                              |
| `IDEBrowser`                 | `d1`            | `5653:27551-5653:32326`   | `2520677-2525452` | Browser widget/model.                                                               |
| `browser-widget`             | `GL`            | `5653:32507-5653:50647`   | `2525633-2543773` | Browser UI and request routing.                                                     |
| `editor-widget`              | `QL`            | `5653:52509-5653:65135`   | `2545635-2558261` | Monaco editor UI, scroll capture, file/view syncing.                                |
| `IDEEditor`                  | `O2e`           | `5653:65322-5653:68181`   | `2558448-2561307` | Editor wrapper.                                                                     |
| `pointer-wave`               | `rM`            | `5653:89481-5653:90172`   | `2582607-2583298` | Pointer click/wave feedback.                                                        |
| `ide-pointer-widget`         | `sM`            | `5653:90262-5653:97681`   | `2583388-2590807` | Replayed pointer cursor renderer and animation.                                     |
| `IDEPointer`                 | `npe`           | `5653:97770-5653:98080`   | `2590896-2591206` | Pointer widget state.                                                               |
| `BaseTimeline`               | `hh`            | `5655:23143-5655:28095`   | `2659641-2664593` | Timeline base.                                                                      |
| `ClipTimeline`               | `zme`           | `5655:28430-5655:30775`   | `2664928-2667273` | Clip/audio timeline.                                                                |
| `IDEConsole`                 | `yv`            | `5655:61075-5655:63507`   | `2697573-2700005` | Console panel/log UI.                                                               |
| `pointer-tracker`            | `ZM`            | `5655:76081-5655:80641`   | `2712579-2717139` | Pointer/browser event capture and `IDEPointerUpdateAction` producer.                |
| `scrim-commit-marker`        | `LI`            | `5655:121373-5655:122058` | `2757871-2758556` | Commit timeline marker UI.                                                          |
| `ScrimCommit` marker adapter | `P0e`           | `5655:122782-5655:123265` | `2759280-2759763` | `opΞownΞmarker` adapter for commit model.                                           |
| `ide-commit-dialog`          | `nS`            | `5655:175303-5655:178158` | `2809801-2812656` | Commit dialog UI and submit/cancel wiring.                                          |
| `IDEBranchTimeline`          | `yD`            | `5655:183705-5655:194559` | `2820203-2831057` | Branch timeline UI.                                                                 |
| `PointerFrame`               | `ID`            | `5655:208466-5655:209000` | `2844964-2845498` | Pointer timeline/frame renderer.                                                    |
| `SIAIChat.create_scribble`   | `ka`            | `462:3183-462:3883`       | `991000-991700`   | AI chat path creates/awaits a scribble branch before focused input.                 |
| `scrim-view.sync/open`       | n/a             | `5659:23038-5659:26038`   | `2917200-2920200` | Route synchronization, branch loading, solution-branch open/create behavior.        |
| `scrim-view` runtime handler | n/a             | `5659:28657-5659:30580`   | `2922819-2924742` | `/__sw__tracker.js`, `getState`, `request`, `resolveFile` handling.                 |

## Key Classes Already Summarized

### App/Content Bundle

Researched enough for a high-level summary:

- `Scrim`
- `ScrimStream`
- `ScrimSnapshot`
- `ScrimRec`
- `ScrimCommit`
- `ScrimClip`
- `ScrimPractice`
- `ScrimPreview`
- `ScrimAudio`
- `ScrimAudioTrack`
- `OPDataStream`
- `OPByteStream`
- `OPBufferChunks`
- `OPBinaryChunk`
- `OPBinaryChunkRequest`
- `HostFSEntry`
- `HostFile`
- `HostDir`
- `HostFSRoot`
- `HostWorkspace`
- `LocalWorkspace`
- `WCWorkspace`
- `Caption`
- `Captions`
- `ScrimArchiver`
- `ViteScrimArchiver`
- `WebpackScrimArchiver`
- `WSPScrimArchiver`
- `AppIDE`

### IDE/Runtime Bundle

Researched enough for a high-level summary:

- `IDEStream`
- `IDEStreamAction`
- `IDEStreamCursor`
- `IDEBranch`
- `IDETrunk`
- `IDESolutionBranch`
- `IDEBranchTimeline`
- `BaseTimeline`
- `ClipTimeline`
- `TextModel`
- `IDEEditor`
- `editor-widget`
- `IDEFile`
- `IDEFS`
- `IDEBrowser`
- `BrowserPage`
- `IDEBrowserHistory`
- `ServiceWorkerFrame`
- `ide-sw-container`
- `runner-frame`
- `player-frame`
- `browser-widget`
- `IDEConsole`
- `IDEPointer`
- `pointer-wave`
- `ide-pointer-widget`
- `pointer-tracker`
- `SIObject`
- `SIFSEntry`
- `SIFile`
- `SIDir`
- `SIWorkspace`
- `SIFS`
- `SIBrowser`
- `SIWebContainer`
- `SIWebContainerPort`
- `SIRunner`
- `SITerminal`
- `SIWebConsole`

Action classes directly inspected:

- `TextEditAction`
- `TextInsertAction`
- `TextDeleteAction`
- `TextSelectionAction`
- `TextScrollAction`
- `ViewOpenAction`
- `ViewCloseAction`
- `FSMoveAction`
- `DOMMutateAction`
- `PageLoadAction`
- `PageLogAction`
- `SnapshotAction`
- `KeyframeAction`
- `SaveAction`
- `MarkerAction`
- `RecStartAction`
- `RecStopAction`
- `IDEPointerUpdateAction`
- `PointerUpdateGroup`
- `AudioRecording`
- `MediaStreamAction`
- `MediaStreamStartAction`
- `MediaStreamEndAction`
- `IDEOPSnapshotAction`
- `IDEOPDeltaAction`
- `ForkAction`
- `BranchAction`
- `SeedAction`
- `TrimActionAction`
- `SIRollbackAction`

## Commands Used

These commands are safe to rerun from the repo root.

### Inventory

```bash
rg --files tmp
find tmp -maxdepth 3 -type f -print0 | xargs -0 du -h | sort -hr
wc -l tmp/*.js tmp/chunks/*.js tmp/*.css
```

### Keyword Search

Do not run broad `rg` without output limits on these bundles; many files are minified into extremely long lines.

```bash
rg -n "Scrimba|scrimba|scrim|Scrim|record|playback|timeline|browser|workspace|WebContainer|monaco|postMessage" tmp -S
```

### Extract Bundle Metadata

```bash
python3 - <<'PY'
import re, pathlib
for path in pathlib.Path('tmp').glob('**/*.js'):
    text = path.read_text(errors='ignore')
    imports = re.findall(r'import[^;]+;', text[:20000], re.S)
    elems = re.findall(r'\bge\("([^"]+)"\s*,', text)
    globals_ = re.findall(r'globalThis\.([A-Za-z_$][\w$]*)', text)
    print(f"\n### {path} ({len(text):,} chars)")
    print("imports:", len(imports))
    print("custom-elements:", len(elems), sorted(set(elems))[:120])
    print("globalThis:", sorted(set(globals_))[:120])
PY
```

### Extract Focused Runtime Names

```bash
python3 - <<'PY'
import re, pathlib
for path in [pathlib.Path('tmp/chunks/ide.36BDFLCO.js'), pathlib.Path('tmp/app.UK3DL7B2.js')]:
    text = path.read_text(errors='ignore')
    names = sorted(set(re.findall(r'globalThis\.([A-Za-z_$][\w$]*)', text)))
    focus = [n for n in names if re.search(r'Scrim|IDE|Timeline|Action|Browser|Stream|Branch|Clip|Widget|Page|Console|FS|Slide|Audio|AI|Agent|Workspace|Runner|Recorder|Pointer|DOM|Layout', n)]
    print(f"\n### {path}: {len(focus)} focused globals")
    for n in focus:
        print(n)
PY
```

### Extract Action Opcode Table

```bash
python3 - <<'PY'
from pathlib import Path
text = Path('tmp/chunks/ide.36BDFLCO.js').read_text(errors='ignore')
idx = text.find('me.SET=1;')
print('offset', idx)
print(text[idx:idx+1700])
PY
```

### Inspect Key Class Segments

This script extracts method names and selected strings for registered classes. Add class names to `classes` as needed.

```bash
python3 - <<'PY'
import re, pathlib
classes = ['IDEStreamAction','IDEStreamCursor','BrowserPage','SIWebContainer','Scrim','ScrimStream']
files = [pathlib.Path('tmp/app.UK3DL7B2.js'), pathlib.Path('tmp/chunks/ide.36BDFLCO.js')]
reg_cache = {}
for path in files:
    text = path.read_text(errors='ignore')
    for m in re.finditer(r'\b[HA]\(([A-Za-z_$][\w$]*)\s*,[^;]{0,120}?"([A-Za-z0-9_.$ -]+)"\s*,\s*\d+\)', text):
        reg_cache.setdefault(m.group(2), []).append((path, text, m.group(1), m.start()))

def find_class_segment(text, ident, regpos):
    starts = list(re.finditer(r'(?:var|let|const)\s+' + re.escape(ident) + r'\s*=\s*class\b', text[:regpos]))
    if not starts:
        starts = list(re.finditer(r'\b' + re.escape(ident) + r'\s*=\s*class\b', text[:regpos]))
    if not starts:
        return None
    st = starts[-1].start()
    class_kw = text.find('class', st)
    brace = text.find('{', class_kw)
    depth = 0
    i = brace
    in_s = None
    esc = False
    while i < len(text):
        ch = text[i]
        if in_s:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == in_s:
                in_s = None
        else:
            if ch in ('"', "'", '`'):
                in_s = ch
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    return text[st:i+1]
        i += 1
    return text[st:regpos]

for cls in classes:
    entries = reg_cache.get(cls, [])
    if not entries:
        print('missing', cls)
        continue
    path, text, ident, pos = entries[0]
    seg = find_class_segment(text, ident, pos)
    print(f"\n### {cls} [{path.name}] ident={ident} chars={len(seg) if seg else 0}")
    if seg:
        methods = []
        for m in re.finditer(r'(?:^|[{};])\s*(async\s+)?(?:(get|set)\s+)?([A-Za-z_$][\w$ΞΦα]+)\s*\(', seg):
            name = ((m.group(1) or '') + (m.group(2) + ' ' if m.group(2) else '') + m.group(3)).strip()
            if name not in methods:
                methods.append(name)
        print(', '.join(methods[:120]))
PY
```

## Next Recommended Tasks

1. Continue stream persistence:
   - Server-side `load_from_prod` behavior remains unavailable in this local client bundle; only the RPC action declaration and call site are visible.
   - Look for any client-visible backend route declarations for `/legacy/files/` and `/op/stream/` in other artifacts if they become available.
   - `ScrimRec.byte_offset` is defined as a numeric field, but no client assignment was found beyond the model definition; continue only if another bundle/server artifact is available.

2. Trace capture paths:
   - Deeply inspect the external tracker bundle if it becomes available; the local bundle references `/assets/tracker.4FYFXZYK.iife.js` but the file is not present under `tmp/` or elsewhere in this repo.
   - `LCSCROLL` has no producer in the local artifacts outside the enum/action-class references; only another bundle revision or source artifact can determine whether it is legacy-only.
   - `MSR_CHUNK` has no producer in the local artifacts; only another bundle revision, tracker artifact, or server/source artifact can determine whether it is legacy/reserved.
   - Pointer rendering is traced at the client-architecture level; only CSS/visual polish details remain if needed.

3. Trace branch semantics:
   - Trace any server-side meaning exposed by `COMMIT=220`; no registered `CommitAction` class was found in this pass, and visible commit UI uses `ScrimCommit` content records/markers.
   - Client-side route/path behavior for nested scribbles and exercise solutions is now traced. Only server-side route resolution or persisted URL migration behavior remains unknown.

4. Deepen workspace host/provider sync:
   - Trace host-side implementations of `LocalWorkspace.merge`, `WCWorkspace.merge`, `WCWorkspace.install`, `WCWorkspace.webfetch`, and `WCWorkspace.serializeDir` if a host/bootstrap artifact becomes available.
   - Trace how WebContainer bridge messages implement the RPC-facing `WCWorkspace` actions inside the missing bootstrap asset; the visible client class bodies declare these as RPC actions with `callback=false`.
   - The visible host save path after `HostWorkspace.$changed` is now traced to inherited OP store diff persistence and `OPStorePush`; server-side handling of that push is not present locally.

5. Trace runtime request routing:
   - Locate or reconstruct the standalone `/__sw__.html`, `/__sw__blank.html`, and `/__sw__tracker.js` artifacts if they exist outside the inspected bundle; they are not present as standalone artifact files under `tmp/` or elsewhere in this repo.
   - Locate or reconstruct `/assets/webcontainer.RMFWBHQ3.mjs?file`; the client bridge around `.bootstrap.mjs`, reserved port `8123`, and OP-packed `ArrayBuffer` messages is traced, but bootstrap-side RPC implementations are missing.
   - Trace external tracker bundle behavior if `/assets/tracker.4FYFXZYK.iife.js` becomes available.

6. Product architecture follow-up:
   - Decide whether Next Editor should pursue Scrimba-compatible reversible action streams or keep its existing frame/delta recording artifact model.
   - If pursuing parity, map Scrimba `LC*`, DOM/page, pointer, media, and `OPSNAPSHOT`/`OPDELTA` concepts to concrete Next Editor modules.
   - If keeping the current model, document which Scrimba capabilities are intentionally out of scope or need separate abstractions.

## Notes For Future Agents

- Prefer targeted regex extraction over direct `rg` line output; the minified bundles have very long lines and can flood context.
- Use character offsets when line numbers are unhelpful.
- Add exact source spans to `Completed Evidence Ranges` before marking new areas done.
- Preserve "confirmed" vs "inferred" distinctions.
- Keep adding to these docs as research progresses.
- If creating de-minified extracts, store only small targeted snippets or summaries to avoid committing massive generated files.
