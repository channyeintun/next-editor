# Camera (Instructor Face) Recording & Replay — Implementation Plan

## 1. Feasibility verdict

**Yes — feasible, and additive without breaking the existing record/replay architecture.**

Camera capture is structurally identical to the audio feature that already ships: a
`MediaRecorder` driven by a spawned XState child actor, a `Blob` stored on the `Recording`,
serialized as its own append-only SCR3 segment, and replayed by a small overlay component that
follows the playback timeline (exactly like the existing fake-cursor overlay).

Every change is **gated behind an opt-in flag** and a **new, optional `cameraBlob`** field. When
the flag is off (default) or a recording has no camera track, behaviour is byte-for-byte
identical to today. Old recordings decode with `cameraBlob === undefined` and simply render no
camera. The audio pipeline is untouched (camera uses distinct event types, its own context slot,
its own segment kind, and a separate `MediaRecorder`).

The camera is the smallest analog of audio:

| Concern          | Audio (today)                                   | Camera (new, mirrors audio)                               |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------- |
| Capture actor    | `audioRecordingActor` (`machine/audioActor.ts`) | `cameraRecordingActor` (`machine/cameraActor.ts`)         |
| Machine context  | `context.audio` (`AudioState`)                  | `context.camera` (`CameraState`)                          |
| Live chunks      | `session.audioChunks: Blob[]`                   | `session.cameraChunks: Blob[]`                            |
| Final blob       | `recording.audioBlob`                           | `recording.cameraBlob`                                    |
| Serialization    | `SEGMENT_KIND.audioChunk` + `FLAG_HAS_AUDIO`    | `SEGMENT_KIND.cameraChunk` + `FLAG_HAS_CAMERA`            |
| Playback element | `audioPlaybackActor` (HTMLAudioElement)         | `CameraOverlay` React component (HTMLVideoElement)        |
| Sync             | `SYNC` every 250 ms from `TICK`                 | tick-driven `currentTime` drift correction (same cadence) |

---

## 2. Where this plugs into the current architecture

Recording flow (unchanged states, additive wiring):

```
idle ──START_RECORDING──▶ [startingRecording (audio only)] ──▶ recording ──▶ stoppingRecording ──▶ loading ──▶ playback
                                                                  │  ▲
                                          spawn cameraRecording ──┘  └── CAMERA_CHUNK / CAMERA_STOPPED
```

- The camera actor is spawned on **`recording`** entry (next to `mouseTracking`), **not** in the
  audio-gated `startingRecording` handshake. Camera readiness must never block frame capture or
  the audio-duration source-of-truth logic.
- On stop, the existing `stoppingRecording` state (which already waits for the final audio
  fragment with a 2 s safety timeout) is extended to also stop the camera recorder and collect
  its final blob. A **camera-only** recording (camera on, mic off) is routed through
  `stoppingRecording` too, via an added guard.

Playback flow (no machine playback states change):

- `CameraOverlay` mounts as a sibling of `CursorComponent` in `EditorLayout`
  (`src/components/Editor.tsx`). It reads `recording`/`isPlaying`/`timeline.currentTime` from the
  actor (same selectors the cursor uses) and drives a `<video>` element. Dragging and show/hide
  are pure viewer-side UI — no recording data needed.

---

## 3. Capture settings (size / resolution / bitrate)

Goal: a ~2in circle, "reasonable" not high resolution, small file footprint.

- **getUserMedia constraints** (video-only — see note):
  ```ts
  {
    video: {
      width:  { ideal: 480 },
      height: { ideal: 480 },
      frameRate: { ideal: 24, max: 30 },
      facingMode: "user",
    },
    audio: false,
  }
  ```
  A square-ish ~480×480 source looks crisp inside a 2in (~192 px @96dpi, ~384 px @2× DPR) circle
  after `object-fit: cover`. Drop to `320×320` if smaller files are preferred.
