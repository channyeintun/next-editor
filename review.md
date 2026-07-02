# Core Architecture Review — codec, storage, machines, dmp

Date: 2026-07-02. Scope: `src/core` (machines, frame delta pipeline, dmp Rust WASM),
`src/storage` (SCR3 codec, IndexedDB stores, worker client), and the load paths that
consume them (`useUrlLoader`, `NextEditorProvider`). Review only — nothing here is
implemented.

**Overall assessment.** The architecture is in good shape and the hard lessons are
already encoded: the SCR3 container is a clean single-source-of-truth byte layout
(`format.ts`), the incremental reader avoids the old O(n²) progressive-decode trap, the
dmp Rust module is small, zero-import, and byte-compatible with its AssemblyScript
predecessor, and `codec-history.md` should prevent the codec-language loop from
re-running. The improvements below are ranked by impact; the top four are the ones I'd
actually schedule. Each has a concrete implementation plan.

**Compatibility stance (per project owner):** no legacy compatibility is required.
Old files, old encodings, and old on-wire versions do not need to keep loading. That
makes several items below pure _deletions_ rather than dual-path migrations, and it
adds P0 (a legacy-surface sweep) as the natural first step.

---

## P0 — Delete the legacy surface outright

With backward compatibility off the table, a meaningful amount of code exists only to
read formats nothing will produce again. Removing it first simplifies every later item.

**What to delete:**

1. **All base64 support** (see P1): `src/core/src/utils/base64.ts`, the
   `encodeRecordingToBase64Stream` / `decodeBase64ToRecordings` functions and their
   worker/client mirrors ([recordingCodec.ts:33-40](src/storage/recordingCodec.ts:33),
   [recordingCodec.worker.ts](src/storage/recordingCodec.worker.ts),
   [recordingCodecClient.ts](src/storage/recordingCodecClient.ts)), and the entire
   text-mode branch of the URL streamer — sniffing, `feedBase64`, the
   `TextDecoder` accumulation ([useUrlLoader.ts:284-396](src/hooks/useUrlLoader.ts:284)).
   A `.ne` is SCR3 bytes, full stop: bad magic → error.
2. **SCR3 format-version-1 segment headers**: `LEGACY_SEGMENT_HEADER_SIZE`, the
   `isLegacy` branches in `readSegmentHeader` / `segmentHeaderSize`
   ([format.ts:306-335](src/storage/streamingRecordingCodec/format.ts:306)), and the
   `formatVersion` plumbing through `decode.ts` — always v2.
3. **Recording schema version 2**: `meta.version: 2 | 3` narrows to `3` (or renumber
   to a single `4` when P6 lands), `normalizeRecording`'s version-2 acceptance
   ([recordingCodec.ts:12-20](src/storage/recordingCodec.ts:12)), and
   `DeltaRecording.version: 2 | 3` ([deltaTypes.ts:94](src/core/src/utils/deltaTypes.ts:94)).
4. **Retired segment kinds 8/9** (inline audio/camera chunks): the "do not reuse"
   reservation ([format.ts:78-82](src/storage/streamingRecordingCodec/format.ts:78))
   existed only so old streams containing them kept decoding. They're free numbers
   again — reclaim or delete the comment.
5. **`public/introduction.ne`**: re-encode once to the final format (binary, current
   schema, P6 check-ops) so the demo needs no special-casing.
6. Users' existing IndexedDB recordings from older builds are dropped — the DB
   upgrade path already clears stores on version bumps
   ([IndexedDBRecordingStore.ts:84-124](src/storage/IndexedDBRecordingStore.ts:84)),
   so bump `RECORDING_DATABASE_VERSION` and let it wipe.

**Impact.** Less code in the hottest files, one decode path instead of three, and every
subsequent change (P1, P6) becomes a straight edit instead of a versioned migration.
**Effort: small** — it is almost entirely deletion, and `recordingCodec.test.ts`
pins the surviving path.

---

## P1 — Export `.ne` as raw binary; stop paying the base64 tax

