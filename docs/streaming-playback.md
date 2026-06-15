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
   segment (a keyframe-bounded batch of frames, an event batch, or an audio chunk) is
   independently deflate-compressed.
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

How the bytes are ordered determines what a prefix contains.

- **Finalized export / saved file**
  ([`encodeRecordingToStream`](../src/storage/streamingRecordingCodec.ts)):
  `header → all frame segments → event segments (slide, preview, cursor, …) → audio last`.
  A progressive download therefore yields **all visual frames early**, then cursor/preview
  events, then audio. Great for "watch the typing immediately while audio finishes loading."

- **Live broadcast** ([`RecordingStreamBridge`](../src/storage/recordingStreamSink.ts)):
  segments are written **in capture-time order** (frames and events interleaved, audio chunks as
  they arrive). A prefix is a clean "everything up to time _T_" slice — ideal for
  play-as-it-arrives.

Both are valid `SCR3` and both decode with the same `decodeRecordingPrefix`.

---

## Scenario A — Play a finalized `.ne` while it downloads (what `introduction.ne` does)

Stream the bytes with `fetch`, decode the accumulated prefix every so often, and feed the player
`loadRecording` (first) then `extendRecording` (each larger prefix). This is exactly the shipped
[useUrlLoader.ts](../src/hooks/useUrlLoader.ts) `streamRecordingFromResponse`; the condensed
shape:

```ts
import { decodeBase64ToRecordings } from "../src/storage/recordingCodecClient"; // worker-backed

async function streamPlay(
  url: string,
  loadRecording: (r: Recording) => void,
  extendRecording: (r: Recording) => void,
  { intervalBytes = 512 * 1024 } = {},
) {
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const textDecoder = new TextDecoder();
  let base64 = "";
  let lastDecoded = 0;
  let loadedOnce = false;

  const apply = async (final: boolean) => {
    const s = base64.replace(/\s/g, "");
    // base64 decodes in 4-char groups; drop a partial trailing group until the end.
    const aligned = final ? s : s.slice(0, s.length - (s.length % 4));
    if (!aligned) return;
    let recording: Recording | undefined;
    try {
      [recording] = await decodeBase64ToRecordings(aligned);
    } catch {
      return; // header not complete yet — wait for more bytes
    }
    if (!recording) return;
    if (!loadedOnce) {
      loadRecording(recording); // first prefix → set up the timeline
      loadedOnce = true;
    } else {
      extendRecording(recording); // later prefixes → extend in place
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    base64 += textDecoder.decode(value, { stream: true });
    if (base64.length - lastDecoded >= intervalBytes) {
      lastDecoded = base64.length;
      await apply(false);
    }
  }
  base64 += textDecoder.decode();
  await apply(true); // final, complete decode (footer + audio)
}
```

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

## Audio behavior (important)

- **Visual playback streams immediately.** Frames, cursor, preview DOM patches, slides, and
  workspace state all replay from a prefix with no waiting.
- **Audio sits at the end of a finalized file**, so the picture plays while audio finishes
  downloading. When the audio bytes finally arrive, `extendRecording` swaps in the recording
  **with** its audio blob; the player **spawns the audio element lazily the next time playback
  starts** (the `playing` state checks for newly-available audio). So in the common flow — load
  the intro, let it finish downloading, then press play — audio plays normally.
- **Microphone audio is WebM/Opus**, only fully decodable once its byte sequence is complete, so
  mid-stream scrubbing of a partial WebM is not supported by the browser. Audio that arrives
  while already actively playing starts on the next pause→play.
- **Selected-file audio** (an `.mp3`/`.m4a` the user picked) is one chunk, also near the end —
  same "available once received" behavior.
- The **saved recording and local playback are unaffected**: they always use the finalized audio
  blob. The streamed audio chunks exist purely to carry audio to a live viewer.

If you need audio that starts before the visuals finish, fetch/seed the audio source separately
(its own URL) and let the editor play frames from the streamed prefix in parallel.

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
- Audio is spawned lazily on the next `playing` entry (guarded by `playbackAudioSpawned`), which
  covers audio that arrives after the first prefix loaded.

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