- **MediaRecorder**: `video/webm;codecs=vp9` → fallbacks `vp8`, `video/webm`, `video/mp4`.
  `videoBitsPerSecond: 400_000` (~3 MB/min). Timesliced at 1 s like audio so live chunks stream.
- **Audio note (avoid double audio):** record the camera **video-only**. Microphone audio is
  already captured and A/V-synced by the audio actor; giving the camera its own audio track would
  double the voice and complicate sync. The replay `<video>` is therefore `muted`.

---

## 4. Data-model changes

### 4.1 `Recording` (`src/core/src/types.ts`)

```ts
export type RecordingCameraSource = "camera";

export interface CameraPlaceholder {
  __camera_offset: number;
  __camera_size: number;
  __camera_type: string;
}

export interface Recording {
  // ...existing fields unchanged...
  cameraBlob?: Blob | CameraPlaceholder; // optional → fully backward compatible
  cameraSource?: RecordingCameraSource;
}
```

### 4.2 Machine context & session (`src/core/src/machine/types.ts`)

```ts
export interface CameraState {
  blob: Blob | null;
  isRecording: boolean;
  mimeType: string;
  source: RecordingCameraSource | null;
}

export interface EditorMachineContext {
  // ...
  camera: CameraState; // new
  enableCameraRecording: boolean; // new (mirrors enableAudioRecording)
}

export interface RecordingSession {
  // ...
  cameraChunks: Blob[]; // new, append-only (mirrors audioChunks)
}
```

- Initialize `camera: { blob: null, isRecording: false, mimeType: "", source: null }` and
  `enableCameraRecording: input.enableCameraRecording ?? false` in the context factory
  (alongside the existing `enableAudioRecording: input.enableAudioRecording ?? false`).
- Seed `cameraChunks: []` in `initRecordingSession`.

### 4.3 Machine events (`src/core/src/machine/types.ts`)

Add **distinct** event types so they never collide with the audio actor's
`STARTED`/`CHUNK`/`STOPPED`:

```ts
export type CameraActorStartedEvent = { type: "CAMERA_STARTED"; mimeType: string };
export type CameraChunkEvent = { type: "CAMERA_CHUNK"; chunk: Blob };
export type CameraActorStoppedEvent = { type: "CAMERA_STOPPED"; blob: Blob };
export type CameraActorErrorEvent = { type: "CAMERA_ERROR"; error: string };
```

Add them to the `EditorMachineEvent` union, and add `enableCamera?: boolean` to
`StartRecordingEvent`.

---

## 5. Recording pipeline

### 5.1 New actor `src/core/src/machine/cameraActor.ts`

Clone `audioRecordingActor` from `machine/audioActor.ts`, changing:

- `getSupportedVideoMimeType()` with the candidate list above.
- `getUserMedia` with the video constraints (audio: false).
- `MediaRecorder` with `videoBitsPerSecond`.
- Emit `CAMERA_STARTED` / `CAMERA_CHUNK` / `CAMERA_STOPPED` / `CAMERA_ERROR`.
- Same dispose/cleanup discipline (stop tracks, guard `disposed`).

There is **no** camera playback actor — the visible element lives in React (see §7).

### 5.2 `editorMachine.ts` wiring

1. **Register** the actor in `setup({ actors: { ..., cameraRecording: cameraRecordingActor } })`.
2. **Guards** (add):
   - `isCameraRecording: ({ context }) => context.enableCameraRecording && context.camera.isRecording`
   - Reuse to decide the stop route.
