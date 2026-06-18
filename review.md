# SCR3 Data-Model Review — Streaming-Playback Compatibility

**Goal under review:** play a `.ne` (SCR3) recording like a video — start playback
before the whole file is downloaded, and ideally seek without fetching everything.

**Scope:** the SCR3 container and its read/write paths:

- [src/storage/streamingRecordingCodec.ts](src/storage/streamingRecordingCodec.ts)
- [src/storage/recordingStreamSink.ts](src/storage/recordingStreamSink.ts)
- [src/storage/recordingCodec.ts](src/storage/recordingCodec.ts)
- [src/hooks/useUrlLoader.ts](src/hooks/useUrlLoader.ts)
- [src/core/src/machine/audioActor.ts](src/core/src/machine/audioActor.ts) + `getPlaybackAudioState` in [src/core/src/machine/editorMachine.ts](src/core/src/machine/editorMachine.ts)
- [src/components/CameraOverlay.tsx](src/components/CameraOverlay.tsx)

---

## Implementation status (2026-06-19)

| Finding                                 | Status      | Notes                                                                                                                                                                       |
| --------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** Incremental decode               | ✅ Done     | `createStreamingRecordingReader` decodes only new segments; wired into `useUrlLoader` binary path. Covers **L1** and **M4**.                                                |
| **H2** Skip unknown kinds               | ✅ Done     | `walkSegments` skips self-delimiting unknown kinds; reader waits at an ambiguous tail.                                                                                      |
| **M1** u32 offset overflow              | ✅ Done     | `buildFooterChunk` throws past 4 GiB instead of silently clamping.                                                                                                          |
| **M2** Footer false-positive            | ✅ Done     | `findFooterStart` validates `footerLen == 4 + count·13`.                                                                                                                    |
| **L3** Version-number clarity           | ✅ Done     | Documented in the codec header comment.                                                                                                                                     |
| **S1** Loader `response.clone()`        | ✅ Done     | Removed the stream tee that buffered the whole file in memory on the success path; body is streamed directly.                                                               |
| **S2** Base64 path was still O(n²)      | ✅ Done     | Shipped `.ne` files are base64-wrapped, so they took the text path that re-decoded the whole prefix each tick. Both binary and base64 now feed the same incremental reader. |
| **C2** MSE for media (efficiency)       | ⏳ Deferred | Media already plays from a prefix; MSE removes the per-tick whole-blob re-decode. Not a streaming gap.                                                                      |
| **H1** Range-seek client + footer index | ⏳ Deferred | Additive format change; C1 is the enabling prerequisite, now in place.                                                                                                      |
| **M3** Snapshots out of header          | ⏳ Deferred | Format change; lower priority.                                                                                                                                              |
| **L2** Live deflate level               | ⏳ Deferred | Minor; changes output sizes — skipped to avoid churn.                                                                                                                       |

Verification: `tsgo` typecheck clean, `vp lint` clean, and the codec tests pass — including
three new ones asserting (a) the incremental reader matches a one-shot `decodeRecordingStream`
of the same bytes (frames/clusters/tracks/mediaFragments/cursor + audio & camera blob bytes),
(b) a footer-less prefix decodes as a replayable `streamFinalized: false` recording that flips
to finalized once the footer lands, and (c) audio becomes available fragment-by-fragment with a
monotonically-advancing loaded edge (`[400, 800, 1200]` ms) well before the footer arrives —
the exact contract the player gates streamed audio on. (The repo's wider suite has 12
pre-existing test-runner collection failures unrelated to these changes — identical on a clean
tree.)

### S1 — Loader teed the response stream (found in the follow-up pass)

`fetchNextEditorFile` decoded `streamRecordingFromResponse(response.clone())`. Cloning a
`Response` tees its body: every chunk is delivered to both branches, and the unread branch
queues chunks until they are read. On the normal success path only the clone was consumed, so
the original branch buffered the **entire file** in memory — peak memory grew to the whole file
even though playback started early, which directly contradicts the streaming goal. The body is
now consumed directly; the rare post-read failure path re-fetches the URL for the one-shot
fallback instead of relying on a buffered copy.

