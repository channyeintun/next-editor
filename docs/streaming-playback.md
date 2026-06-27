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

The recording container (`SCR3`) is an append-only stream, and the decoder
[`decodeRecordingPrefix`](../src/storage/streamingRecordingCodec.ts) turns **any in-order
prefix** of those bytes into a playable `Recording`. Two player actions consume it:

- `loadRecording(recording)` — load the **first** decodable prefix (sets up the timeline).
- `extendRecording(recording)` — swap in each **larger** prefix **in place**, keeping the
  current time, timeline, and already-applied playback state. Because the stream is append-only,
  every later prefix is a superset of the earlier one, so this never resets playback.

Both are exposed from the actions hook (`useNextEditorActions`) and used by the shipped
[useUrlLoader.ts](../src/hooks/useUrlLoader.ts).

---

## Why it works

1. **Append-only, prefix-decodable container.** `SCR3` is `header → segments… → footer`. Each
   segment is time-clustered and track-aware: frame/event batches stay deflate-compressed while
   audio and camera fragments are stored as raw media bytes.
   [`decodeRecordingPrefix`](../src/storage/streamingRecordingCodec.ts) tolerates a **missing
   footer** (still-writing stream) and a **truncated trailing segment** (mid-download), decoding
   every complete segment seen so far (`walkSegments` / `findSegmentsEnd`).

2. **Forward-only replay.** Playback reconstructs a frame from the nearest keyframe **at or
   before** the target, applying deltas forward
   ([`reconstructFrameAtIndex`](../src/core/src/utils/frameDelta.ts)). Keyframes are emitted at
   least every 120 frames (~2s), so any in-order prefix is self-consistent and replayable. The
   timeline/preview/slide/workspace cursors are all "latest event at-or-before currentTime"
   scans that work on a growing array unchanged.

3. **Every prefix is a superset of the previous one.** Decoding a longer prefix yields the same
   earlier frames/events plus more, so the player's applied indices (`lastAppliedFrameIndex`,
   etc.) stay valid across an `extendRecording` — it swaps the arrays without resetting position.

4. **The header carries the real total duration** for a finalized file. Because the header is at
   the very start of the stream, an early prefix of a finalized recording already knows the full
   timeline length, so the seek bar is correct before all frames have downloaded. (For a live
   broadcast the header duration is `0` and grows as you decode more — see Scenario B.)

---

## Byte layout: file vs. live (read this first)

Both finalized exports and live broadcasts now use the same stream-oriented layout idea:

- **Finalized export / saved file**
  ([`encodeRecordingToStream`](../src/storage/streamingRecordingCodec.ts)) writes `SCR3` in
  **time-cluster order**: each cluster can contain frame batches, event batches, audio
  fragments, and camera fragments for that slice of the timeline.

- **Live broadcast** ([`RecordingStreamBridge`](../src/storage/recordingStreamSink.ts)) writes
  the same segment types as capture progresses, so a prefix is still a clean "everything up to
  time _T_" slice.

Both are valid `SCR3` and both decode with the same `decodeRecordingPrefix`.

---

### Scenario A — Play a finalized `.ne` while it downloads (what `introduction.ne` does)

Stream the bytes with `fetch`, decode the accumulated prefix every so often, and feed the player
`loadRecording` (first) then `extendRecording` (each larger prefix). The shipped
[useUrlLoader.ts](../src/hooks/useUrlLoader.ts) now auto-detects **raw SCR3 bytes vs base64 text**
before choosing the decode path.

```ts
import {
  decodeBase64ToRecordings,
  decompressBinaryToRecordings,
} from "../src/storage/recordingCodecClient";

const SCR3_MAGIC = new Uint8Array([0x53, 0x43, 0x52, 0x33]);

function isScr3(bytes: Uint8Array) {
  return bytes.length >= 4 && SCR3_MAGIC.every((byte, index) => bytes[index] === byte);
}

async function decodePrefix(prefix: Uint8Array | string) {
  return typeof prefix === "string"
    ? decodeBase64ToRecordings(prefix)
    : decompressBinaryToRecordings(prefix);
}
```

The rest of the flow stays the same: decode a growing prefix, call `loadRecording` for the first
playable result, then `extendRecording` for every larger prefix.

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

> Tip: `decodeBase64ToRecordings` runs deflate + msgpack **in the codec worker**
> ([recordingCodecClient.ts](../src/storage/recordingCodecClient.ts)), keeping the main thread
> responsive. Throttle decodes by bytes (above) or time — each decode is O(bytes so far).

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
import { decodeRecordingPrefix } from "../src/storage/streamingRecordingCodec";

const parts: Uint8Array[] = [];
let loadedOnce = false;

socket.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
  parts.push(new Uint8Array(ev.data));
  const recording = decodeRecordingPrefix(concat(parts)); // header duration grows live
  if (!loadedOnce) {
    loadRecording(recording);
    loadedOnce = true;
  } else {
    extendRecording(recording); // no re-seek; keeps the viewer's position
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

- **Throttle re-decodes.** Each decode is O(bytes so far). Decode on a byte or time threshold,
  not on every chunk (the shipped loader uses ~512 KB).
- **Decode in the worker.** Prefer
  [`decodeBase64ToRecordings`](../src/storage/recordingCodecClient.ts) /
  [`decompressBinaryToRecordings`](../src/storage/recordingCodecClient.ts) so deflate stays off
  the main thread.
- **No re-seek needed.** `extendRecording` preserves position; you do **not** reload + `seekTo`.
- **Keyframe cadence = seek granularity.** Keyframes every ≤120 frames bound how early the first
  frame is playable and how cheaply a prefix reconstructs.
- **Final pass.** When the download completes, the last decode includes the footer index and the
  complete audio.

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

| Function / type                           | Module                                                                  | Purpose                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `loadRecording(recording)`                | [useNextEditorContext.ts](../src/hooks/useNextEditorContext.ts)         | Load the first (possibly partial) recording into the player.     |
| `extendRecording(recording)`              | [useNextEditorContext.ts](../src/hooks/useNextEditorContext.ts)         | Swap in a larger prefix in place, keeping position/timeline.     |
| `decodeRecordingPrefix(bytes)`            | [streamingRecordingCodec.ts](../src/storage/streamingRecordingCodec.ts) | Decode any in-order prefix (missing footer / truncated tail OK). |
| `decodeRecordingStream(bytes)`            | [streamingRecordingCodec.ts](../src/storage/streamingRecordingCodec.ts) | Decode a complete, finalized stream.                             |
| `decodeBase64ToRecordings(b64)`           | [recordingCodecClient.ts](../src/storage/recordingCodecClient.ts)       | Worker-backed base64 `.ne` → `Recording[]` (prefix or full).     |
| `decompressBinaryToRecordings(bytes)`     | [recordingCodecClient.ts](../src/storage/recordingCodecClient.ts)       | Worker-backed binary decode (prefix or full) → `Recording[]`.    |
| `RecordingStreamSink`                     | [core types](../src/core/src/types.ts)                                  | `{ write(bytes), close() }` live sink interface.                 |
| `UseNextEditorConfig.recordingStreamSink` | [core types](../src/core/src/types.ts)                                  | Opt-in: forward the live `SCR3` stream while recording.          |

`decodeBase64` ([base64.ts](../src/core/src/utils/base64.ts)) converts `.ne` text to bytes; raw
SCR3 binaries skip it. `useNextEditorActions` (public barrel) exposes `loadRecording` /
`extendRecording` to components.
