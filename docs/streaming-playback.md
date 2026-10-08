# Streaming Playback Guide

How to **play a recording before its bytes have fully arrived** — progressive playback of a
finalized `.ne` while it downloads.

This is one-way _playback_ streaming (one producer → many viewers, watch-as-it-arrives). It is
**not** collaborative editing / real-time screen sharing.

> The bundled **`introduction.ne`** demo already uses this: opening
> `/code?url=/lessons/introduction/introduction.ne` streams the file and starts showing the
> recording once its first frames have arrived (about 50 KB of the 432 KB) instead of waiting for
> the whole file. See [useUrlLoader.ts](../src/hooks/useUrlLoader.ts).

---

## TL;DR

Yes — you can start playing from a partial download. You do **not** need the whole file.

The recording container (`SCR3`) is an append-only stream, and the incremental reader
[`createStreamingRecordingReader`](../src/storage/streamingRecordingCodec/decode.ts) turns **any
in-order prefix** of those bytes into playable records. Three player actions consume it:

- `loadRecording(recording)` — load the **first** decodable prefix (sets up the timeline).
- `appendRecordingDelta(delta)` — append only records decoded since the last delivery, keeping
  the current time, timeline, and already-applied playback state.
- `extendRecording(recording)` — install the complete immutable snapshot at finalization or apply
  a later metadata/media update.

Both are exposed from the actions hook (`useNextEditorActions`) and used by the shipped
[useUrlLoader.ts](../src/hooks/useUrlLoader.ts).

---

## Why it works

1. **Append-only, prefix-decodable container.** `SCR3` is `header → segments… → footer`. Each
   segment is time-clustered and track-aware: frame/event batches are deflate-compressed, and
   workspace-asset segments carry raw file bytes. Audio and camera are never in the stream; they
   are sibling files. The stateful reader
   [`createStreamingRecordingReader`](../src/storage/streamingRecordingCodec/decode.ts) tolerates a
   **missing footer** (still-writing stream) and a **truncated trailing segment** (mid-download),
   decoding only newly-arrived complete segments on each `push()` call. A segment of a kind this
   build does not know (a newer writer's) is skipped once the footer has arrived. Before that, both
   decoders stop at it, because the first bytes of a partial footer can read as one, so a newer
   writer's file plays only up to its first new-kind segment until its footer arrives.

2. **Forward-only replay.** Playback reconstructs a frame from the nearest keyframe **at or
   before** the target, applying deltas forward
   ([`reconstructFrameAtIndex`](../src/core/src/utils/frameDelta.ts)). Keyframes are emitted at
   least every 120 frames (~2s), so any in-order prefix is self-consistent and replayable. The
   timeline/preview/slide/workspace cursors are all "latest event at-or-before currentTime"
   scans that work on a growing array unchanged.

3. **Every prefix is a superset of the previous one.** `readDelta()` delivers only the new
   frames/events with a monotonic cursor, so the player's applied indices (`lastAppliedFrameIndex`,
   etc.) stay valid while the machine appends records without copying all earlier references.

4. **The header carries the real total duration** for a finalized file. Because the header is at
   the very start of the stream, an early prefix of a finalized recording already knows the full
   timeline length, so the seek bar is correct before all frames have downloaded.

---

## Byte layout (read this first)

A finalized export or saved file
([`encodeRecordingToStream`](../src/storage/streamingRecordingCodec/encode.ts)) writes `SCR3` in
**time-cluster order** after any raw workspace-asset segments: each cluster contains frame and
event batches for that slice of the timeline. Audio and camera remain sibling media files.

---

### Play a finalized `.ne` while it downloads (what `introduction.ne` does)

Stream the bytes with `fetch` and feed each chunk to a
[`createStreamingRecordingReader`](../src/storage/streamingRecordingCodec/decode.ts), then feed the
player `loadRecording` (first), `appendRecordingDelta` (later intervals), and `extendRecording`
(final immutable snapshot). A `.ne` is raw SCR3 bytes end-to-end — the shipped
[useUrlLoader.ts](../src/hooks/useUrlLoader.ts) does not sniff or decode base64 text.