### What still limits true "play like video" (the deferred items)

- **C2 is an efficiency ceiling, not a streaming gap.** Media already plays from a prefix.
  But `extendRecording` still hands the audio actor a growing blob that `decodeAudioData`
  re-decodes whole each tick, and `CameraOverlay` re-attaches the `<video>` object URL whenever
  new camera bytes arrive. C1 made the editor/event/frame path O(n); MSE would do the same for
  media (append init once + segments as they arrive). First step is confirming the recorder
  emits independently-appendable fragments (the SCR3 `isInit` flag is already in place for it).
- **H1 (network scrub-seek) is now unblocked** by the stateful reader but still unimplemented.

## Verdict

**The container format is well-designed for streaming; the consumption path is not.**

SCR3 is genuinely append-only, self-delimiting (every segment carries its own
`byteLength`), prefix-tolerant, and already encodes the metadata that
streaming/seeking needs: per-segment `startTimeMs`/`endTimeMs`, `clusterIndex`,
`containsKeyframe`, an `isInit` flag for media, and a footer byte-offset index.
The data model anticipated streaming.

The problem is that **playback doesn't take advantage of any of it.** Today the
"streaming" loader re-decodes the entire accumulated buffer from byte 0 on a
fixed byte interval, fully reassembles each media track into one growing `Blob`,
and re-decodes that whole blob through `decodeAudioData` every cycle. That is
quadratic in file size and re-materializes everything repeatedly — it works for
small tutorials but does not scale to "play a long recording like a video," and
true scrub-seek over the network is not implemented at all (the footer index is
written but never read).

The fixes below are mostly in the **reader/playback** layer. Two of them
(C1, C2) are the difference between "decodes progressively" and "streams like
video." A few small **format** additions (H1) unlock network seeking later
without a breaking change.

---

## Critical — blocks video-like streaming

### C1. Prefix decode is O(n²): the whole buffer is re-parsed every interval

`streamRecordingFromResponse` accumulates chunks and, every
`STREAM_DECODE_INTERVAL_BYTES` (512 KB), calls
`decompressBinaryToRecordings(concatByteChunks(binaryChunks, binaryLength))`
([useUrlLoader.ts:214](src/hooks/useUrlLoader.ts:214),
[:264](src/hooks/useUrlLoader.ts:264)). That goes to
`decodeRecordingPrefix` → `decodeSegments`, which **walks from `headerEnd` and
re-inflates + re-msgpack-decodes every segment from the start every time**
([streamingRecordingCodec.ts:705](src/storage/streamingRecordingCodec.ts:705),
[:723](src/storage/streamingRecordingCodec.ts:723)).

For a final size `S` and interval `I`, total decode work ≈ `S²/(2I)`. The
`concatByteChunks` copy at each step ([useUrlLoader.ts:216](src/hooks/useUrlLoader.ts:216))
is itself O(S²). On top of that, every cycle re-sorts all frame/event arrays,
re-derives clusters/tracks/fragments, and re-concatenates **all** media bytes
into fresh blobs ([:777–:886](src/storage/streamingRecordingCodec.ts:777)).

**Impact:** each decode cycle gets longer as more arrives and runs on the main
thread, so playback jank grows with recording length — the opposite of what
streaming should do. A 50 MB file ≈ 100 decode passes over an
ever-growing buffer.

**Fix:** make the reader stateful/incremental. The writer already exposes
`drainPending()` ([streamingRecordingCodec.ts:605](src/storage/streamingRecordingCodec.ts:605));
the reader needs the mirror image — a parser that keeps a byte cursor and
per-array counts, decodes only newly-completed segments, and **appends** to the
existing `Recording` arrays instead of rebuilding from zero. Because segments are
self-delimiting and append-only, this is a clean addition. Then `extendRecording`
receives a small delta rather than a full re-decode. Consider doing the decode in
a worker so deflate/msgpack never blocks paint.