**Problem.** Every exported `.ne` is base64-wrapped
([recordingCodec.ts:38](src/storage/recordingCodec.ts:38), used by
[RecordingStorage.exportAsFile:268](src/storage/RecordingStorage.ts:268)). That is
+33% file size on disk/network for every recording, plus an expensive encode:
`encodeBase64` builds the payload as a giant JS string via `String.fromCharCode`
chunks ([base64.ts:7](src/core/src/utils/base64.ts:7)) — for a 50 MB stream that's
~67 MB of intermediate string plus `btoa` over it, on top of the stream bytes.

**The binary path already exists.** `useUrlLoader` sniffs the `SCR3` magic and can
stream raw binary today ([useUrlLoader.ts:197](src/hooks/useUrlLoader.ts:197),
[:367](src/hooks/useUrlLoader.ts:367)) — base64 is dead weight the writer keeps
producing and every reader keeps tolerating.

**Plan (no compatibility path — base64 is removed, not bypassed; pairs with P0):**

1. Flip `exportAsFile` to write the raw `Uint8Array` from `encodeRecordingToStream`
   (same `application/octet-stream` blob, same `.ne` extension).
2. Rewrite `RecordingStorage.importFromFile` to read `neFile.arrayBuffer()` and decode
   via `decompressBinaryToRecordings` directly. Bad magic → clear error. This deletes
   the `.text()` read, the whitespace-strip, and the O(n) whole-file base64 regex
   validation ([RecordingStorage.ts:330-345](src/storage/RecordingStorage.ts:330)).
3. In `useUrlLoader`, delete the sniff/text branch entirely: the streaming loop pushes
   response chunks straight into `createStreamingRecordingReader`, and the whole-file
   fallback decodes bytes only ([useUrlLoader.ts:284-396](src/hooks/useUrlLoader.ts:284),
   [:466-474](src/hooks/useUrlLoader.ts:466)). This also removes the sniff-buffer
   bookkeeping and `decodeBase64`'s silent-failure footgun
   ([base64.ts:30](src/core/src/utils/base64.ts:30)) by removing the module.
4. Re-encode `public/introduction.ne` to binary in the same PR (see P0.5); the demo
   then also gets progressive binary streaming with zero text decoding.

**Impact.** −25% export size, −33% download size for URL-loaded recordings, large
export/import CPU+memory win, and three decode entry points collapse into one.
**Effort: small** — net-negative lines. Best value-per-risk item in the list.

---

## P2 — Recording-session accumulation is O(n²) in XState context

**Problem.** Capture appends by spreading arrays inside `assign`:

- frames: `[...context.session.frames, emitted]`
  ([editorMachine.ts:418](src/core/src/machine/editorMachine.ts:418))
- cursor events: `[...cursorEvents, {…}]`
  ([editorMachineHelpers.ts:419](src/core/src/machine/editorMachineHelpers.ts:419)),
  run on **every mouse move** (the 50 ms throttle at
  [editorMachine.ts:385-403](src/core/src/machine/editorMachine.ts:385) gates _frame_
  emission, not cursor-event appends)
- audio fragments: `[...audioFragments, fragment]`
  ([editorMachine.ts:1111](src/core/src/machine/editorMachine.ts:1111))
- every event appender in `recordingSession.ts` clones the session object

A 30-minute session accumulates tens of thousands of cursor events; copying the whole
array per sample is quadratic pointer copies and constant GC churn — exactly the class
of long-recording degradation that already bit the audio path (the quadratic
`decodeAudioData` fix in commit `9eedb99`). It works today; it's the thing that will
fall over first on hour-long recordings.

**Plan.** Make `RecordingSession` an explicitly _mutable capture buffer_ that lives
behind a stable reference, with the machine context holding only the reference plus a
monotonically increasing `revision` counter for change detection:

1. Add `appendFrame/appendCursorEvent/…` methods (or plain functions) on the session
   that `push()` in place. Keep the session object identity stable for the whole
   recording.
2. In `assign` actions, return `{ session, sessionRevision: rev + 1 }` so XState still
   sees a context change without cloning payload arrays. Nothing in the recording
   states reads session arrays reactively — the consumers are `finalizeRecording`
   (one-shot) and `RecordingStreamBridge.sync`, which already reads incrementally by
   index counts ([recordingStreamSink.ts:190](src/storage/recordingStreamSink.ts:190)),
   so in-place growth is exactly what it wants.