```ts
import { createStreamingRecordingReader } from "../src/storage/streamingRecordingCodec/decode";
import {
  hydrateDecodedRecordingWorkspaceAssets,
  persistDecodedWorkspaceAssets,
  stripRecordingWorkspaceAssets,
} from "../src/storage/recordingWorkspaceAssets";

const reader = createStreamingRecordingReader();
let loadedOnce = false;

async function streamPrefixes(response: Response) {
  const body = response.body;
  if (!body) return;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    reader.push(chunk);
    if (!loadedOnce) {
      const recording = reader.getRecording();
      if (!recording) continue;
      loadRecording(await hydrateDecodedRecordingWorkspaceAssets(recording));
      reader.readDelta(); // records already included in the initial snapshot
      loadedOnce = true;
    } else {
      const delta = reader.readDelta();
      if (delta) {
        await persistDecodedWorkspaceAssets(delta.newWorkspaceAssets);
        appendRecordingDelta({ ...delta, newWorkspaceAssets: [] });
      }
    }
  }
  const finalized = reader.getRecording();
  if (loadedOnce && finalized?.streamFinalized) {
    extendRecording(stripRecordingWorkspaceAssets(finalized));
  }
}
```

The reader discards compressed bytes after their segment is decoded. `byteLength()` tracks total
download progress, while `retainedByteLength()` and `retainedCapacity()` expose the bounded
incomplete tail for diagnostics.

### Wiring into React

```tsx
import { useEffect } from "react";
import { useNextEditorActions } from "../src/hooks/useNextEditorContext";

function useStreamedIntro(url: string, autoplay = false) {
  const { loadRecording, extendRecording, play } = useNextEditorActions();
  useEffect(() => {
    let started = false;
    streamPlay(url, loadRecording, (r) => extendRecording(r), {}).then(() => {
      /* fully loaded */
    });
    // Optionally begin playback as soon as the first prefix is in:
    // wrap loadRecording to call play() once if autoplay.
    void started;
  }, [url]);
}
```

`extendRecording` keeps the current time and applied state, so you can `play()` after the first
prefix and let later prefixes fill in **without any re-seek or visible jump**.

> Tip: whole-file decodes go through `decompressBinaryToRecording`, which runs deflate + msgpack
> **in the codec worker** ([recordingCodecClient.ts](../src/storage/recordingCodecClient.ts)),
> keeping the main thread responsive. Throttle `push()` calls by bytes (above) or time — each
> decode is bounded by newly-arrived segments, not the whole prefix.

---

## Audio and camera behavior (important)

- **Visual playback still streams immediately.** Frames, cursor, rrweb preview snapshots, slides,
  and workspace/runtime state replay from any decodable prefix.
- **Audio and camera never ride the SCR3 stream.** The metadata carries only their references
  (`audioFile`/`audioUrl`, `cameraFile`/`cameraUrl`) and start offsets, so no prefix decode
  produces media bytes. The URL loader resolves them out of band once the `.ne` has loaded: the
  sibling audio is downloaded and attached as `audioBlob` through `extendRecording`, and the
  camera plays from `cameraUrl` in a native `<video>` that range-streams it, with `CameraOverlay`
  deriving video time from `timeline.currentTime - cameraStartOffsetMs`.
- **Captions load out of band.** Inline `captions` arrive with the SCR3 metadata prefix; sibling
  `captionFiles` are fetched separately (relative to the `.ne` URL) and merged via `addCaptionTrack`
  once available, so a long download shows captions as soon as the small sidecar resolves rather than
  waiting on the full recording.

---

## Performance & correctness tips

- **Deliver deltas, not snapshots.** `push()` decodes newly arrived complete segments and
  `readDelta()` slices only records not yet delivered. Call `getRecording()` for the first playable
  prefix, finalization, or another explicit immutable snapshot request (the shipped loader tries
  for the first playable prefix on every chunk until one loads, then polls deltas at roughly
  512 KiB).
