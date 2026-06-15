# Stream-Compatible Recording — Implementation Plan

Last updated: 2026-06-15

## Goal

Make Next Editor recordings **stream-compatible** (append-as-you-record, partial/range
replay, optional live emission) **without breaking** the delta constructions, the XState
machines, or the actors, and **without increasing storage size** versus the current
SuperJSON + deflate(level 9) artifact.

This plan answers the open question first (is the capture-side change safe?), then
specifies the storage/codec rework the user has approved, then lists concrete,
file-by-file changes.

---

## 1. Verdict on Blocker #1 (incremental delta capture) — SAFE, NON-BREAKING

**Conclusion: we can move delta construction from finalize-time to capture-time and get a
byte-identical `DeltaFrame[]`, with no structural change to any machine or actor. It also
_reduces_ in-memory cost.**

### Why it is provably non-breaking

`compressFrames()` in [src/core/src/utils/frameDelta.ts](src/core/src/utils/frameDelta.ts#L444)
is a pure left-fold over the captured frames. Its only running state is:

- `lastStoredFrame: EditorFrame | null` — the last frame actually emitted, and
- the input index `i` (used only by `shouldBeKeyframe(i)` => `i === 0 || i % 120 === 0`).

For each input frame it does exactly one of:

- `i === 0` → emit keyframe, advance `lastStoredFrame`;
- keyframe slot with changes → emit keyframe, advance `lastStoredFrame`;
- delta slot with changes → emit delta, advance `lastStoredFrame`;
- no changes → emit nothing (input index still advances).

Because every decision depends only on `i` and `lastStoredFrame` — both available the moment
a frame is captured — feeding frames one at a time through the same logic yields the **exact
same output array** as compressing the whole buffer at the end. There is no look-ahead and
no dependence on future frames.

### Why replay is already streaming-safe

Playback reconstructs a frame via
[`reconstructFrameAtIndex`](src/core/src/utils/frameDelta.ts#L405) +
[`findNearestKeyframeIndex`](src/core/src/utils/frameDelta.ts): it finds the nearest keyframe
**at or before** the target and applies deltas **forward**. It never needs a frame after the
target. Keyframes are emitted at least every 120 input frames, so any in-order prefix of the
stream is already self-consistent and replayable. The replay/timeline/preview/slide/workspace
cursors in [src/core/src/machine/replayState.ts](src/core/src/machine/replayState.ts) are all
"find latest event at-or-before currentTime" scans — they work unchanged on a growing array.

**We do _not_ need Scrimba's reversible apply/revert cursor.** Forward-only reconstruction is
the easier model and is already what we have.

### Memory impact: improvement, not regression

Today `session.frames` retains **every full `EditorFrame`** (full editor content per frame)
until `finalizeRecording`. This is the source of the large in-memory strings noted in
[memory-leak-review.md](memory-leak-review.md). Incremental compression keeps only the
emitted `DeltaFrame[]` plus a single `lastStoredFrame`, so peak memory during long recordings
**drops** — directly serving the "efficient storage" constraint at runtime as well as on disk.

### The one careful refactor (and how we keep it safe)

`captureFrame` reads `frames[frames.length - 1]` for mouse-throttle timing
([editorMachine.ts](src/core/src/machine/editorMachine.ts#L932)). We preserve that by keeping
two small fields on the session instead of the whole array:

- `lastFullFrame: EditorFrame` (the running base for delta computation + throttle timing), and
- `lastStoredFrame: EditorFrame` + `inputFrameCount: number` (encoder state).

Everything else (`finalizeRecording` duration math, audio, snapshots, slide/preview/workspace
event arrays) is untouched.

---

## 2. Scope of Change (what moves, what stays)

| Layer                                                                         | Today                                         | After                                                            | Breaking?                     |
| ----------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- | ----------------------------- |
| Capture (`captureFrame`)                                                      | pushes full `EditorFrame` to `session.frames` | folds frame into an incremental encoder → `DeltaFrame[]`         | No — identical output         |
| Finalize (`compressFrames`)                                                   | compress whole buffer                         | concatenate already-built `DeltaFrame[]` (kept as fallback path) | No                            |
| Frame replay                                                                  | `reconstructFrameAtIndex` forward             | unchanged                                                        | No                            |
| Machines/actors (editor, audio, replay, preview, slides, workspace, timeline) | —                                             | unchanged shape                                                  | No                            |
| On-disk codec                                                                 | SuperJSON→deflate(9) whole array, `SCRM` v2   | append-only segmented container, `SCR3`                          | Replaced (legacy import kept) |
| IndexedDB store                                                               | one blob per recording                        | segment store, append per segment                                | Replaced (legacy read kept)   |
| Audio                                                                         | final blob only                               | timesliced chunks appended live (final blob still produced)      | Additive                      |
| Live emission                                                                 | none                                          | optional sink reusing the segment stream                         | Additive                      |

The delta format (`Keyframe`/`FrameDelta`/`ContentDelta`/`SelectionDelta`/`PositionDelta`),
`DELTA_CONFIG.KEYFRAME_INTERVAL = 120`, and the `Recording` shape are all preserved.

---

## 3. Design

### 3.1 Incremental frame encoder (capture-time delta construction)

New module: `src/core/src/utils/frameStreamEncoder.ts`

```ts
export interface FrameStreamEncoderState {
  inputFrameCount: number; // total frames seen (drives keyframe cadence)
  lastStoredFrame: EditorFrame | null;
  lastFullFrame: EditorFrame | null; // for mouse-throttle timing in captureFrame
}

export function createFrameStreamEncoder(): FrameStreamEncoderState;

// Returns the DeltaFrame to append (or null when the frame is skipped — no changes).
// Pure: same decision tree as compressFrames(), one frame at a time.
export function pushFrame(
  state: FrameStreamEncoderState,
  frame: EditorFrame,
): { state: FrameStreamEncoderState; emitted: DeltaFrame | null };
```

Implementation reuses `createKeyframe`, `createFrameDelta`, `hasChanges`, `shouldBeKeyframe`
verbatim from `frameDelta.ts` — no duplicated delta math.

**Equivalence guarantee:** `reduce(pushFrame)` over a frame array MUST equal
`compressFrames(array)`. We keep `compressFrames` as the canonical reference and the
finalize-time fallback, so the two paths can be diffed during development against existing
`.ne` fixtures.

### 3.2 Recording session changes

In [src/core/src/machine/types.ts](src/core/src/machine/types.ts) `RecordingSession`:

- Replace `frames: EditorFrame[]` with:
  - `frames: DeltaFrame[]` (already-compressed, append-only), and
  - `encoder: FrameStreamEncoderState`.
- Keep `slideEvents`, `previewEvents`, `previewInitialDocuments`, `previewPatchBatches`,
  `workspaceEvents`, `runtimeEvents`, `cursorEvents`, `lastMousePosition` as-is (they are
  already append-only logical streams).

`initRecordingSession` ([editorMachine.ts](src/core/src/machine/editorMachine.ts#L900)) seeds
the encoder with the initial frame (which becomes the first keyframe immediately).

`captureFrame` ([editorMachine.ts](src/core/src/machine/editorMachine.ts#L932)):

- compute `timestamp` and mouse logic as today;
- mouse-throttle check uses `session.lastFullFrame.timestamp` instead of
  `frames[frames.length - 1].timestamp`;
- call `pushFrame`; if `emitted`, append to `session.frames` and (Tier B) hand `emitted` to
  the segment writer; always update `lastFullFrame`.

`finalizeRecording` ([editorMachine.ts](src/core/src/machine/editorMachine.ts#L1022)):

- replace `const frames = compressFrames(context.session.frames)` with
  `const frames = context.session.frames` (already compressed);
- everything else unchanged.

### 3.3 Append-only segmented container (`SCR3`)

New module: `src/storage/streamingRecordingCodec.ts`

On-disk byte layout (single file = a valid stream; identical bytes whether built live or
exported):

```
┌────────────────────────────────────────────────────────────┐
│ Magic "SCR3" (4 bytes)                                      │
│ Format version u16                                          │
│ Flags u16 (bit0: hasAudio, bit1: finalized)                │
│ Header segment: deflate(msgpack(recordingMeta))            │  ← id,name,version,
│   length-prefixed (u32)                                     │     keyframeInterval,
│                                                              │     createdAt, audioMeta…
├────────────────────────────────────────────────────────────┤
│ DATA SEGMENTS (repeated, append-only):                     │
│   u8  kind (0=frames,1=slide,2=preview,3=previewDoc,        │
│            4=previewPatch,5=workspace,6=runtime,7=cursor,    │
│            8=audioChunk)                                     │
│   u32 byteLength                                            │
│   u32 firstTimestampMs                                      │
│   i32 firstFrameIndex (frames only; -1 otherwise)          │
│   u8  containsKeyframe (0/1)                                │
│   bytes: deflate-block(msgpack(records[]))  (FULL_FLUSH)    │
├────────────────────────────────────────────────────────────┤
│ FOOTER (written on finalize; optional for live tail):      │
│   index[]: {kind,u32 byteOffset,u32 firstTs,i32 firstIdx}  │
│   u32 footerLength                                          │
│   Magic "SCR3" (trailer marker)                            │
└────────────────────────────────────────────────────────────┘
```

Key properties:

- **Append-only:** each `DeltaFrame` batch / event batch / audio chunk is its own segment,
  written as recorded. No rewrite of earlier bytes.
- **Seekable:** the footer index maps frame index / timestamp → byte offset. A reader without
  a footer (still-recording stream) scans segments sequentially.
- **Range-loadable:** because deflate blocks use `Z_FULL_FLUSH` at **keyframe boundaries**,
  each frame segment decodes independently → a remote reader can fetch a byte range around
  the target keyframe (Scrimba-style range load) without the whole file.

Encoder API:

```ts
export interface StreamingRecordingWriter {
  writeHeader(meta: RecordingMeta): void;
  appendFrameSegment(frames: DeltaFrame[]): void; // batched at keyframe boundary
  appendEventSegment(kind: SegmentKind, records: unknown[]): void;
  appendAudioChunk(chunk: Uint8Array): void;
  finalize(): Uint8Array; // appends footer
  // live access:
  drainPending(): Uint8Array; // bytes since last drain (for sink/store)
}

export function createStreamingRecordingWriter(): StreamingRecordingWriter;
```

Reader API (legacy-aware):

```ts
export async function decodeRecordingStream(bytes: Uint8Array): Promise<Recording>; // SCR3
export async function decodeRecordingPrefix(bytes: Uint8Array): Promise<Recording>; // partial / still-writing stream
```

`recordingCodec.ts` keeps `decompressBinaryToRecordings` for **legacy `SCRM` v2** import. The
top-level read path dispatches on magic (`SCRM` → legacy, `SCR3` → streaming).

### 3.4 Batching policy (this is the storage-size lever)

- Frame segments flush **at each keyframe boundary** (every ≤120 frames) or after an idle gap.
  This keeps the deflate dictionary warm within a segment and bounds `Z_FULL_FLUSH` resets to
  ~once per 2s of editor frames.
- Event segments (slide/preview/workspace/runtime/cursor) flush on a small count/time
  threshold (e.g. every 32 records or 1s), so high-cadence cursor samples don't create a
  segment each.
- Audio segments = one segment per `MediaRecorder` timeslice chunk.

### 3.5 Audio: enable live chunks (additive)

In [src/core/src/machine/audioActor.ts](src/core/src/machine/audioActor.ts):

- call `mediaRecorder.start(AUDIO_TIMESLICE_MS)` (e.g. 1000ms) instead of `start()`
  ([line 161](src/core/src/machine/audioActor.ts#L161));
- the existing `CHUNK` emit ([line 142](src/core/src/machine/audioActor.ts#L142)) already
  forwards `ondataavailable`; route `CHUNK` to `appendAudioChunk`;
- still assemble and emit the final `STOPPED` blob exactly as today, so existing finalize/audio
  duration logic is unchanged.

Note: WebM/Opus is only fully decodable once finalized; live audio chunks are for upload/tail,
not for mid-stream audio scrubbing. Frame/event replay is fully live regardless.

### 3.6 Segmented IndexedDB store (append during recording)

In [src/storage/IndexedDBRecordingStore.ts](src/storage/IndexedDBRecordingStore.ts):

- add a `recording-segments` object store keyed by `[recordingId, segmentSeq]`;
- `appendSegments(recordingId, bytes)` writes the drained bytes for crash-resilient,
  incremental persistence while recording;
- `getEntry` concatenates segments (in seq order) → the same `SCR3` byte layout the exporter
  produces, then feeds the existing decode path;
- keep the legacy `recording-payload` (single blob) read path for old recordings;
- bump `RECORDING_DATABASE_VERSION` and add the store in `onupgradeneeded`.

`JsonStorage` ([src/storage/JsonStorage.ts](src/storage/JsonStorage.ts)) gains
`appendRecordingSegments()` and keeps `saveRecording()` (now: finalize writer → single blob or
segment set) and `exportRecording()` (concatenate → `SCR3` file). Worker plumbing in
[recordingCodec.worker.ts](src/storage/recordingCodec.worker.ts) /
[recordingCodecClient.ts](src/storage/recordingCodecClient.ts) gains streaming encode/decode
entry points; heavy deflate stays off the main thread.

### 3.7 Optional live sink (the actual "stream while recording")

New module: `src/storage/recordingStreamSink.ts`

```ts
export interface RecordingStreamSink {
  write(bytes: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
}
```

`captureFrame`/audio/event handlers call `writer.drainPending()` and forward bytes to an
optional configured sink (WebSocket / `fetch` ReadableStream / callback). Because the bytes
are the same `SCR3` stream, a remote consumer can tail and replay with `decodeRecordingPrefix`.
This is opt-in via `UseNextEditorConfig` and does not affect local recording when absent.

---

## 4. File-by-File Change List

**Core (capture/delta — must stay non-breaking):**

- `src/core/src/utils/frameStreamEncoder.ts` — NEW incremental encoder (reuses `frameDelta`).
- `src/core/src/utils/frameDelta.ts` — no behavior change; export helpers if needed. Keep
  `compressFrames` as canonical reference + finalize fallback.
- `src/core/src/machine/types.ts` — `RecordingSession`: `frames: DeltaFrame[]` + `encoder` +
  `lastFullFrame`.
- `src/core/src/machine/editorMachine.ts` — `initRecordingSession`, `captureFrame`,
  `finalizeRecording` use the encoder; mouse-throttle reads `lastFullFrame`.
- `src/core/src/machine/recordingSession.ts` — append helpers unchanged (already streaming).

**Audio (additive):**

- `src/core/src/machine/audioActor.ts` — timeslice `start()`, route `CHUNK` to writer.

**Storage (replaceable per user):**

- `src/storage/streamingRecordingCodec.ts` — NEW `SCR3` writer/reader.
- `src/storage/recordingStreamSink.ts` — NEW optional live sink interface.
- `src/storage/recordingCodec.ts` — keep legacy `SCRM` v2 import; add magic dispatch.
- `src/storage/recordingCodec.worker.ts` / `recordingCodecClient.ts` — streaming entry points.
- `src/storage/IndexedDBRecordingStore.ts` — segment store + concat read; DB version bump.
- `src/storage/JsonStorage.ts` — `appendRecordingSegments`, finalize/export via `SCR3`.

**Wiring (optional sink config):**

- `src/core/src/types.ts` / `useNextEditor.ts` — optional `recordingStreamSink` config.

---

## 5. Storage Size — Parity Argument

The "do not bloat storage" constraint is the main risk. Mitigations:

1. **No SuperJSON per record.** SuperJSON's metadata tree exists to carry `Blob`/`Date`/`Map`
   etc. Audio is already extracted to binary before serialization, and frames/events are plain
   JSON-serializable. Per-record encoding uses **msgpack** (compact, no key repetition tax vs
   JSON) — typically smaller than the current JSON-string input to deflate.
2. **Warm dictionary within segments.** A single streaming `pako.Deflate` per recording with
   `Z_FULL_FLUSH` only at keyframe boundaries keeps deflate's dictionary across the ~120 frames
   of a segment, so intra-segment ratio ≈ whole-file deflate.
3. **Bounded flush overhead.** `Z_FULL_FLUSH` adds a few bytes + a dictionary reset per
   segment. At one keyframe per ~2s, a 10-min recording has ~300 segments → low-single-digit KB
   of flush overhead and a small ratio loss, offset by (1).
4. **Tiny footer.** ~16 bytes × segment count (≈5 KB for 10 min) — negligible.

Net expectation: **within a few percent of today, and often smaller** thanks to msgpack.
The segment size is a tunable knob: larger segments → better ratio, coarser seek granularity.

**Validation (one-off measurement, not a test suite):** encode existing fixtures
(`public/introduction.ne` and any saved recordings) with both the current codec and `SCR3`,
compare byte sizes; tune segment batching if any regression appears. Extend the existing
`scripts/benchmark-wasm-diff.mjs` style one-off script rather than adding unit tests.

---

## 6. Backward Compatibility & Migration

- **Reading old recordings:** `SCRM` v2 path is retained; magic-byte dispatch selects it.
  Existing `.ne` files and IndexedDB blobs load unchanged.
- **Writing:** new recordings use `SCR3`. No migration of old data required.
- **Export/import:** `.ne` export becomes a single `SCR3` file (still one downloadable blob);
  import accepts both magics.
- **Recording `version` field stays `3`** (schema unchanged); the on-disk container version is
  separate from the recording schema version.

---

## 7. Risk Register (how each "do not break" item is protected)

| Risk                           | Protection                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Delta semantics drift          | Encoder reuses `frameDelta` functions verbatim; `compressFrames` kept as reference + fallback; diff both over fixtures.     |
| Machine/actor shape change     | Only `RecordingSession` bookkeeping fields change; states, events, actors untouched.                                        |
| Replay regressions             | Forward reconstruction + at-or-before cursors already operate on growing arrays; no algorithm change.                       |
| Storage bloat                  | msgpack records + warm-dictionary streaming deflate + keyframe-boundary FULL_FLUSH; measured vs current; segment-size knob. |
| Audio behavior change          | Timeslice is additive; final blob + duration logic unchanged.                                                               |
| Corruption on crash mid-record | Segment store + sequential-scan reader make any in-order prefix replayable.                                                 |
| Worker/main-thread perf        | Deflate stays in the codec worker; capture-time work is a single per-frame fold (cheaper than today's retain-all-frames).   |

---

## 8. Phased Rollout

1. **Phase 1 — Incremental encoder (no storage change).** Add `frameStreamEncoder`, switch
   `session.frames` to `DeltaFrame[]`, finalize concatenates. Confirm output equals
   `compressFrames` over fixtures. Ship: same files, smaller memory, zero format change.
2. **Phase 2 — `SCR3` container + segmented IndexedDB.** Add streaming codec + segment store +
   legacy dispatch + size validation. Export/import on new format.
3. **Phase 3 — Live audio chunks + optional sink.** Timeslice audio; add
   `recordingStreamSink`; wire opt-in config for live upload/tail.

Each phase is independently shippable; Phase 1 alone already de-batches capture and reduces
memory while keeping the current file format.

---

## 9. Validation (per repo workflow)

After each phase's code changes, run the repo workflow: `vp check --fix`, then `vp check`,
then `vp build`, and run the existing test suite to confirm no regressions in delta/replay.
Do not add new test plans; rely on existing tests plus the one-off size-comparison measurement
in Phase 2.

---

## 10. Summary

- **Blocker #1 is safe.** Capture-time delta construction yields identical `DeltaFrame[]`,
  needs no machine/actor redesign, and lowers memory. This is the critical green light.
- **Blockers #2 and #3** (codec + store) are replaced with an append-only, seekable, range-
  loadable `SCR3` segment stream that stays size-comparable via msgpack + warm-dictionary
  streaming deflate, with legacy import preserved.
- The result is genuinely stream-compatible (record-while-appending, partial replay, optional
  live emission) while preserving every delta construction, machine, and actor.
