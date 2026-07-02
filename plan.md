# Plan: Fix CPU spike on long URL-loaded recordings + externalize audio

Status: **Implemented** (2026-07-02) — A1, A2, A3, A6, B1–B4, B6, plus the pragmatic
half of B5 (external audio is fetched out-of-band after the `.ne` loads and attached as
the playback blob; true range-streaming playback remains a follow-up, as does A4
worker-izing the streaming decode and A5 interval tuning — both now optional since the
quadratics are gone and URL-loaded `.ne` files no longer carry audio bytes).

**Follow-up (same day):** inline audio was removed from the SCR3 format entirely — no
legacy `audioChunk` decoding path. Every recording's audio now lives outside the
stream (sibling `.weba` file for `.ne` exports, a separate IndexedDB blob store for
local saves), mirroring how camera video already worked. `SEGMENT_KIND.audioChunk` is
retired the same way `cameraChunk` was — old `.ne` files with inline audio will not
replay their audio track (this was an accepted breaking change, not an oversight).

Off-speed playback was also switched from SoundTouch (WSOLA resample + pitch-correct,
two-stage processing) to [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/)
(`signalsmith-stretch` npm package), a single-stage phase-vocoder-style time-stretch
driven from a loaded sample buffer. This removes the double-processing artifacts that
made 2x playback sound less natural than the reference bar (YouTube-style speed-up
quality). Implementation notes:

- `HTMLAudioElement` + `preservesPitch` was deliberately avoided — prior experience
  showed it feels laggy and pitch-raise is hard to fully suppress across browsers.
  Stretch keeps everything on the existing Web Audio graph (AudioWorklet + WASM).
- The stretch node is a **single persistent node per AudioContext**, unlike the old
  per-start `SoundTouchNode` — its own internal buffering makes creating a fresh node
  per seek wasteful. Seeks/retempos on it are a duck-and-recover on one persistent
  envelope rather than the native engine's two-envelope crossfade (see
  `startStretchSource` in `audioActor.ts`).
- 1x playback is untouched (still a plain `AudioBufferSourceNode`, byte-for-byte
  native); the stretch worklet loads lazily only when playback actually goes
  off-speed, so 1x users never pay for it.

## 1. Problem statement

Loading a ~50‑minute recording via the `?url=` query parameter drives CPU to
~500% and freezes the browser tab. The **same file imported via file upload is
fine**. So the regression lives in the URL/streaming path, not in the file
itself or in the base decode logic that both paths could share.

Separately, we want to **extract the audio into its own sibling file/URL** so
the `.ne` shrinks dramatically (audio is by far the largest payload in a long
recording). As shown below, this second change also removes the single biggest
CPU driver on the URL path, so the two asks are tightly coupled.

## 2. The two load paths (why upload is fine, URL is not)

**File upload** — [`importNextEditorFile`](src/hooks/useUrlLoader.ts:158)
→ [`decompressBinaryToRecordings` / `decodeBase64ToRecordings`](src/storage/recordingCodecClient.ts:58)
→ runs the whole decode **once, in a Web Worker** (Comlink) via
[`recordingCodec.worker.ts`](src/storage/recordingCodec.worker.ts:1)
→ dispatches `loadRecording` **exactly once**.
Main thread stays free; there is no progressive re-processing.

**URL load** — [`fetchNextEditorFile`](src/hooks/useUrlLoader.ts:379)
→ [`streamRecordingFromResponse`](src/hooks/useUrlLoader.ts:251)
→ uses [`createStreamingRecordingReader`](src/storage/streamingRecordingCodec/decode.ts:392)
**directly on the main thread** (no worker), and every
`STREAM_DECODE_INTERVAL_BYTES = 512 KB`
([useUrlLoader.ts:17](src/hooks/useUrlLoader.ts:17)) it calls
`applyStreamed()` → `getRecording()` → `loadRecording` (first time) or
`extendRecording` (every time after).

The incremental _segment_ decode inside the reader is genuinely O(n) (it only
parses newly-arrived segments — see the comment at
[decode.ts:364](src/storage/streamingRecordingCodec/decode.ts:364)). The
quadratic blow-up is in everything that runs **per interval on the whole
accumulated recording**, on the main thread, and it only bites long recordings.