- **Persist asset handoffs before playback.** Raw `workspaceAssets`/`newWorkspaceAssets` are
  verified and moved to content-addressed asset storage, then stripped so decoded byte buffers do
  not accumulate in playback state.
- **Decode in the worker.** For whole-file (non-progressive) decodes, prefer
  [`decompressBinaryToRecording`](../src/storage/recordingCodecClient.ts) so deflate stays off
  the main thread.
- **No re-seek needed.** `extendRecording` preserves position; you do **not** reload + `seekTo`.
- **Keyframe cadence = seek granularity.** Keyframes every ≤120 frames bound how early the first
  frame is playable and how cheaply a prefix reconstructs.
- **Final pass.** When the download completes, the last decode reaches the footer, which marks
  the stream finalized (its segment index is read only to tell the stream's own footer from a
  `.ne` file carried inside an asset segment); sibling audio/camera resolution remains out of band.

---

## How `extendRecording` works in the machine

`EXTEND_RECORDING` is handled at the `playback` parent state in
[editorMachine.ts](../src/core/src/machine/editorMachine.ts):

- Both `EXTEND_RECORDING` and `APPEND_RECORDING_DELTA` are guarded by `isForLoadedRecording`:
  the extended recording (or the delta's `recordingId`) must have the loaded recording's `id`.
  Growth from a lesson that is no longer open — a late sibling-audio download after another
  file was imported, for example — is ignored whole, including its audio seek.

- `extendRecording` (action) replaces `context.recording` with the larger prefix. Since it is an
  append-only superset, `lastAppliedFrameIndex` and the other replay cursors remain valid, and
  `timeline.currentTime` is untouched. The one field it does not take from the new recording is
  `captions`: once the loaded recording has caption tracks (sibling `.vtt` files and viewer
  imports arrive through `ADD_CAPTION_TRACK`, outside the stream), that list is kept.
- The replay actions (`applyFrameAtTime`, `applyPreviewEventsAtTime`, …) then run so any
  newly-available frames/events at the current time are applied immediately — but only while the
  replay owns the workspace. Once the viewer has taken it over (`hasManualWorkspaceOverride`:
  always in `paused`, and in `ready`/`ended` after a `WORKSPACE_EVENT`), the detach has reset the
  replay cursors, so growth only updates the recording, the duration and the audio. The next
  `PLAY` or `SEEK` reattaches and applies the new data.
- `EXTEND_RECORDING` also updates media playback. The machine spawns `audioPlayer` when the first
  usable audio prefix appears, and later `EXTEND_RECORDING` events append larger blob snapshots to
  the same actor while preserving time/rate/volume.
- Later playback control sends (`SYNC`, `SEEK`, `SET_SPEED`, `SET_VOLUME`, `PAUSE`) are guarded by
  `playbackAudioSpawned`, not just `recording.audioBlob`, so a partially-downloaded recording can
  play safely before the audio actor exists.

This is purely additive — no delta, codec, or actor redesign — because the replay cursors already
operate on growing arrays.

---

## Seeking lands where playing does

Every replay track keeps one rule: whatever path of ticks, seeks, resumes and streamed appends
brings playback to time T, the track shows what a cold resolve at T shows. Playing forward is only
a faster way to reach the same state. These are the cursor rules that keep it, in
[replayActions.ts](../src/core/src/machine/replayActions.ts):

- **TICK** moves each track forward from its cursor (`lastApplied…EventIndex`). Tracks with
  transient interactions (slide hops, preview clicks) replay every event the tick crosses. For
  them a TICK behind the cursor (the clock moved back without a SEEK) is a resync
  (`isCursorAheadOf`), so it never replays the track from its first event.
- **SEEK**, **PLAY** after a pause, a rewind and a workspace detach reset the cursors together
  with `REPLAY_CURSORS_RESET`. The next apply is then a resync (`isReplayResync` in
  [cursor.ts](../src/core/src/machine/replayState/cursor.ts)). It lands on one state at T and
  never fires a recorded interaction again. Before their first event, the tracks that have a
  baseline apply it on a resync: a closed deck, an empty transcript, an empty board.
- **The workspace cursor is the one exception.** Panel widths replay as offsets added to the
  viewer's own widths, so the replay must know which offsets it has already added.
  `REPLAY_CURSORS_RESET` leaves `lastAppliedWorkspaceEventIndex` alone, and the workspace
  resolver adds or takes away exactly the offsets between that index and T. Only loading or
  clearing a recording resets it. Resetting it on a seek added every offset again, and the panels
  grew without bound.
- **Streamed appends** push records into the same arrays. Every cache on a track (the chat and
  runtime folds, the preview and whiteboard states, the keyframe index) is keyed on its array, and
  the array only grows in place, so an append never makes a cached state wrong. The chat and
  runtime caches hold one fold point, and a backward seek replaces it with an earlier one. Only the
  preview and whiteboard state lists and the keyframe index grow.
- **Checkpoints are only for seeking.** The delta log alone defines every state, and a checkpoint
  equals the fold at its index. So a resolver may restart from the nearest checkpoint at or before
  T instead of applying every delta before it.

The tests that check the rule:

- [pathIndependence.test.ts](../src/core/src/machine/replayState/pathIndependence.test.ts):
  fast-check walks of ticks, seeks, resumes and appends for chat, runtime, workspace (widths and
  files), whiteboard, slides and preview. The state is compared with a cold resolve after every
  move. The walk runs the real actions from replayActions.ts on a context made by
  `createInitialContext`, with fake host hooks that record what each track shows. For each
  trigger it runs the actions in the order editorMachine.ts runs them, read from the machine's
  own state nodes. So the cursor rules above are tested as they are, not as a copy. Each track
  adapter only names the recording field, the host hook that shows the track, and the cold
  resolve. A new trigger, or a new transition that resets replay cursors, must be added to the
  test's `Move` union and `MACHINE_STEPS`, or the property cannot see it.
- [timedIndex.test.ts](../src/core/src/utils/timedIndex.test.ts): the "last event at or before
  T" search that every track uses, checked against a linear scan from every hint.
- [recordingClock.test.ts](../src/core/src/machine/recordingClock.test.ts),
  [mediaSpans.test.ts](../src/core/src/utils/mediaSpans.test.ts) and
  [rrwebPreview.test.ts](../src/components/preview/rrwebPreview.test.ts): the times events are
  placed at. The clock skips pauses exactly, and rrweb events are never placed after their true
  recording time.

Editor frames keep the same rule in `applyFrameAtTime`, but the property test leaves them out,
because that fold needs a Monaco editor. Their reconstruction is checked in
[frameStreamEncoder.test.ts](../src/core/src/utils/frameStreamEncoder.test.ts).

---

## API reference

| Function / type                      | Module                                                                                | Purpose                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `loadRecording(recording)`           | [useNextEditorContext.ts](../src/hooks/useNextEditorContext.ts)                       | Load the first (possibly partial) recording into the player.           |
| `extendRecording(recording)`         | [useNextEditorContext.ts](../src/hooks/useNextEditorContext.ts)                       | Swap in a larger prefix in place, keeping position/timeline.           |
| `createStreamingRecordingReader()`   | [streamingRecordingCodec/decode.ts](../src/storage/streamingRecordingCodec/decode.ts) | Stateful reader: `push(bytes)` + `getRecording()` (missing footer OK). |
| `decodeRecordingStream(bytes)`       | [streamingRecordingCodec/decode.ts](../src/storage/streamingRecordingCodec/decode.ts) | Decode a complete, finalized stream (or any prefix) in one call.       |
| `decompressBinaryToRecording(bytes)` | [recordingCodecClient.ts](../src/storage/recordingCodecClient.ts)                     | Worker-backed binary decode (prefix or full) → `Recording`.            |

A `.ne` is raw SCR3 bytes end-to-end — there is no base64 wrapping to strip. `useNextEditorActions`
(in [useNextEditorContext.ts](../src/hooks/useNextEditorContext.ts)) exposes `loadRecording` /
`extendRecording` to components.