3. **`recording` state**:
   - Entry: conditionally spawn the camera actor and mark `camera.isRecording`:
     ```ts
     enqueueActions(({ context, enqueue }) => {
       if (!context.enableCameraRecording) return;
       enqueue.spawnChild("cameraRecording", {
         id: "cameraRecorder",
         input: {
           /* constraints */
         },
       });
       enqueue.sendTo("cameraRecorder", { type: "START" });
       enqueue.assign({ camera: { ...context.camera, isRecording: true, source: "camera" } });
     });
     ```
     (Append to the existing `entry` array; keep `mouseTracking` spawn intact.)
   - Exit: `stopChild("cameraRecorder")` (add to existing exit array).
   - `on`:
     - `CAMERA_STARTED`: `assign` mimeType.
     - `CAMERA_CHUNK`: `captureCameraChunk` (mirror `captureAudioChunk` → append to
       `session.cameraChunks`).
     - `CAMERA_STOPPED`: `storeCameraBlob` (mirror `storeAudioBlob` → set `context.camera.blob`).
     - `CAMERA_ERROR`: **log + clear `camera.isRecording`, do NOT change state** — a camera
       failure must never abort an in-progress frame/audio recording.
   - `STOP_RECORDING` guards (extend the existing ordered list so camera-only also drains):
     ```ts
     STOP_RECORDING: [
       { target: "stoppingRecording", guard: "isMicrophoneAudioRecording" },
       { target: "stoppingRecording", guard: "isCameraRecording" },          // NEW
       { target: "loading", guard: "isExternalAudioRecording", actions: [...] },
       { target: "loading", actions: ["finalizeRecording", "notifyRecordingStop"] },
     ]
     ```
4. **`stoppingRecording` state**:
   - Entry: also `enqueue.sendTo("cameraRecorder", { type: "STOP" })` (guard by `isCameraRecording`).
   - Exit: also `stopChild("cameraRecorder")`.
   - `on`:
     - `CAMERA_CHUNK`: `captureCameraChunk` (catch the final post-stop fragment, like audio).
     - `CAMERA_STOPPED`: `storeCameraBlob` (internal, no transition) so a late camera blob is
       captured before/after the audio `STOPPED` finalizes.
     - For the **camera-only** path (no microphone audio), add:
       ```ts
       CAMERA_STOPPED: {
         target: "loading",
         guard: ({ context }) => !context.audio.isRecording, // camera-only
         actions: ["storeCameraBlob", "finalizeRecording", "notifyRecordingStop"],
       }
       ```
   - The existing `after: { 2000: ... }` timeout already covers the case where a recorder never
     reports `STOPPED`.
5. **`finalizeRecording`**: add to the assembled `Recording`:
   ```ts
   cameraBlob: context.camera.blob || undefined,
   cameraSource: context.camera.source || undefined,
   ```
   and reset `camera` in the returned context (mirror the audio reset).

> Net machine surface: one registered actor, two guards, a handful of `on` handlers, and two
> `assign` actions. No state nodes added/removed; audio transitions unchanged.

---

## 6. Serialization & persistence (SCR3)

All persistence (IndexedDB autosave, `.ne` export/import, live stream) funnels through the SCR3
codec, so a `Blob` field is invisible unless explicitly encoded. Mirror the audio handling in
`src/storage/streamingRecordingCodec.ts`:

1. **Segment kind**: `SEGMENT_KIND.cameraChunk = 9`.
2. **Walk guard**: bump the truncation check
   `if (kind > SEGMENT_KIND.audioChunk ...)` → `kind > SEGMENT_KIND.cameraChunk`. Required so the
   decoder accepts kind 9.
3. **Flag**: `FLAG_HAS_CAMERA = 1 << 1`; OR into header flags when `meta.cameraType` is set.
4. **Meta**: add `cameraType?: string` to `RecordingStreamMeta`.
5. **Writer**: add `appendCameraChunk(chunk)` to `StreamingRecordingWriter` (mirror
   `appendAudioChunk`, kind = cameraChunk).
6. **Decode** (`decodeSegments`): collect `cameraChunks: Uint8Array[]`; build
   `cameraBlob = new Blob([...], { type: meta.cameraType || "video/webm" })`; set
   `cameraBlob`/`cameraSource` on the returned `Recording`.
7. **Encode** (`encodeRecordingToStream`): add `extractCameraBytes(recording)` (mirror
   `extractAudioBytes`) and append the camera chunk **after** the audio chunk.

