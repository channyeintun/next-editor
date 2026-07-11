# Local Screen Recording Alongside Session Recording — Plan

Status: **proposed** (2026-07-11). Not implemented. This document is the design + implementation guide.

## 1. Goal & scope

Add an opt-in recording setting: when enabled, starting a session recording **also screen-records the browser (via `getDisplayMedia` + `MediaRecorder`) in parallel**, and on stop hands the user a plain video file saved **locally only**.

**Why.** The `.ne` format replays editor/preview/whiteboard _state_, not pixels. Exporting an existing recording to video would require pixel-true re-rendering of Monaco + the runtime-preview iframe + Excalidraw in perfect sync with audio — i.e. a headless render farm, or realtime canvas re-capture of a replay (cross-origin iframe taint, font/layout drift), or frame-by-frame WebCodecs composition. All are large, fragile projects. Capturing real pixels _at record time_ costs almost nothing and is pixel-true by construction. The video is a keep-forever local artifact the user can edit/reuse elsewhere.

**v1 scope**

- A persisted "Record screen" setting (default **off**), surfaced as a pill in the record-mode controls next to the existing Camera pill.
- On record start (setting on): browser surface picker → screen capture runs for the whole session, with narration audio muxed in so the file is standalone.
- On record stop (or the user clicking the browser's native "Stop sharing"): the video is finalized and saved to the user's disk as a download.
- All failures are **non-fatal to the session recording** (same philosophy as `handleCameraError`).

**Non-goals / hard exclusions (v1 and by design)**

- **Never uploaded, never published to tube.** The video bytes must not touch the `Recording` type, the `.ne` codec, `IndexedDBRecordingStore`, `exportAsFile`, or any publish/upload path. See §7 guardrails.
- No export-to-video of _existing_ recordings (that's the problem this sidesteps).
- No in-app video preview/player for the captured file, no trimming/editing.
- No region cropping of the capture (Chromium-only Region/Element Capture — follow-up, §12).
- Mobile: hidden (no `getDisplayMedia` on mobile browsers; also see the mobile-OOM constraint on `/`).

## 2. Browser API knowledge (what the implementation must respect)

### 2.1 `navigator.mediaDevices.getDisplayMedia()`

- **Secure context** required (localhost/https — fine for us).
- **Requires transient user activation, and consumes it.** This is the load-bearing constraint of the whole design. In Chromium, transient activation also _expires_ (~5 s). Our record-start flow (`START_RECORDING` → `armingRecording` → `getUserMedia` for mic → `STARTED` → `recording` state) has an async gap, so calling `getDisplayMedia` from an actor spawned at `recording`-state entry is a race against the activation window — and would also record the surface-picker dialog into the first seconds of video. **Therefore: acquire the display stream directly in the record-button click handler, as the first `await`, before sending `START_RECORDING`** (§4 step ①). The stream rides into the machine on the event (non-serializable values already flow through this machine: blobs, `MediaRecorder`, editor refs).
- Useful Chromium-only options (pass unconditionally; other browsers ignore unknown members):
  - `preferCurrentTab: true` (Chromium 94+) — picker prioritizes the current tab, which is what a presenter recording this editor wants ~always.
  - `selfBrowserSurface: "include"` (107+) — make sure the current tab is offered.
  - `surfaceSwitching: "include"` (107+) — lets the user retarget the share mid-recording via the browser pill.
  - `systemAudio: "exclude"` (105+) — we mix mic ourselves; system audio invites echo/noise.
  - `video: { frameRate: { ideal: 30, max: 30 } }` — screencast content doesn't need more; halves encoder load vs 60.
  - `audio: true` — when the user shares a _tab_, Chromium offers "Also share tab audio"; that track captures sounds the app itself plays (runtime preview audio, external-audio narration §5). Firefox/Safari return no audio track — handle absence.
- `CaptureController` + `setFocusBehavior("no-focus-change")` (Chromium 109+) — prevents focus jumping to the picked surface at share start; wrap in `try/catch` + feature-detect.
- The user can end the share at any time via browser UI: listen for `"ended"` on the video track and treat it as an early, _partial-but-valid_ stop (§4 step ⑤).
- Support matrix: Chromium desktop full; Firefox desktop window/screen picker only (no current-tab hints, **no audio** from gDM); Safari desktop 13+ window/screen (no audio, strict gesture rules); mobile effectively none. Gate the UI on `typeof navigator.mediaDevices?.getDisplayMedia === "function"` — this also auto-hides it inside iframes lacking the `display-capture` permissions-policy (e.g. if the landing-page demo embed ever ran record mode).

### 2.2 `MediaRecorder` for the video file

- MIME probe order, first `isTypeSupported` wins:
  1. `video/webm;codecs=vp9,opus`
  2. `video/webm;codecs=vp8,opus`
  3. `video/webm`
  4. `video/mp4` (Safari's native path; Chromium ≥126 can also mux MP4 — exact codec strings vary by platform, so probe, don't hardcode)

  This is `cameraActor.ts`'s `getSupportedVideoMimeType` plus audio codecs — extract a shared util (§8 P0) instead of a third copy.

- **Known WebM caveat** (worth writing down because the whole point is "use the file later"): MediaRecorder WebM output has **no duration header** (Chromium issue 642012). Players show `Infinity`/unknown duration until a full scan; most editors cope, some grumble. Options: (a) ship as-is and document; (b) post-process with the small `fix-webm-duration`-style Cues/Duration patch; (c) prefer MP4 where supported. **v1 decision: (a)**, with (b) as a cheap follow-up — settle by a 5-minute manual check in the target editors during implementation.
- Bitrates: `videoBitsPerSecond: 2_500_000` (VP9 screencast at 1080p is comfortably transparent at 2.5 Mbps — low-motion text content), `audioBitsPerSecond: 128_000` (this is the keep-forever file; don't reuse the session's 32 kbps telephony budget).
- `start(1000)` timeslice like the audio/camera actors — chunks accumulate in a `Blob[]`; final blob assembled on stop. Memory math: ~2.6 Mbps ≈ **1.2 GB/hour**. Chromium's blob storage pages large blobs to disk, so hour-long sessions survive, but this is the weakest point of v1 — OPFS streaming is the designated hardening follow-up (§12), _not_ v1 complexity.
- Don't constrain capture width/height: downscaling screen text destroys readability; capture at native surface size and let bitrate do the work.

### 2.3 Muxing narration audio (Web Audio)

A silent screen video is near-useless "later". Mux narration in:

- **Mic mode** (the common case): at screen-actor spawn time the mic is already live — `STARTED` carries the mic `MediaRecorder` ([audioActor.ts:68-75](src/core/src/machine/audioActor.ts)) and `storeAudioStarted` puts it on `context.audio.mediaRecorder` ([captureActions.ts:791-802](src/core/src/machine/captureActions.ts)). **`clone()` an audio track** from `mediaRecorder.stream` — no second `getUserMedia`, no second permission, zero coupling change. Stopping the clone never stops the original (but the cleanup must stop _the clone_, or the mic indicator stays on after the session's own recorder finishes).
- **Display audio** (tab share): if gDM returned an audio track, mix it in too — it carries app-emitted sound, including external-audio narration played through `recordingAudioPlayer` (§5).
- Mixer: `AudioContext` → one `MediaStreamAudioSourceNode` per available track → `MediaStreamAudioDestinationNode`; record `new MediaStream([displayVideoTrack, destination.stream.getAudioTracks()[0]])`. ~15 lines. If _no_ audio source exists (Firefox + external-audio mode), record video-only — still useful.
- Keep the mixer a pure, injectable function (`buildScreenCaptureStream(display, micTrack, { audioContextCtor })`) so jsdom tests don't need a real `AudioContext`.
- Close the `AudioContext` and stop all constituent tracks in cleanup.

## 3. Architecture: same shape as the camera track, minus the publish half

The camera pipeline is the proven template — conditional spawn of a `fromCallback` recorder actor, `*_STARTED/_STOPPED/_ERROR` events, non-fatal errors ([cameraActor.ts](src/core/src/machine/cameraActor.ts), spawn at [editorMachine.ts:359-378](src/core/src/machine/editorMachine.ts:359)). The screen track copies that shape but **stops before persistence**: instead of `finalizeRecording` folding it into the `Recording`, the blob exits through a machine input callback and the app layer saves it to disk.

```
click Record (setting on)
  └▶ MediaControls: await getDisplayMedia(...)   ← transient activation, first await
       └▶ startRecording({ ..., screenStream })  ← stream rides the event
            └▶ machine idle ──START_RECORDING──▶ armingRecording (mic getUserMedia)
                 └▶ STARTED ──▶ recording entry:
                      spawn screenRecording actor
                        input: { stream: context.screenStream,
                                 micTrack: clone of context.audio.mediaRecorder.stream }
                      actor: mix audio (§2.3) → MediaRecorder.start(1000)
                        └▶ SCREEN_STARTED { mimeType, startedAtPerf }
...session records normally; screen recorder runs in parallel...
stop (either: STOP_RECORDING → stoppingRecording sends STOP to screen actor,
      or: user clicks browser "Stop sharing" → video track "ended" → actor self-stops)
  └▶ SCREEN_STOPPED { blob }   ← handled at machine ROOT, any state
       └▶ input.onScreenRecordingReady({ blob, mimeType, startOffsetMs })
            └▶ app layer: saveScreenRecordingLocally() → anchor download
       └▶ stopChild("screenRecorder"), clear context.screenStream
```

Key structural decisions, with reasons:

- **Machine-owned actor, not a MediaControls-local recorder.** Recording can stop without a user click (external audio `FINISHED` auto-stop, `ERROR` paths); only the machine sees all of them. Also per repo convention: reuse the xstate machinery, no parallel CustomEvent/localStorage plumbing.
- **`SCREEN_STOPPED` is a root-level `on` handler, NOT part of the `stoppingRecording` join.** The `stoppingRecording` state's STOPPED/CAMERA_STOPPED guard matrix + 2 s `after` fallback ([editorMachine.ts:478-524](src/core/src/machine/editorMachine.ts:478)) is the most delicate logic in the machine. The screen blob is not part of the `Recording`, so `finalizeRecording` has **nothing to wait for** — the machine can move to `loading`/`playback` while the screen blob finishes assembling and the root handler saves it whenever it lands. Zero changes to the join guards.
- Consequence: **do NOT add `screenRecorder` to `stoppingRecording`'s `exit: [stopChild(...)]`** ([editorMachine.ts:489](src/core/src/machine/editorMachine.ts:489)) — that would dispose the actor before `onstop` assembles the blob (the `disposed` flag suppresses `sendBack`, silently losing the file). The root `SCREEN_STOPPED` handler does the `stopChild` after the blob is out.
- **Abort paths must release the pre-acquired stream.** Because gDM happens at click time, the display stream exists even if recording never starts. Every path from `armingRecording` back to `idle` (mic `ERROR`, early `STOP_RECORDING`) plus the machine's final cleanup must stop `context.screenStream`'s tracks — otherwise the browser's "sharing this tab" indicator leaks forever.

## 4. End-to-end flow detail

① **Click handler** ([MediaControls.tsx:295-323](src/components/MediaControls.tsx:295), becomes async): if the setting is on and gDM is supported, call `getDisplayMedia` as the **first await**, wrapped in try/catch. `NotAllowedError` (user cancelled the picker) ⇒ proceed with the session recording _without_ screen capture (`console.warn` + the pill flashes off for this take). The session recording is the primary artifact; a dismissed dialog must not abort it.

② **Event plumbing**: `startRecording(options)` gains `screenStream?: MediaStream` — through [NextEditorContext.ts:21](src/contexts/NextEditorContext.ts), [useNextEditor.ts:113](src/core/src/useNextEditor.ts), `StartRecordingEvent` ([types.ts:340-345](src/core/src/machine/types.ts:340)). A new assign (`setScreenStream`, next to `setCameraRecordingEnabled` [captureActions.ts:49-60](src/core/src/machine/captureActions.ts:49)) stores it on context.

③ **Spawn** at `recording` entry (same `enqueueActions` block as camera, guard `context.screenStream != null`): input is the stream plus a cloned mic track from `context.audio.mediaRecorder?.stream` (present by now in mic mode; absent in external-audio mode — fine, §2.3). Actor emits `SCREEN_STARTED { mimeType, startedAtMs, startedAtPerf }`; a `storeScreenStarted` action computes `startOffsetMs = startedAtPerf - session.startedAtPerf` exactly like [storeCameraStarted](src/core/src/machine/captureActions.ts:852) — monotonic clock both sides (this repo has been burned by `Date.now()` timelines twice; keep the rule).

④ **During recording**: nothing else changes. The browser shows its own capture indicator; no in-app duplication needed in v1.

⑤ **Stop**:

- Normal: `stoppingRecording` entry additionally does `sendTo("screenRecorder", { type: "STOP" })` when active (mirroring the camera line at [editorMachine.ts:484-486](src/core/src/machine/editorMachine.ts:484)).
- Early ("Stop sharing" browser UI): the actor's `"ended"` listener stops its own MediaRecorder → `SCREEN_STOPPED` with the partial file. **Session recording continues**; the user just gets a shorter video.

⑥ **Save** (root `SCREEN_STOPPED` handler → `input.onScreenRecordingReady`): app layer (wired where `onRecordingStop` already is) calls a new `saveScreenRecordingLocally({ blob, mimeType })` in `src/storage/` — filename `screen-recording-YYYYMMDD-HHmmss.<ext>` (extension from MIME, same mapping `cameraExtensionFromMime` uses), anchor-download exactly like `RecordingStorage.downloadBlob` ([RecordingStorage.ts:373-378](src/storage/RecordingStorage.ts:373) — it's private; extract or copy the 6 lines). Auto-download on stop, no picker, no prompt: the user opted in via the setting, and a download is cancelable/deletable. `showSaveFilePicker` streaming is the v2 path (§12).

`SCREEN_ERROR` (any time): `console.warn`, release tracks, clear context — session recording unaffected (mirror of `handleCameraError`).

## 5. External-audio mode

When narration comes from an audio file (`recordingAudioSource === "external"`), there is no mic recorder to clone from. But the file is _played aloud_ through `recordingAudioPlayer`, so **if the user shared the current tab with "share tab audio"**, the gDM audio track captures the narration anyway — the mixer just uses whatever sources exist. Firefox/Safari or a window/screen share yield a silent video in this mode; acceptable v1, documented in the pill's title text ("includes mic/tab audio when available").

## 6. Setting persistence & UI (UX spec)

**Store** — new `src/stores/recordingSettingsStore.ts`, a straight clone of the [playbackSettingsStore.ts](src/stores/playbackSettingsStore.ts) pattern: `createStore` from `@xstate/store-react`, `{ screenRecordingEnabled: boolean }`, localStorage key `recording-screen-capture`, subscribe-to-persist, module-level singleton, selector export. (The camera toggle today is ephemeral `useState` [MediaControls.tsx:161](src/components/MediaControls.tsx:161); migrating it into this store is an optional, separate cleanup — do not bundle it.)

**UI** — one new pill in the record-mode row, right of the Camera pill ([MediaControls.tsx:450-470](src/components/MediaControls.tsx:450)), same classes/size, `Monitor`/`MonitorOff` lucide icons, `aria-pressed`, label "Screen" (`hidden sm:inline` like Camera).

- Visible only when `recordMode && !isRecording && !currentRecording && !isPlaying` (the existing `showAudioSourceControls` row) **and** gDM is supported **and** not `isMobileBrowser()`.
- On = persisted; survives reloads (it's a _setting_, unlike the per-take camera toggle — that asymmetry is intentional: camera is a per-take editorial choice, screen capture is a workflow preference).
- Title text states the contract: on → "Also screen-record (saved locally only, never uploaded)"; off → "Do not screen-record".
- No preview overlay, no extra chrome while recording (browser's own share pill covers "is it on?").
- Deliberately left out: surface pre-selection UI, quality knobs, format pickers — the browser picker and sane defaults carry v1.
- Per repo rules: plain handler functions, no `useCallback` (React Compiler).

## 7. Publish-safety guardrails

The user-visible promise is "local only". Enforce it structurally, not by convention:

1. The blob's only exit is `onScreenRecordingReady` → `saveScreenRecordingLocally`. No `screen*` field is added to `Recording`, the `.ne` streaming codec, `IndexedDBRecordingStore` entries, `exportAsFile`, or any tube upload payload type.
2. `context.screen`/`screenStream` slices are cleared on save/error/abort — nothing for a later `finalizeRecording` to accidentally sweep up.
3. Test asserts `finalizeRecording` output contains no screen fields when a screen recording ran (§10).
4. Greppable invariant for reviewers: `rg screenStream src/storage src/core/src/machine/captureActions.ts` should hit only the save util and the two assigns described here.

## 8. Implementation steps (atomic, with parallelization)

**P0 (independent):** extract `getSupportedVideoMimeType` from [cameraActor.ts:16-30](src/core/src/machine/cameraActor.ts:16) into `src/core/src/utils/videoMimeType.ts` (sibling of `audioMimeType.ts`), parameterized by a probe list; camera keeps its list, screen adds the `,opus` variants. Pure refactor + unit test.

**P1 (independent):** `recordingSettingsStore.ts` + test (mirror `playbackSettingsStore.test.ts`).

**P2 (independent):** types — context slice (`screenStream: MediaStream | null`, `screen: { isRecording, mimeType, startOffsetMs }`), `StartRecordingEvent.screenStream?`, `SCREEN_STARTED/STOPPED/ERROR` events, `EditorMachineInput.onScreenRecordingReady?`, `createInitialContext` defaults.

**P3 (after P0+P2):** `screenActor.ts` — cameraActor shape + input stream (not self-acquired) + mixer (§2.3, injectable) + `"ended"` self-stop + cleanup (recorder, clone track, AudioContext; never the caller's stream on normal stop-path — decide ownership: actor owns and stops all tracks of its input stream on teardown, callers must pass clones if they need survivors; document in the file). Unit tests with mocked MediaRecorder/streams.

**P4 (after P3):** machine wiring — `setScreenStream` assign on `START_RECORDING`; conditional spawn + mic-clone at `recording` entry; `sendTo STOP` in `stoppingRecording` entry; root `SCREEN_STOPPED`/`SCREEN_ERROR` handlers (emit callback, `stopChild`, clear context); `releaseScreenStream` on `armingRecording→idle` paths and machine cleanup. **Do not touch the STOPPED/CAMERA_STOPPED join guards or the exit stopChild list.**

**P5 (after P2, parallel with P3/P4):** plumbing — `useNextEditor.startRecording` option, `NextEditorContext` type, provider passes `onScreenRecordingReady`; `saveScreenRecordingLocally` util in `src/storage/`.

**P6 (after P4+P5):** MediaControls — pill (§6), async click handler with first-await gDM + cancel fallback (§4 ①).

**P7:** validation — `bun run typecheck`, `bun run check`, `npx vp test run` (never bare vitest). No browser verification by the agent (repo rule); the user eyeballs: record with setting on → picker → record ~30 s with mic → stop → downloaded file plays with audio in QuickTime/VLC + imports into an editor; repeat with "Stop sharing" mid-take; repeat with picker cancelled.

Notes for the implementing session: subtasks P0/P1/P2 are independent and parallelizable; if run as parallel agents, **serialize the commits** (known pre-commit stash/pop collision) or use worktrees.

## 9. New/changed surface summary

| File                                                                 | Change                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/core/src/utils/videoMimeType.ts`                                | new (P0 extraction)                                                                     |
| `src/stores/recordingSettingsStore.ts`                               | new store + persistence                                                                 |
| `src/core/src/machine/types.ts`                                      | context slice, event types, input callback                                              |
| `src/core/src/machine/screenActor.ts`                                | new recorder actor + audio mixer                                                        |
| `src/core/src/machine/captureActions.ts`                             | `setScreenStream`, `storeScreenStarted`, `handleScreenError`, `releaseScreenStream`     |
| `src/core/src/machine/editorMachine.ts`                              | spawn at `recording` entry, STOP at `stoppingRecording` entry, root SCREEN\_\* handlers |
| `src/core/src/useNextEditor.ts`, `src/contexts/NextEditorContext.ts` | `screenStream` option pass-through                                                      |
| `src/contexts/NextEditorProvider.tsx` / `src/components/Editor.tsx`  | wire `onScreenRecordingReady` → save util                                               |
| `src/storage/screenRecordingSave.ts`                                 | new: filename + anchor download                                                         |
| `src/components/MediaControls.tsx`                                   | Screen pill + async record click handler                                                |

## 10. Testing plan

Machine-level (extend `editorMachine.test.ts`, reusing its MediaRecorder/getUserMedia mocks; add a `getDisplayMedia`-shaped fake `MediaStream` with stub tracks):

- no `screenStream` on the event ⇒ no screen actor spawned (default path untouched).
- with `screenStream` ⇒ actor spawned at `recording` entry; `SCREEN_STARTED` sets `startOffsetMs` from perf clocks.
- `STOP_RECORDING` ⇒ screen actor receives STOP; `SCREEN_STOPPED` arriving _after_ the machine reached `loading`/`playback` still fires `onScreenRecordingReady` and clears context.
- track `"ended"` mid-recording ⇒ blob delivered early, machine stays in `recording`, session unaffected.
- mic `ERROR` in `armingRecording` with a pending `screenStream` ⇒ tracks stopped (spy on `track.stop`).
- `SCREEN_ERROR` ⇒ non-fatal, context cleared.
- **guardrail:** `finalizeRecording` output has no screen fields.

Unit: mime probe order; mixer source selection (mic only / mic+display / display only / none) with injected fake AudioContext; save util filename/extension mapping.

## 11. Decisions made (defaults chosen, revisit only with cause)

- Picker cancelled ⇒ record session anyway, without video (non-fatal beats aborting the take).
- Container: WebM-first probe list; MP4 only where WebM unsupported. Duration-header caveat accepted for v1 (§2.2) — verify in target editors during P7 and promote the duration patch if they choke.
- Save UX: automatic download on stop, no file picker.
- Setting is per-browser localStorage, default off; camera toggle stays ephemeral (separate concern).
- Actor owns and stops every track of its input stream on teardown; the machine passes the display stream (actor-owned) and a mic _clone_ (so the session mic is never killed).

## 12. Follow-ups (explicitly not v1)

- **OPFS streaming sink** — stream 1 s chunks to the Origin Private File System during recording, copy out on stop: crash recovery + flat memory for multi-hour takes.
- `showSaveFilePicker` + `FileSystemWritableFileStream` — user picks destination once at record start; needs Chromium; folds into the OPFS work.
- **WebM duration patch** (§2.2) if editors complain.
- **Region/Element Capture** (Chromium `CropTarget`/`RestrictionTarget`) — crop the recording controls out of the video when self-capturing the current tab.
- Sync sidecar: emit `startOffsetMs`/session id as a tiny `.json` next to the video so a user could later align the local video against a published lesson's audio track.
- Migrate the camera per-take toggle into `recordingSettingsStore` if product wants it persisted too.