## 3. Root cause: three compounding O(n²) loops on the main thread

For a download split into `K ≈ fileSize / 512 KB` intervals, each interval
re-processes the _entire recording so far_. Total work ≈ `Σ size(i)` ≈
`O(N·K)` = quadratic in file size. Short recordings have small `N` and `K` so
it is invisible; a 50‑min recording has large `N` **and** large `K`.

### Quadratic #1 — full re-assemble + normalize every interval

`getRecording()` → [`assembleRecording`](src/storage/streamingRecordingCodec/decode.ts:154)
rebuilds the whole `Recording` and calls
[`normalizeRecordingData`](src/core/src/utils/editorState.ts:275), which
`.map()`s over **all frames** and deep-clones each frame's `viewState` with
`structuredClone` ([editorState.ts:14](src/core/src/utils/editorState.ts:14),
[normalizeDeltaFrame](src/core/src/utils/editorState.ts:259)). This is heavy per
frame and re-runs over the growing frame array on every 512 KB tick.

### Quadratic #2 — normalize runs a _second_ time per interval

The [`extendRecording`](src/core/src/machine/editorMachine.ts:641) action calls
`normalizeRecordingData(event.recording)` **again** on the already-normalized
recording produced by `assembleRecording`. So all frames are structured-cloned
**twice per interval**. Pure duplicate work.

### Quadratic #3 — re-decode the whole audio blob every interval (the big one)

On each interval `extendRecording` sends `EXTEND_RECORDING`, whose handler
([editorMachine.ts:1780](src/core/src/machine/editorMachine.ts:1780)) does
`APPEND_FRAGMENT` with the **entire accumulated audio blob**
([editorMachine.ts:1815](src/core/src/machine/editorMachine.ts:1815)) →
[`decodeBlob`](src/core/src/machine/audioActor.ts:693) →
`context.decodeAudioData(arrayBuffer)` over the **whole growing blob** each time.
This happens even if the user never pressed play.

- Audio is recorded at 32 kbps ([audioActor.ts:205](src/core/src/machine/audioActor.ts:205));
  50 min ≈ **~12 MB**, dominating the `.ne`. So most 512 KB intervals are
  triggered by audio bytes, and each one re-decodes a larger blob.
- Over ~30 intervals of a growing ~12 MB blob → on the order of **~150–200 MB of
  Opus decoded** in total, repeatedly.
- `decodeAudioData` runs on the browser's media/decoder threads → **multiple
  cores busy** → this is the main source of the reported ~500% (main-thread JS +
  several audio-decode threads + GC threads).

### Amplifiers

- **No worker on the URL path.** All of #1/#2 run on the main thread and block
  paint/input — the "unresponsive tab".
- **GC pressure.** Repeated `structuredClone` of every frame + array spreads
  churn huge short-lived garbage → V8 concurrent GC spreads across background
  threads → adds to multi-core CPU.
- **Nested `Blob` chain.** The reader grows audio as
  `new Blob([audioBlob, chunk])` per pushed audio segment
  ([decode.ts:508](src/storage/streamingRecordingCodec/decode.ts:508)); with
  ~1 s timeslices that is thousands of nested `Blob`s over a 50‑min file, making
  each later `arrayBuffer()`/`decodeAudioData` walk progressively more expensive.
- `setIsLoading(false)` fires after the **first** chunk
  ([useUrlLoader.ts:284](src/hooks/useUrlLoader.ts:284)), so the spinner
  disappears while the quadratic work continues in the background — matching the
  "tab looks loaded, then freezes" symptom.

### Why file upload never hits this

One decode, in a worker, one `loadRecording`, **zero** `extendRecording` calls →
no per-interval re-assemble, re-normalize, or re-`decodeAudioData`.

## 4. Fix plan

Two workstreams. **Part B (externalize audio)** gives the largest win for both
asks (file size _and_ CPU) and should land first or alongside Part A. **Part A**
hardens the streaming path so it can never go quadratic again, even for
recordings that still embed media.

### Part A — De-quadratic the streaming URL path