### C2. Media plays from a prefix, but is re-decoded whole each tick instead of fed incrementally

**Correction:** an earlier draft said media "doesn't stream." That is wrong. Audio **does**
play from a prefix — the audio actor runs in `mode: "stream"`, gates playback at the loaded
edge (`loadedUntilMs`), and waits there until more arrives
([audioActor.ts:404](src/core/src/machine/audioActor.ts:404),
[:728](src/core/src/machine/audioActor.ts:728), [:536](src/core/src/machine/audioActor.ts:536));
camera plays the growing blob from a prefix too. The real problem is **efficiency**, not
capability: media is reassembled into a single growing `Blob` per track and re-processed whole
on every tick ([streamingRecordingCodec.ts:797–:810](src/storage/streamingRecordingCodec.ts:797)):

- **Audio:** `audioPlaybackActor.decodeBlob` runs `context.decodeAudioData` on the
  **entire** accumulated blob on every `APPEND_FRAGMENT`
  ([audioActor.ts:587](src/core/src/machine/audioActor.ts:587),
  [:738](src/core/src/machine/audioActor.ts:738)). `decodeAudioData` requires a
  complete container and decodes to in-RAM PCM, so this is O(S²) in CPU and holds
  the whole decoded track in memory (a 20-min track is hundreds of MB of PCM).
- **Camera:** `CameraOverlay` does `URL.createObjectURL(cameraBlob)` on the whole
  reassembled blob and replaces it on every `extendRecording`
  ([CameraOverlay.tsx:127–:140](src/components/CameraOverlay.tsx:127)). Re-setting
  a `<video>` `src` to a new growing blob URL resets the element — visible stutter
  every cycle during playback.

**Impact:** playback starts early and is correct, but the per-tick re-decode/re-attach cost
grows with recording length (audio decode is O(S²) and holds the whole decoded PCM in RAM), and
audio progressiveness depends on the browser tolerating a partial WebM in `decodeAudioData`.
This is the efficiency ceiling on "play a long recording smoothly like video," not a streaming
gap.

**Fix:** drive media through **Media Source Extensions (MSE)**. Append the init
segment once to a `SourceBuffer`, then append each media segment as it arrives —
no full reassembly, no re-decode, native buffering/seeking. The format is already
MSE-shaped: it has an `isInit` flag and `SEGMENT_FLAG_IS_INIT`
([streamingRecordingCodec.ts:52](src/storage/streamingRecordingCodec.ts:52)) plus
per-fragment timestamps. The blocker is capture-side: `MediaRecorder` WebM output
is only MSE-appendable if the first `dataavailable` blob (EBML header + Tracks)
is preserved as the init segment and later blobs are whole clusters. Verify the
recorder is configured so fragments are independently appendable (fragmented
WebM/MP4), and mark the true init fragment explicitly (see H1). If MSE is too big
a step right now, at minimum decode audio **incrementally** and stop recreating
the camera object URL on every extend (only swap when the codec/init actually
changes).

---

## High — needed for seek-without-full-download

### H1. The "seekable, range-loadable" footer index is written but never read, and lacks the fields seeking needs

The header comment advertises a "seekable, range-loadable" container
([streamingRecordingCodec.ts:26](src/storage/streamingRecordingCodec.ts:26)) and
the footer stores a per-segment index
([buildFooterChunk:454](src/storage/streamingRecordingCodec.ts:454)). But:

1. **Nothing reads it.** `decodeSegments` only uses `findFooterStart` to locate
   the segment-area boundary ([:707–:709](src/storage/streamingRecordingCodec.ts:707));
   the index entries are never parsed, and **no code anywhere issues HTTP `Range`
   requests.** The loader always streams forward from byte 0
   ([useUrlLoader.ts:162–:303](src/hooks/useUrlLoader.ts:162)). So "seek to minute
   8 without downloading minutes 0–8" is not possible today.
2. **The index is too thin to seek with.** Each entry is
   `kind u8 | byteOffset u32 | firstTs u32 | firstIdx i32`
   ([:42](src/storage/streamingRecordingCodec.ts:42),
   [INDEX_ENTRY_SIZE = 13](src/storage/streamingRecordingCodec.ts:57)). It omits
   `byteLength`, `endTimeMs`, `clusterIndex`, and `containsKeyframe`. Without
   `containsKeyframe` you can't binary-search to the nearest preceding keyframe
   (mandatory for delta-frame reconstruction); without `byteLength`/`clusterIndex`
   you can't map a target time to a byte range to `Range`-fetch.

**Impact:** the format claims random access but delivers forward-only streaming.

**Fix (no breaking change required):**

- Add `byteLength`, `clusterIndex`, `endTimeMs`, and a flags byte (keyframe/init)
  to each index entry, and record the **media init-segment offset(s)** in the
  footer or header so a seek client can always prepend init bytes before the
  target media range.
- Implement a range-seek client: read the trailer (last 8 bytes give
  `footerLen` → tail `Range` request for the footer), parse the index, then issue
  `Range` requests for [nearest keyframe cluster → target] frame/event segments
  plus [media init + target media range]. Requires the server to support
  `Accept-Ranges: bytes` — note the proxy path
  ([useUrlLoader.ts:42](src/hooks/useUrlLoader.ts:42)) must forward Range headers.

### H2. `walkSegments` aborts on an unknown segment kind — the format is not forward-compatible

`walkSegments` stops the entire walk when `kind > SEGMENT_KIND.cameraChunk`
([streamingRecordingCodec.ts:684](src/storage/streamingRecordingCodec.ts:684)).
Because segments are self-delimiting, an unknown kind could be **skipped** using
its `byteLength`. As written, a newer writer that adds segment kind 10 makes every
older decoder silently drop kind 10 **and everything after it, including the
footer** — the recording looks truncated.

**Fix:** distinguish "truncated tail" from "unknown kind." If `payloadEnd > end`,
break (genuine prefix truncation). If the kind is merely unknown but
`payloadEnd <= end`, skip it (`offset = payloadEnd`) and continue. This keeps
prefix tolerance while making the container forward-compatible.

---

## Medium

### M1. `u32` byte offsets cap the file at 4 GB and clamp silently

Footer `byteOffset` and the segment header length fields are `u32`, run through
`clampU32` ([:149](src/storage/streamingRecordingCodec.ts:149),
[:462](src/storage/streamingRecordingCodec.ts:462)). A recording exceeding 4 GB
(screen + camera + audio over a long session is plausible) silently clamps offsets
to `U32_MAX`, corrupting the index with no error. Timestamps are also `u32` ms
(~49.7-day ceiling — fine in practice). **Fix:** store `byteOffset` as `u53`/two
words or a varint, or at minimum throw when an offset exceeds `U32_MAX` instead of
clamping.

### M2. Footer detection is a heuristic that can false-positive on a prefix

`findFooterStart` declares a footer present whenever the **last 4 bytes** equal
`"SCR3"` and the preceding `u32` points at/after `headerEnd`
([:649–:657](src/storage/streamingRecordingCodec.ts:649)). During download the tail
is high-entropy media bytes; if a prefix happens to end in `53 43 52 33` with a
plausible length word, the decoder treats random bytes as the footer and truncates
the stream (and flips `streamFinalized` to true). Astronomically unlikely per
attempt, but a decode is attempted every 512 KB. **Fix:** validate the candidate
footer — `footerLen == 4 + segmentCount*INDEX_ENTRY_SIZE`, and the first index
entry's `byteOffset == headerEnd` — before trusting it. Optionally add a checksum.