**Segment order (matters for graceful degradation + streaming):**
`header → frame segments → event segments → audioChunk → cameraChunk → footer`.
Camera is last (heaviest, least time-critical) so progressive playback still shows typing early,
and any decoder that stops at an unknown trailing kind still recovers frames + audio.

8. **Codec worker** (`src/storage/recordingCodec.worker.ts`,
   `src/storage/recordingCodecClient.ts`): **no signature change.** `Recording` (including
   `cameraBlob: Blob`) is structured-cloneable across the worker boundary; the new field rides
   along automatically.
9. **JsonStorage** (`src/storage/JsonStorage.ts`): `save()` already calls
   `encodeRecordingToStream`, so camera persists with no change. Optionally extend
   `hasAudioPayload`-style metadata with a `hasCamera` flag for the recordings list UI (cosmetic).

### 6.1 Live streaming bridge (optional, Phase 2)

`src/storage/recordingStreamSink.ts` forwards live SCR3 bytes. To include camera in live
broadcasts, add a `queueCamera(session.cameraChunks)` mirroring `queueAudio` and pass
`cameraType` in the header meta from `start()`. **Optional**: if omitted, live viewers just don't
see the camera; finalized files still contain it. Mark as non-blocking for the first cut.

---

## 7. Playback — `CameraOverlay` component

New file `src/components/CameraOverlay.tsx`, modeled on `src/components/Cursor.tsx`.

- **Mount**: add `<CameraOverlay />` next to `<CursorComponent />` in `EditorLayout`
  (`src/components/Editor.tsx`). It renders nothing unless a `cameraBlob` exists and the viewer
  toggle is on.
- **Source**: `useMemo` an object URL from `recording.cameraBlob` (when it is a `Blob`); revoke on
  change/unmount. Render `<video muted playsInline preload="auto" />`.
- **Sync** (mirror the audio `SYNC` cadence, but timeline-driven since the camera carries no
  audio): subscribe to the actor; on each animation frame while playing read
  `snapshot.context.timeline.currentTime` and if
  `Math.abs(video.currentTime * 1000 - currentTime) > 250` set `video.currentTime`. React to:
  - play → `video.play()`, pause/ended → `video.pause()`,
  - seek → set `currentTime` immediately,
  - speed → `video.playbackRate = timeline.speed`.
- **Circle + size**: container `~192px` square (configurable), `rounded-full overflow-hidden`,
  `video { width:100%; height:100%; object-fit: cover }`, subtle ring/shadow.
- **Draggable**: pointer handlers update `transform: translate(x, y)`; clamp to viewport bounds;
  persist `{x, y}` to `localStorage` (viewer preference, **not** stored in the recording). Default
  bottom-right, above the media controls (respect their height/z-index, `z < 45`).
- **Show/hide**: a boolean viewer pref (component state or a tiny context), default visible.
  Hidden → pause + unmount the `<video>` (frees decode). Toggled from MediaControls (§8).

> Rationale for a component (not a `cameraPlaybackActor`): the element must be visible,
> draggable, and toggleable — all React concerns — and the fake-cursor overlay already
> establishes this exact "subscribe to actor, animate from `timeline.currentTime`" pattern. No
> change to playback state nodes is needed.

---

## 8. UI controls (`src/components/MediaControls.tsx`)

- **Before recording** (inside the existing `showAudioSourceControls` cluster, beside Mic/File):
  add a camera on/off pill (`Video` / `VideoOff` from `lucide-react`). State
  `enableCameraForNextRecording` (default off). Feature-detect: hide the pill when
  `navigator.mediaDevices?.getUserMedia` is unavailable.
- **Start**: pass the flag through. Extend `startRecording` →
  `startRecording({ audioBlob, enableCamera })`; the binding sends
  `{ type: "START_RECORDING", audioBlob, enableCamera }`. The machine sets
  `enableCameraRecording` for the session from `event.enableCamera ?? context.enableCameraRecording`.
