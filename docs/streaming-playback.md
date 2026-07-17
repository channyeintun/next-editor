# Streaming Playback Guide

How to **play a recording before its bytes have fully arrived** — progressive playback of a
finalized `.ne` while it downloads, or tailing a still-being-recorded broadcast.

This is one-way _playback_ streaming (one producer → many viewers, watch-as-it-arrives). It is
**not** collaborative editing / real-time screen sharing.

> The bundled **`introduction.ne`** demo already uses this: opening `/code?url=/introduction.ne`
> streams the file and starts showing the recording at ~10% downloaded instead of waiting for
> the whole ~2.4 MB. See [useUrlLoader.ts](../src/hooks/useUrlLoader.ts).

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
   segment is time-clustered and track-aware: frame/event batches stay deflate-compressed while
   audio and camera fragments are stored as raw media bytes. The stateful reader
   [`createStreamingRecordingReader`](../src/storage/streamingRecordingCodec/decode.ts) tolerates a
   **missing footer** (still-writing stream) and a **truncated trailing segment** (mid-download),
   decoding only newly-arrived complete segments on each `push()` call.

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
   timeline length, so the seek bar is correct before all frames have downloaded. (For a live
   broadcast the header duration is `0` and grows as you decode more — see Scenario B.)

---

## Byte layout: file vs. live (read this first)

Both finalized exports and live broadcasts now use the same stream-oriented layout idea:

- **Finalized export / saved file**
  ([`encodeRecordingToStream`](../src/storage/streamingRecordingCodec/encode.ts)) writes `SCR3` in
  **time-cluster order** after any raw workspace-asset segments: each cluster contains frame and
  event batches for that slice of the timeline. Audio and camera remain sibling media files.

- **Live broadcast** ([`RecordingStreamBridge`](../src/storage/recordingStreamSink.ts)) writes
  each workspace asset once before its first referencing event and writes the same frame/event
  segment types as capture progresses, so a prefix is still a clean "everything up to time _T_"
  slice.

Both are valid `SCR3` and both decode with the same incremental reader.

---

### Scenario A — Play a finalized `.ne` while it downloads (what `introduction.ne` does)

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
import { useNextEditorActions } from "../src/core/src"; // public barrel

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

> Tip: whole-file decodes go through `decompressBinaryToRecordings`, which runs deflate + msgpack
> **in the codec worker** ([recordingCodecClient.ts](../src/storage/recordingCodecClient.ts)),
> keeping the main thread responsive. Throttle `push()` calls by bytes (above) or time — each
> decode is bounded by newly-arrived segments, not the whole prefix.

---

## Scenario B — Tail a live broadcast

A producer records and forwards the live `SCR3` byte stream; viewers tail it and play.

### Producer (the machine streams it for you)

Pass a `recordingStreamSink` to the editor config. The provider's
[`useRecordingStreamSink`](../src/hooks/useRecordingStreamSink.ts) forwards the live `SCR3`
stream (frames, events, **and audio for both mic and selected-file modes**) as it is captured:

```ts
import type { RecordingStreamSink } from "../src/core/src";

const sink: RecordingStreamSink = {
  write(bytes) {
    socket.send(bytes); // append-only SCR3 chunks, in stream order
  },
  close() {
    socket.close(); // sent after the footer is written
  },
};

// const editor = useNextEditor({ editorRef, recordingStreamSink: sink });
```

The bytes a sink receives are the **same `SCR3` stream** the exporter produces, so a viewer
replays them with exactly the decode path below.

### Viewer (tail + decode prefix)

```ts
import { createStreamingRecordingReader } from "../src/storage/streamingRecordingCodec/decode";
import {
  hydrateDecodedRecordingWorkspaceAssets,
  persistDecodedWorkspaceAssets,
} from "../src/storage/recordingWorkspaceAssets";

const reader = createStreamingRecordingReader();
let loadedOnce = false;

socket.onmessage = async (ev: MessageEvent<ArrayBuffer>) => {
  reader.push(new Uint8Array(ev.data));
  if (!loadedOnce) {
    const recording = reader.getRecording();
    if (!recording) return;
    loadRecording(await hydrateDecodedRecordingWorkspaceAssets(recording));
    reader.readDelta();
    loadedOnce = true;
  } else {
    const delta = reader.readDelta();
    if (delta) {
      await persistDecodedWorkspaceAssets(delta.newWorkspaceAssets);
      appendRecordingDelta({ ...delta, newWorkspaceAssets: [] });
    }
  }
};
```

For a live stream the header `duration` is `0`, so the seek bar grows as frames arrive. If you
want the bar to track the latest captured moment, use the last frame's timestamp as the
effective duration in your UI.

---

## Audio and camera behavior (important)

- **Visual playback still streams immediately.** Frames, cursor, rrweb preview snapshots, slides,
  and workspace/runtime state replay from any decodable prefix.
- **Audio now rides the same clustered stream model.** Later prefixes extend the recording's
  audio coverage and rebuild a larger contiguous blob snapshot. The `audioPlaybackActor` keeps
  using `HTMLAudioElement`, but in stream mode it can reattach that growing blob, seek back to the
  current editor time, and continue playback without resetting the lesson timeline.