### M3. Large snapshots live in the header and block first paint

`RecordingStreamMeta` embeds full `clusters[]`, `tracks[]`, `slides[]`, and the
potentially large `workspaceSnapshot`/`runtimeSnapshot`
([:78–:96](src/storage/streamingRecordingCodec.ts:78),
[encode at :1032](src/storage/streamingRecordingCodec.ts:1032)). The header must be
fully received before anything decodes; a heavy multi-file workspace snapshot
inflates time-to-first-frame. **Fix:** keep light identity/timing in the header and
move bulky snapshots into a dedicated early segment kind so the header stays small
and the first frame can render before the whole snapshot arrives.

### M4. Errors during streaming decode are swallowed and never recovered

In `decodeAndApplyBinary` / `decodeAndApplyText`, a decode failure is caught and
ignored as "not enough bytes yet" ([useUrlLoader.ts:222](src/hooks/useUrlLoader.ts:222),
[:208](src/hooks/useUrlLoader.ts:208)). A genuinely corrupt mid-file segment (bad
deflate) throws from `inflate` inside `decodeRecords`
([:176](src/storage/streamingRecordingCodec.ts:176)), is indistinguishable from
"incomplete," and stalls progress silently — the user sees playback simply stop
advancing. **Fix:** track the last-good byte cursor; only treat a failure at the
**growing tail** as "incomplete." A failure strictly before the tail is real
corruption and should surface. (Per-segment CRC would make this precise.)

---

## Low / polish

- **L1 — Quadratic isn't only in decode:** `concatByteChunks(binaryChunks, binaryLength)`
  rebuilds the entire buffer each interval ([useUrlLoader.ts:216](src/hooks/useUrlLoader.ts:216)).
  Fixed naturally by the incremental reader (C1) — keep a single growing buffer or
  feed chunks straight into the stateful parser.
- **L2 — Live deflate level 9 on the main thread:** `encodeRecords` uses
  `{ level: 9 }` per segment ([:172](src/storage/streamingRecordingCodec.ts:172)).
  In the live bridge every high-cadence cursor/frame segment is max-deflated
  synchronously while recording. Level 6 (or off-thread) gives most of the size at
  a fraction of the CPU; per-segment deflate also loses cross-segment compression
  (an inherent streaming trade-off worth measuring with `scripts/measure-recording-size.mjs`).
- **L3 — Three "version" numbers:** magic `SCR3`, container `STREAM_FORMAT_VERSION = 2`
  ([:47](src/storage/streamingRecordingCodec.ts:47)), and schema `meta.version: 2 | 3`
  ([:79](src/storage/streamingRecordingCodec.ts:79)). Confusing; document the
  distinction in the header comment.
- **L4 — `decodeRecordingPrefix` and `decodeRecordingStream` are identical**
  ([:896–:902](src/storage/streamingRecordingCodec.ts:896)). The name implies an
  incremental path that doesn't exist yet; once C1 lands, give "prefix" real
  incremental semantics or collapse the alias.

---

## Suggested order of work

1. **C1** — incremental/stateful reader (+ optional worker). Biggest win; everything
   else gets cheaper once decode is a delta.
2. **C2** — MSE for audio/camera (verify fragmented-recorder output; mark init).
   This is what makes media "play like video."
3. **H2 + M2 + M4** — small, high-value robustness fixes to the parser.
4. **H1** — extend the footer index and add a Range-based seek client. This is the
   "scrub a long recording without downloading it all" feature; pure additive
   format change, safe to defer.
5. **M1, M3, L\*** — hardening and polish.

The encouraging part: items 1–3 are all reader-side and need **no format change**,
and item 4 is a backward-compatible footer extension. The byte layout you have is a
good foundation — the work is in teaching the player to consume it incrementally.