3. `finalizeRecording` takes ownership of the arrays directly (no copy needed — the
   session is discarded afterwards).
4. Document the invariant on the type: _arrays are append-only during a session; only
   indices ≤ length observed at read time are stable._

**Impact.** Removes the main long-session scaling cliff in the recorder; also cuts
per-keystroke allocation (each `captureFrame` currently allocates a new session object

- up to three arrays). **Effort: medium** — mechanical but touches many actions;
  `editorMachine.test.ts` already covers the session flows.

---

## P3 — Capture-side CPU: stop re-reading and re-diffing the whole document

**Problem.** Every `CAPTURE_FRAME` — sent on **every keystroke**
([useNextEditor.ts:214](src/core/src/useNextEditor.ts:214)) and every throttled mouse
frame — calls `createFrame`, which does `editor.getValue()` (full document string
copy), `saveViewState()`, and then `createFrameDelta`, which UTF-8-encodes _both_ the
previous and next contents and runs the WASM Myers diff
([editorMachineHelpers.ts:310](src/core/src/machine/editorMachineHelpers.ts:310),
[frameDelta.ts:54-62](src/core/src/utils/frameDelta.ts:54)). For mouse-only frames the
content is unchanged, but proving that costs an O(doc) string equality compare after an
O(doc) `getValue`. On large files this is per-keystroke work proportional to document
size, twice over.

**Plan (tiered — ship tier 1, evaluate tier 2).**

_Tier 1 (cheap, high value): version-gate content work._

1. Record `model.getVersionId()` (and the model URI) in the frame / encoder state at
   capture time.
2. In `createFrame`, when the version id matches the last captured frame's, reuse the
   previous content string (same reference) instead of calling `getValue()`. In
   `createContentDelta`, `prev === next` then short-circuits by _reference_, making
   mouse/selection frames O(1) in document size.
3. Same trick for `viewState`: `saveViewState` + `areStructuredDataEqual` deep-compare
   run per capture; skip when neither version id nor scroll position changed (Monaco
   exposes `onDidScrollChange` — a dirty flag is enough).

_Tier 2 (bigger, optional): event-sourced content deltas._ Monaco's
`onDidChangeModelContent` delivers exact edit ranges. Accumulate them between captures
and synthesize the dmp delta directly (EQUAL/DELETE/INSERT ops around the edited
ranges) instead of running Myers at all — the on-wire format is unchanged, since the
delta format is just an op list. The subtlety is UTF-16→UTF-8 offset conversion (op
lengths are byte lengths); this needs the retained previous-content string to encode
only the affected spans. Worth doing only if tier 1 profiling still shows diff cost on
large documents — Myers on a single contiguous edit is already nearly free because the
affix scans in `lib.rs` strip everything but the changed middle.

**Impact.** Recording CPU on large files drops from O(doc) per keystroke/mouse-frame to
O(edit); less main-thread jank while recording (capture runs on the main thread by
necessity — it reads the live editor). **Effort: tier 1 small, tier 2 medium.**

---

## P4 — Library loading decodes every recording up front

**Problem.** `RecordingStorage.load()` →
`IndexedDBRecordingStore.getAllEntries()` reads **all** stream bytes, camera blobs and
audio blobs for every stored recording into memory, then msgpack-decodes and normalizes
every frame of every recording — just to show a library
([RecordingStorage.ts:183](src/storage/RecordingStorage.ts:183),
[IndexedDBRecordingStore.ts:222](src/storage/IndexedDBRecordingStore.ts:222)). The
per-id primitives already exist (`listMetadata()`, `getEntry(id)`) but nothing uses
`getEntry`.

Also two robustness problems in the same path:

- `getAllEntries` **throws for the whole library** if any single recording's payload is
  missing ([IndexedDBRecordingStore.ts:272-278](src/storage/IndexedDBRecordingStore.ts:272)),
  and `RecordingStorage.load()` catches it and returns `[]`
  ([RecordingStorage.ts:221-224](src/storage/RecordingStorage.ts:221)) — one corrupt
  row silently empties the user's entire library.
- The v-upgrade handler intentionally clears old data; fine as policy, but combined
  with the above, failure modes all look like "my recordings vanished".