- **A1. Stop re-decoding audio on every extend (kills Quadratic #3).**
  During progressive load, do **not** push the whole growing audio blob into
  `decodeAudioData` each interval. Options (pick in review):
  - Defer audio entirely until the stream is finalized (footer arrived) or until
    the user actually presses play, then decode once; or
  - Feed the audio actor only _new_ bytes and let it decode incrementally,
    instead of re-sending the full blob every time.
    With Part B this path largely disappears for URL loads (no inline audio).

- **A2. Remove the double normalize (kills Quadratic #2).**
  `assembleRecording` already returns normalized data; make
  [`extendRecording`](src/core/src/machine/editorMachine.ts:641) trust it and
  drop the second `normalizeRecordingData`. Confirm all `extendRecording`
  callers pass already-normalized recordings.

- **A3. Make progressive extend incremental instead of whole-recording
  (attacks Quadratic #1).**
  Today each interval produces a brand-new fully-normalized `Recording` and the
  machine replaces `context.recording` wholesale, re-running
  `APPLY_REPLAY_STATE_ACTIONS` over everything. Change the streaming reader
  and/or `extendRecording` to **append only newly-decoded frames/events** and
  normalize only those new records, rather than re-normalizing the full array.
  (The reader already knows what is new — it decodes only new segments.)

- **A4. Do the streaming decode off the main thread.**
  Run `createStreamingRecordingReader` (or at least `normalizeRecordingData`) in
  the existing codec worker, mirroring the upload path. Comlink already wraps the
  worker; add a streaming/`push` API or transfer decoded chunks back. This keeps
  the tab responsive regardless of size.

- **A5. Skip progressive decoding when it buys nothing.**
  Progressive decode only helps _play-before-fully-downloaded_. For a normal
  `?url=` open we can raise `STREAM_DECODE_INTERVAL_BYTES` substantially and/or
  decode once at stream end for already-finalized files, collapsing `K` toward 1
  (i.e. behave like the upload path). Consider a size threshold above which the
  URL path decodes once in the worker instead of progressively.

- **A6. Fix the nested-`Blob` growth.**
  Accumulate audio chunks in an array and build the `Blob` once on read, or cap
  nesting depth, so `arrayBuffer()`/`decodeAudioData` cost stays flat.

### Part B — Externalize audio into a sibling file/URL (mirror camera)

Camera already does exactly this: bytes live outside the `.ne`, referenced by
[`cameraFile`](src/core/src/types.ts:220) / [`cameraUrl`](src/core/src/types.ts:226),
resolved on URL load by
[`withResolvedCameraUrl`](src/hooks/useUrlLoader.ts:45), and written as a sibling
on export ([RecordingStorage.exportAsFile](src/storage/RecordingStorage.ts:206)).
Replicate that for audio.

- **B1. Types/format.** Add `audioFile?: string` and `audioUrl?: string` to
  [`Recording`](src/core/src/types.ts:187) and to
  [`RecordingStreamMeta`](src/storage/streamingRecordingCodec/format.ts:87)
  (alongside the existing `cameraFile`/`cameraUrl`). Do **not** overload the
  existing `audioSource: "external"`, which already means "audio provided at
  record time" and is unrelated to storage location.

- **B2. Encoder.** In
  [`encodeRecordingToStream`](src/storage/streamingRecordingCodec/encode.ts:286),
  when audio is externalized, skip `appendAudioChunk`
  ([encode.ts:400](src/storage/streamingRecordingCodec/encode.ts:400)) and instead
  write `audioFile`/`audioUrl` + `audioType`/`audioStartOffsetMs` into the header
  — exactly how camera is handled. Reserve/retire the `audioChunk` kind path the
  way `cameraChunk` (kind 9) was retired
  ([format.ts:80](src/storage/streamingRecordingCodec/format.ts:80)); older files
  with inline audio must still decode.

- **B3. Export.** Extend
  [`exportAsFile`](src/storage/RecordingStorage.ts:206) to externalize the audio
  blob into `<name>.<audio-ext>` and reference it via `audioFile` (add an
  `audioExtensionFromMime` helper next to
  [`cameraExtensionFromMime`](src/storage/streamingRecordingCodec/format.ts:361)).
  Result: a recording exports as `.ne` (+ optional camera) + `.<audio-ext>`, and
  the `.ne` drops from tens of MB to well under 1 MB.

- **B4. URL loader.** Add `withResolvedAudioUrl` mirroring
  [`withResolvedCameraUrl`](src/hooks/useUrlLoader.ts:45) to resolve `audioFile`
  against the `.ne` URL. Because inline audio is gone, the SCR3 stream is tiny →
  `K` collapses to ~1–2 intervals → Quadratics #1/#3 essentially vanish on the
  URL path.

- **B5. Playback from a URL.** Prefer range-streaming external audio like camera
  does (native element with `src=audioUrl`) instead of fetch-whole-blob +
  `decodeAudioData`. This likely means teaching
  [`audioPlaybackActor`](src/core/src/machine/audioActor.ts:324) /
  [`getPlaybackAudioState`](src/core/src/machine/editorMachineHelpers.ts:430) a
  URL/`HTMLAudioElement` mode. Keep the existing blob path for imported/local
  audio. **Trade-off to decide in review:** `HTMLAudioElement` range-streams and
  never fully decodes (best for 50‑min files) but the current pitch-preserving
  SoundTouch graph is built around Web Audio buffers; may need a fetch-blob
  fallback when off-speed playback is requested.

- **B6. File-upload import.** Mirror camera's companion-file selection
  ([RecordingStorage.ts:251](src/storage/RecordingStorage.ts:251),
  [pickCompanionVideo](src/storage/RecordingStorage.ts:51)) so a `.ne` +
  sibling audio can be selected/dropped together and attached via an object URL,
  same as camera.

## 5. Testing plan

- **Repro/regression harness.** Add a test that streams a large synthetic SCR3
  (many frames + a large audio track) through `streamRecordingFromResponse` and
  asserts the number of `normalizeRecordingData`/`decodeAudioData` invocations is
  ~O(1)/O(K) — **not** O(K²). This locks in the fix.
- **Parity.** Same file via upload vs `?url=` must yield an identical decoded
  `Recording` (existing round-trip tests in
  [recordingCodec.test.ts](src/storage/recordingCodec.test.ts) are the anchor).
- **Externalized audio round-trip.** Export → produces `.ne` + sibling audio;
  the `.ne` no longer contains `audioChunk` segments; re-import (both upload and
  `?url=`) reproduces audio + correct `audioStartOffsetMs`/duration.
- **Back-compat.** Old `.ne` files with inline audio still decode and play.
- **Manual.** Load a real ~50‑min recording via `?url=` and confirm CPU stays
  low and the tab is responsive (per project convention, the user eyeballs the
  UI; do not use the preview browser).
- Run `npx vp test run` / `tsc` (bun-based repo — do **not** use npm).

## 6. Risks / rollout

- **Format change** (`audioFile`/`audioUrl`): additive and back-compatible; must
  keep decoding legacy inline-audio streams. No migration of existing files.
- **Playback-from-URL** is the riskiest bit (pitch-preservation graph assumes
  Web Audio buffers). De-risk by keeping the blob path as a fallback.
- **Two-file export UX**: users must keep `.ne` + audio together (same caveat
  that already exists for camera video). Reuse the companion-file matching UX.
- **CORS**: externally-hosted sibling audio needs the same CORS/proxy handling
  the loader already applies to the `.ne`
  ([fetchNextEditorUrl](src/hooks/useUrlLoader.ts:110)).

## 7. Suggested sequencing

1. **B1–B4** (externalize audio + shrink `.ne` + resolve on load) — biggest win
   for both file size and CPU; keep the existing blob playback path initially.
2. **A2 + A1** (drop double-normalize; stop per-interval whole-blob audio decode)
   — cheap, high-impact safety net for any remaining inline-media recordings.
3. **A6 + A3** (Blob accumulation; incremental append) — removes residual
   per-interval whole-recording work.
4. **A4/A5** (worker-ize streaming / single-shot large-file path) — makes the
   URL path structurally immune to size.
5. **B5–B6** (URL/range-stream playback + companion import) — polish and the
   final memory win for very long recordings.