- **During replay** (when `currentRecording?.cameraBlob` is present): add a show/hide-camera toggle
  button near the play/settings controls, bound to the overlay's visibility pref.

---

## 9. Config & provider wiring

- `UseNextEditorConfig` (`src/core/src/types.ts`): add `enableCameraRecording?: boolean` (and
  optionally `cameraConstraints?: MediaTrackConstraints`, `cameraBitsPerSecond?: number`).
- Thread through `useNextEditor` / `useNextEditorActorBindings`
  (`src/core/src/useNextEditor.ts`) into the machine `input` (next to `enableAudioRecording`).
- `NextEditorProvider` (`src/contexts/NextEditorProvider.tsx`): the `config` useMemo can leave
  `enableCameraRecording` defaulting to false and rely on the per-recording toggle from
  MediaControls, or set a default. Either way audio config is unchanged.
- `startRecording` binding and `NextEditorActionsContext` value: widen the `startRecording`
  signature to accept `enableCamera`.

---

## 10. Backward / forward compatibility & non-breaking guarantees

- `cameraBlob`/`cameraSource` are **optional**. Existing recordings (e.g. `public/introduction.ne`)
  decode with `cameraBlob === undefined`; the overlay renders nothing. No re-encoding needed.
- New segment kind 9 is **additive and last in the stream**; the decoder's walk guard is widened
  to accept it. Because camera is the final segment, even a hypothetical older decoder recovers
  all frames/events/audio before stopping at the unknown kind.
- Distinct event types (`CAMERA_*`) guarantee no interference with audio's
  `STARTED`/`CHUNK`/`STOPPED`.
- All capture is gated by `enableCameraRecording` / the per-recording flag → **off by default =
  zero behavioural change** to recording, playback, storage, and streaming.
- No playback state nodes added; timeline/audio/cursor logic untouched.

---

## 11. Risks & edge cases

- **Permission denied / no camera**: `cameraActor` emits `CAMERA_ERROR`; the machine logs and
  continues recording without camera (never transitions to `idle`). MediaControls hides the toggle
  when unsupported.
- **Two permission prompts** (mic + camera) when both are on: acceptable; kept independent so a
  camera denial doesn't kill audio. (A combined `getUserMedia({video,audio})` would couple them —
  rejected.)
- **Double audio**: prevented by recording camera **video-only** and playing it `muted`.
- **Performance/CPU**: video encoding during capture; mitigated by low res + ~400 kbps. Document
  the cost; expose bitrate/resolution via config for tuning.
- **Memory**: revoke camera object URLs on unmount/`clearRecording` (mirror `audioPlaybackActor`
  cleanup). Keep the `<video>` unmounted when the overlay is hidden.
- **Speeds ≠ 1×**: set `video.playbackRate = speed` and rely on the 250 ms drift correction.
- **Cross-origin isolation**: the app already runs COEP/`crossOriginIsolated` for WebContainers;
  `getUserMedia` for camera works under COEP. **No header change.** For embedding the app in a
  third-party iframe (self-hosting), the parent must allow `camera` via `Permissions-Policy` —
  note in `SELF_HOSTING.md`.
- **`.ne` import/export**: works automatically once the codec is updated (same path as audio).

---

## 12. File-by-file change checklist

New files:

- [ ] `src/core/src/machine/cameraActor.ts` — `cameraRecordingActor` (clone of audio recorder).
- [ ] `src/components/CameraOverlay.tsx` — draggable, toggleable, timeline-synced `<video>`.

Edited files:

- [ ] `src/core/src/types.ts` — `Recording.cameraBlob`/`cameraSource`, `CameraPlaceholder`,
      `RecordingCameraSource`, `UseNextEditorConfig.enableCameraRecording`, widen
      `startRecording` return-type signature.