**Plan.**

1. Add `RecordingStorage.list(): Promise<StoredRecordingMetadata[]>` (thin wrapper over
   `listMetadata`) and `loadById(id): Promise<Recording | null>` (wrapper over
   `getEntry` + `decodeStoredEntry`).
2. Change the library UI/provider (`NextEditorProvider.loadRecordingsFromStorage`) to
   render from metadata and decode a recording only when the user opens it. Metadata
   already carries name/duration/createdAt/hasAudio/hasCamera/payloadSize — everything
   a list row needs.
3. Make per-entry failures non-fatal: skip the broken entry, return the rest, and
   surface the skipped ids to the caller (e.g. `{ recordings, failedIds }`) instead of
   the current all-or-nothing throw/catch-to-empty.
4. Keep `load()` for compatibility during migration, implemented as
   `list()` + `loadById` fan-out, then delete it once callers move.

**Impact.** Startup no longer scales with library size (bytes in memory drops from
Σ(all recordings + all media blobs) to one metadata array); corruption isolates to one
entry. **Effort: small-medium** (main cost is the UI consumer change).

---

## P5 — The SCR3 footer index is written but never used: range-loaded playback

**Observation.** The container was explicitly designed "append-only, seekable,
range-loadable" — segments carry cluster indices and time ranges, and the footer is a
per-segment byte-offset index ([format.ts:224](src/storage/streamingRecordingCodec/format.ts:224)).
But both decode paths (`decodeRecordingStream`, the incremental reader) always walk the
entire buffer front-to-back; the footer is only used to detect finalization. For
URL-loaded recordings the whole `.ne` must download (or stream past) before late
content is seekable.

**Plan (when long remote recordings become a priority — this is the one item that's a
feature, not a fix).**

1. `fetchRecordingIndex(url)`: HTTP `Range: bytes=-N` for the tail, parse footer →
   `SegmentIndexEntry[]`; `Range: bytes=0-M` for header+meta. (Fallback: hosts without
   range support keep the current streaming path — capability-detect via a 206
   response.)
2. New `ClusterLoader`: given a seek time, resolve the cluster via `meta.clusters`,
   fetch the byte range covering that cluster's segments (index entries are
   per-segment, so ranges coalesce trivially), decode just those segments, and hand
   frames/events to the machine.
3. The machine already supports partial recordings (`EXTEND_RECORDING`, prefix
   playback); the main new requirement is that `frames` may become _sparse by cluster_
   rather than a strict prefix — gate this behind a new `Recording.framesWindow`
   representation or load clusters strictly in order and reuse the existing
   prefix-extension path (simpler; still bounds startup latency by first-cluster size).
4. The footer index currently stores `firstTimestampMs` but the _reader_ mostly needs
   time→offset; entries already have what's needed. No format change required — that's
   the point: the format paid for this two versions ago.

**Impact.** Seek-anywhere playback of long recordings without downloading the whole
stream; startup latency bounded by header+first cluster. **Effort: large** — schedule
deliberately, don't drive-by.

---

## P6 — dmp: delta base-integrity guard via the reserved op tag

**Observation.** `applyDelta` validates delta _structure_ and total source length, but
explicitly cannot detect a same-length base whose bytes differ — EQUAL copies from the
source unconditionally; base integrity is the caller's contract
([lib.rs:593-599](src/core/dmp/src/lib.rs:593)). Given this project's history of
replay-desync bugs (see the preview patch-replay incidents), a wrong-base apply
currently produces _silently corrupted_ reconstructed content instead of an error.

**There is a free extension point:** op tags are `(len << 2) | type` with types 0/1/2;
**type 3 is unused and rejected today** ([lib.rs:192-194](src/core/dmp/src/lib.rs:192),
varint reader treats it as unknown).

**Plan (no legacy deltas to honor — the check op is mandatory, not optional):**

1. Define op type 3 = "check": `(hashLen << 2) | 3` followed by a 4-byte FNV-1a (or
   xxhash32) of the base bytes. `diffDelta` always emits it as the first op; cost is
   4–6 bytes per delta and one linear hash of `a` (can fold into `common_prefix`'s
   byte loop, or accept one extra pass; measure).