- **Microphone audio is still browser-decoded media.** For WebM/Opus specifically, a prefix is
  only useful once the bytes up to the current playback point are decodable as one contiguous
  region, so stream mode improves availability but does not magically make arbitrary partial WebM
  seeks free.
- **Selected-file audio** remains a valid track source and follows the same playback surface.
- **Camera follows the same progressive pattern through `CameraOverlay`.** Prefix decode rebuilds a
  larger `cameraBlob`, and the overlay swaps to the new object URL while still deriving video time
  from `timeline.currentTime - cameraStartOffsetMs`.
- **Captions load out of band.** Inline `captions` arrive with the SCR3 metadata prefix; sibling
  `captionFiles` are fetched separately (relative to the `.ne` URL) and merged via `addCaptionTrack`
  once available, so a long download shows captions as soon as the small sidecar resolves rather than
  waiting on the full recording.

---

## Performance & correctness tips

- **Deliver deltas, not snapshots.** `push()` decodes newly arrived complete segments and
  `readDelta()` slices only records not yet delivered. Call `getRecording()` for the first playable
  prefix, finalization, or another explicit immutable snapshot request (the shipped loader polls
  deltas at roughly 512 KiB).
- **Persist asset handoffs before playback.** Raw `workspaceAssets`/`newWorkspaceAssets` are
  verified and moved to content-addressed asset storage, then stripped so decoded byte buffers do
  not accumulate in playback state.
- **Encode live segments in the codec worker.** The bridge coalesces capture notifications and
  permits one ordered worker encode plus sink write in flight. Finalization awaits the worker's
  final metadata/footer response, so no queued segment can land after the sink closes.
- **Decode in the worker.** For whole-file (non-progressive) decodes, prefer
  [`decompressBinaryToRecordings`](../src/storage/recordingCodecClient.ts) so deflate stays off
  the main thread.
- **No re-seek needed.** `extendRecording` preserves position; you do **not** reload + `seekTo`.
- **Keyframe cadence = seek granularity.** Keyframes every ≤120 frames bound how early the first
  frame is playable and how cheaply a prefix reconstructs.
- **Final pass.** When the download completes, the last decode includes the footer index and
  authoritative final metadata; sibling audio/camera resolution remains out of band.

---

## How `extendRecording` works in the machine

`EXTEND_RECORDING` is handled at the `playback` parent state in
[editorMachine.ts](../src/core/src/machine/editorMachine.ts):

- `extendRecording` (action) replaces `context.recording` with the larger prefix. Since it is an
  append-only superset, `lastAppliedFrameIndex` and the other replay cursors remain valid, and
  `timeline.currentTime` is untouched.
- The replay actions (`applyFrameAtTime`, `applyPreviewEventsAtTime`, …) then run so any
  newly-available frames/events at the current time are applied immediately.
- `EXTEND_RECORDING` also updates media playback. The machine spawns `audioPlayer` when the first
  usable audio prefix appears, and later `EXTEND_RECORDING` events append larger blob snapshots to
  the same actor while preserving time/rate/volume.
- Later playback control sends (`SYNC`, `SEEK`, `SET_SPEED`, `SET_VOLUME`, `PAUSE`) are guarded by
  `playbackAudioSpawned`, not just `recording.audioBlob`, so a partially-downloaded recording can
  play safely before the audio actor exists.

This is purely additive — no delta, codec, or actor redesign — because the replay cursors already
operate on growing arrays.

---

## API reference

| Function / type                           | Module                                                                                | Purpose                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `loadRecording(recording)`                | [useNextEditorContext.ts](../src/hooks/useNextEditorContext.ts)                       | Load the first (possibly partial) recording into the player.           |
| `extendRecording(recording)`              | [useNextEditorContext.ts](../src/hooks/useNextEditorContext.ts)                       | Swap in a larger prefix in place, keeping position/timeline.           |
| `createStreamingRecordingReader()`        | [streamingRecordingCodec/decode.ts](../src/storage/streamingRecordingCodec/decode.ts) | Stateful reader: `push(bytes)` + `getRecording()` (missing footer OK). |
| `decodeRecordingStream(bytes)`            | [streamingRecordingCodec/decode.ts](../src/storage/streamingRecordingCodec/decode.ts) | Decode a complete, finalized stream (or any prefix) in one call.       |
| `decompressBinaryToRecordings(bytes)`     | [recordingCodecClient.ts](../src/storage/recordingCodecClient.ts)                     | Worker-backed binary decode (prefix or full) → `Recording[]`.          |
| `RecordingStreamSink`                     | [core types](../src/core/src/types.ts)                                                | `{ write(bytes), close() }` live sink interface.                       |
| `UseNextEditorConfig.recordingStreamSink` | [core types](../src/core/src/types.ts)                                                | Opt-in: forward the live `SCR3` stream while recording.                |

A `.ne` is raw SCR3 bytes end-to-end — there is no base64 wrapping to strip. `useNextEditorActions`
(public barrel) exposes `loadRecording` / `extendRecording` to components.