- [ ] `src/core/src/machine/types.ts` — `CameraState`, context `camera` +
      `enableCameraRecording`, `session.cameraChunks`, `CAMERA_*` events into the union,
      `enableCamera` on `StartRecordingEvent`, context factory defaults.
- [ ] `src/core/src/machine/editorMachine.ts` — register actor; `isCameraRecording` guard;
      `recording`/`stoppingRecording` wiring; `captureCameraChunk`, `storeCameraBlob` actions;
      camera fields in `finalizeRecording`; camera reset.
- [ ] `src/core/src/machine/recordingSession.ts` — (only if a helper appends camera chunks;
      otherwise inline in the machine like `captureAudioChunk`).
- [ ] `src/core/src/useNextEditor.ts` — thread `enableCameraRecording` into machine input; widen
      `startRecording({ audioBlob, enableCamera })` and the `START_RECORDING` send.
- [ ] `src/core/src/index.ts` — export new public types (`RecordingCameraSource`, etc.) if needed.
- [ ] `src/storage/streamingRecordingCodec.ts` — kind 9, walk guard, `FLAG_HAS_CAMERA`,
      `cameraType` meta, `appendCameraChunk`, decode/encode camera.
- [ ] `src/storage/JsonStorage.ts` — (optional) `hasCamera` metadata flag.
- [ ] `src/storage/recordingStreamSink.ts` — (optional, Phase 2) `queueCamera` + `cameraType`.
- [ ] `src/components/MediaControls.tsx` — pre-record camera toggle; pass `enableCamera`;
      replay show/hide-camera toggle.
- [ ] `src/components/Editor.tsx` — mount `<CameraOverlay />` in `EditorLayout`.
- [ ] `src/contexts/NextEditorProvider.tsx` — (optional) default `enableCameraRecording`; widen
      `startRecording` in the actions context value.
- [ ] `src/contexts/NextEditorContext.ts` — widen `startRecording` type if declared there.
- [ ] Docs: `docs/data-structures.md`, `docs/state-machines.md`, `docs/data-flow.md`,
      `docs/core.md`, `SELF_HOSTING.md` (camera permission for iframe embeds).

---

## 13. Phased implementation

1. **Phase 1 — Capture & persist (core).** Data model, `cameraActor`, machine wiring,
   SCR3 codec, config/provider. Acceptance: record with camera on → finalized recording carries
   `cameraBlob`; round-trips through IndexedDB and `.ne` export/import; camera-off recordings
   identical to today.
2. **Phase 2 — Replay overlay.** `CameraOverlay` with timeline sync, circular crop, drag, persist
   position. Acceptance: face video plays/pauses/seeks/speeds in lockstep with audio; drag moves
   it; survives reload.
3. **Phase 3 — Controls.** Pre-record camera toggle + per-recording enablement; replay show/hide
   toggle; feature detection. Acceptance: toggles work; unsupported environments hide the UI.
4. **Phase 4 — Polish (optional).** Live-stream camera via the sink bridge; `hasCamera` in the
   recordings list; resolution/bitrate config knobs; docs.

---

## 14. Validation

Per repo convention, run after each phase: formatter/lint check → full build (tsgo via the repo
build) → existing test suite (do **not** add new tests). Key checks:

- `editorMachine.test.ts` still passes (audio + no-audio stop paths unchanged).
- Existing recordings (`public/introduction.ne`) still load and play.
- Build passes under `erasableSyntaxOnly` (no enums / no constructor parameter properties in new
  code — declare fields explicitly).

---

## 15. Open decisions (defaults chosen)

- **Default resolution/bitrate**: 480×480 @ 24fps, 400 kbps (≈3 MB/min). Adjustable via config.
- **Camera audio**: video-only (mic stays the single audio source). _Recommended; assumed._
- **Overlay position/visibility**: viewer-side `localStorage` preference, not stored in the
  recording. _Recommended; assumed._ (Could later store an authored default position in meta.)
- **Live camera streaming**: deferred to Phase 4 (finalized files always include camera).