2. `applyDelta` pass 1 _requires_ it: missing check op or hash mismatch → `ERR`. No
   absent-op leniency — with P0 there are no pre-check-op deltas left to read.
3. Since the delta bytes change unconditionally, do this together with P0's schema
   collapse: renumber the recording schema to a single version 4 and re-encode
   `public/introduction.ne` once (one transcode covers both changes).
4. Surface the failure distinctly in `dmpCodec.ts` (`"base mismatch"` vs
   `"corrupt delta"`) so replay code can log _which frame_ desynced — turning silent
   corruption into an actionable error with a frame index.
5. Property test in `dmpCodec.test.ts`: random edits, random wrong-base of equal
   length must now error; a delta missing its check op must error.

**Impact.** Converts the worst failure mode of the whole pipeline (silent content
corruption on replay) into a detectable, attributable error, with zero conditional
paths in the hot loop. **Effort: small** once P0 has landed.

Other dmp notes (fine as-is, listed for completeness):

- `diff_bisect` allocates two `Vec`s per bisect level; a reusable scratch arena would
  shave allocator traffic, but capture-path diffs are dominated by the affix scans —
  not worth binary growth unless profiling says otherwise.
- The free-list allocator never coalesces; bounded by per-call working set as
  documented, and the worker is the long-lived host — acceptable.
- Don't add zstd or any runtime-bearing toolchain — `codec-history.md` already covers
  why; per-segment fflate at threshold-32 batching is the right trade.

---

## P7 — Capture timestamps use the wall clock

**Problem.** Session origin and every frame/cursor timestamp derive from `Date.now()`
([editorMachine.ts:223](src/core/src/machine/editorMachine.ts:223),
[:374](src/core/src/machine/editorMachine.ts:374)), while playback timing uses
`performance.now()` ([timelineMachine.ts:78](src/core/src/machine/timelineMachine.ts:78)).
`Date.now()` is not monotonic — NTP slews/steps during a recording produce frames whose
timestamps jump backward or stretch, which the decoder then sorts by timestamp
(reordering real capture order) and the timeline replays with drift. The
preview-replay timeline-drift bug already forced event-time rebasing once; this is the
remaining wall-clock dependency at the source.

**Plan.** Store `startedAtPerf = performance.now()` alongside `startedAt` in the
session; compute all in-session timestamps as `performance.now() - startedAtPerf`.
Keep `startedAt` (wall clock) only as the recording's `createdAt` metadata. Audit the
audio/camera actors for the same pattern (`event.startedAtMs` in `storeCameraStarted`
compares against `session.startedAt` — both sides must move to the same clock).
**Effort: small**, but do it in one PR across all actors so no mixed-clock deltas
exist within a session.

---

## P8 — Machine layer maintainability: extract the playback-audio orchestration

**Problem.** `editorMachine.ts` is 2,126 lines, and the audio-player
spawn/append/seek/rate/volume sequence is duplicated three times with slight variations
(playback entry [editorMachine.ts:1755](src/core/src/machine/editorMachine.ts:1755),
`EXTEND_RECORDING` [:1798](src/core/src/machine/editorMachine.ts:1798), playing entry
[:1967](src/core/src/machine/editorMachine.ts:1967)). The quadratic-audio fix (`9eedb99`)
had to be applied inside one of the three copies — the comment at :1826 documents a bug
class that the duplication invites.

**Plan.**

1. Add `syncPlaybackAudio(context, enqueue, opts: { spawnIfMissing, play, appendPolicy })`
   to `editorMachineHelpers.ts`, encoding the one true sequence (spawn-or-append →
   finalize-if-finalized → seek → rate → volume → play-if-playing). Replace the three
   inline blocks.
2. While there, extract the recording-capture actions and playback-replay actions into
   two sibling modules (the helpers file already hosts the action lists) so the machine
   file reads as pure state wiring — it is close to that already; the remaining bulk is
   the inline `enqueueActions` blocks.
3. Keep xstate + `@xstate/store` as-is (this codebase's conventions are deliberate;
   no library churn).

Smaller machine notes:

- `TICK` runs the full replay-action chain per animation frame; each action early-outs
  on index checks, so cost is fine — but each `assign` allocates. If profiling ever
  shows it, gate the chain on `currentTime` crossing the next pending event/frame
  timestamp (all streams are sorted; the next-due timestamp is a cheap min).
- `stoppingRecording`'s `after: 2000` fallback can finalize without the camera blob if
  the recorder is slow; consider one retry cycle or surfacing a "camera lost" notice —
  currently the video silently disappears from the recording.
- Keyframe cadence quirk: `shouldBeKeyframe` counts _input_ frames; a no-change
  keyframe slot emits nothing, so a seek can have to roll forward up to ~2× the
  interval in deltas. Harmless at 120, worth a comment in `frameStreamEncoder.ts`.

---

## Smaller observations (worth a line each, not a project)

1. **`decodeRecordingStream` vs `decodeRecordingPrefix`** are the same function
   ([decode.ts:289-295](src/storage/streamingRecordingCodec/decode.ts:289)) — keep one,
   alias the other with a doc comment, or give prefix decoding a
   `{ requireFinalized: boolean }` option that actually differs.
2. **`RecordingStorage.importFromFile` duplicates `useUrlLoader.importNextEditorFile`**
   (file picking aside): companion matching, validation, decode. After P1, fold the
   shared part into one helper in `storage/`.
3. **Worker round-trip clones the decoded `Recording`** (comlink structured clone of
   every frame + every `ContentDelta` Uint8Array). If decode-latency of big recordings
   matters, return the raw SCR3 bytes + decode on main… is what we're avoiding; the
   real option is transferring frames as one msgpack buffer and decoding cheaply on
   the main thread. Only if profiling shows the clone dominating.
4. **`reconstructFrameAtIndex` re-normalizes and re-encodes the base per delta step**
   ([frameDelta.ts:289](src/core/src/utils/frameDelta.ts:289)) — each of up to ~120
   steps UTF-8-encodes the whole document. A byte-domain roll-forward (keep the content
   as `Uint8Array` across steps, decode to string once at the end) would make seeks
   O(doc + Σedits) instead of O(doc × steps). Medium effort, contained entirely in
   `frameDelta.ts`; do it if seek latency on large documents is ever felt.
5. **`IndexedDBRecordingStore.appendSegments` derives `seq` from `count()`** — correct
   only because appends are serialized by the caller's write chain; a comment (or
   `IDBCursor`-based max-key) would prevent a future concurrent caller from silently
   interleaving.
6. **`RecordingStorage.getStats`** reports `compressionRatio: "N/A"` and duplicates
   `totalSize`/`compressedSize`; either compute something real from
   `payloadSize` vs frame counts or drop the misleading fields.

## Explicit non-recommendations

- **Do not revisit the codec language or compression again** — `codec-history.md` is
  right; the remaining wins are format-level (P1, P6) and access-pattern-level (P5),
  not implementation-language-level.
- **Do not move frame capture off the main thread** — it reads live Monaco state;
  P3 makes it cheap instead.
- **Do not replace XState** — the machine's problems are size and duplication (P8),
  not the tool.

## Suggested order

| Rank | Item                                                    | Effort | Payoff                                         |
| ---- | ------------------------------------------------------- | ------ | ---------------------------------------------- |
| 1    | P0 legacy-surface deletion                              | S      | one decode path; unblocks P1/P6 as plain edits |
| 2    | P1 binary-only `.ne`                                    | S      | size/CPU on every export & URL load            |
| 3    | P6 dmp base-integrity guard (with P0's schema renumber) | S      | turns silent corruption into errors            |
| 4    | P3 tier 1 version-gated capture                         | S      | recording CPU on large docs                    |
| 5    | P8 audio-orchestration extraction                       | S      | prevents recurrence of a known bug class       |
| 6    | P2 mutable capture buffer                               | M      | long-recording scalability                     |
| 7    | P4 lazy library loading                                 | S–M    | startup memory/time, corruption isolation      |
| 8    | P7 monotonic capture clock                              | S      | recording robustness                           |
| 9    | P5 range-loaded playback                                | L      | feature: instant seek on remote recordings     |

P0, P1, and P6 belong in one PR: they share the single re-encode of
`public/introduction.ne` and together leave exactly one format in the codebase.
