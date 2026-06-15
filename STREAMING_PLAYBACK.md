# Streaming Playback Guide

How to **play a recording before its bytes have fully arrived** — progressive playback of a
finalized `.ne` while it downloads, or tailing a still-being-recorded broadcast.

This is one-way _playback_ streaming (one producer → many viewers, watch-as-it-arrives). It is
**not** collaborative editing / real-time screen sharing.

---

## TL;DR

Yes — you can start playing from a partial download. You do **not** need the whole file.

The recording container (`SCR3`) is an append-only stream, and the decoder
[`decodeRecordingPrefix`](src/storage/streamingRecordingCodec.ts) turns **any in-order prefix**
of those bytes into a playable `Recording`. Hand that to the player's `loadRecording(...)` and
press play. As more bytes arrive, decode the larger prefix again to extend the timeline.

The one nuance is **continuous** playback while the stream keeps growing — the player loads a
recording as a unit, so extending a _currently playing_ recording means "reload the bigger
prefix, then seek back to the current time" (a buffer‑ahead recipe is below), or a small
optional machine addition. Starting playback early is supported as‑is.

---

## Why it works

1. **Append-only, prefix-decodable container.** `SCR3` is `header → segments… → footer`. Each
   segment (a keyframe-bounded batch of frames, an event batch, or an audio chunk) is
   independently deflate-compressed. [`decodeRecordingPrefix`](src/storage/streamingRecordingCodec.ts)
   tolerates a **missing footer** (still-writing stream) and a **truncated trailing segment**
   (mid-download), decoding every complete segment seen so far. See `walkSegments` /
   `findSegmentsEnd` in [streamingRecordingCodec.ts](src/storage/streamingRecordingCodec.ts).

2. **Forward-only replay.** Playback reconstructs a frame from the nearest keyframe **at or
   before** the target, applying deltas forward ([`reconstructFrameAtIndex`](src/core/src/utils/frameDelta.ts)).
   Keyframes are emitted at least every 120 frames (~2s), so any in-order prefix is
   self-consistent and replayable. The timeline/preview/slide/workspace cursors are all
   "latest event at-or-before currentTime" scans that work on a growing array unchanged.

3. **The header carries the real total duration** for a finalized file. Because the header is
   at the very start of the stream, an early prefix of a finalized recording already knows the
   full timeline length, so the seek bar is correct before all frames have downloaded. (For a
   live broadcast the header duration is `0` and grows as you decode more — see below.)

---

## Byte layout: file vs. live (read this first)

How the bytes are ordered determines what a prefix contains.

- **Finalized export / saved file** ([`encodeRecordingToStream`](src/storage/streamingRecordingCodec.ts)):
  `header → all frame segments → event segments (slide, preview, cursor, …) → audio last`.
  A progressive download therefore yields **all visual frames early**, then cursor/preview
  events, then audio. Great for "watch the typing immediately while audio finishes loading."

- **Live broadcast** ([`RecordingStreamBridge`](src/storage/recordingStreamSink.ts)): segments
  are written **in capture-time order** (frames and events interleaved, audio chunks as they
  arrive). A prefix is a clean "everything up to time _T_" slice — ideal for play-as-it-arrives.

Both are valid `SCR3` and both decode with the same `decodeRecordingPrefix`.

---

## Scenario A — Play a finalized `.ne` while it downloads

Stream the bytes with `fetch`, and every so often decode the accumulated prefix and (re)load it.

> **Import paths.** Code below uses paths relative to the repo root. The codec helpers
> (`decodeRecordingPrefix`, `decompressBinaryToRecordings`), `decodeBase64`, and `useLiveTime`
> are **internal modules** — they are not re-exported from the package barrel (`src/core/src`).
> Import them from their modules (shown), or re-export them from your own entry point. The
> public hooks/types (`useNextEditorActions`, `RecordingStreamSink`) come from the barrel.

```ts
import { decodeRecordingPrefix } from "src/storage/streamingRecordingCodec";
import { decodeBase64 } from "src/core/src/utils/base64";

/**
 * Streams a `.ne` URL and calls `onRecording` with progressively larger Recordings.
 * `.ne` files are base64 text; for a raw SCR3 binary, skip the base64 decode.
 */
export async function streamRecordingForPlayback(
  url: string,
  onRecording: (recording: Recording, done: boolean) => void,
  { minBytesBetweenDecodes = 256 * 1024 } = {},
) {
  const res = await fetch(url);
  if (!res.body) throw new Error("ReadableStream not supported");

  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let lastDecodedAt = 0;

  const decodeNow = (done: boolean) => {
    // `.ne` is base64 text; decode the text we have so far, then SCR3-decode the prefix.
    const text = new TextDecoder().decode(concat(parts, total)).trim();
    const bytes = decodeBase64(text);
    try {
      onRecording(decodeRecordingPrefix(bytes), done);
    } catch {
      /* not enough bytes for the header yet — wait for more */
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
    if (total - lastDecodedAt >= minBytesBetweenDecodes) {
      lastDecodedAt = total;
      decodeNow(false);
    }
  }
  decodeNow(true); // final, complete decode (includes footer + audio)
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
```

> Tip: `decodeRecordingPrefix` runs deflate + msgpack on the calling thread. Throttle by bytes
> (above) or time, and consider running it in the codec worker via
> [`decompressBinaryToRecordings`](src/storage/recordingCodecClient.ts) (it decodes a prefix
> too, returning `[recording]`) to keep the main thread responsive.

### Wiring it into the player (start early, extend smoothly)

`loadRecording(recording)` loads a recording as a unit (it resets the timeline to _ready_). To
**start playing early and keep extending** without a visible jump, reload the larger prefix and
seek back to where playback currently is:

```tsx
import { useEffect, useRef } from "react";
import { useNextEditorActions } from "src/core/src"; // public barrel
import { useLiveTime } from "src/hooks/useNextEditorContext"; // internal hook

function useStreamedPlayback(url: string) {
  const { loadRecording, play, seekTo } = useNextEditorActions();
  const currentTime = useLiveTime(); // live playback position, in ms
  const startedRef = useRef(false);
  const timeRef = useRef(0);
  timeRef.current = currentTime; // keep latest playback position

  useEffect(() => {
    streamRecordingForPlayback(url, (recording) => {
      const resumeAt = timeRef.current;
      loadRecording(recording); // timeline now spans the decoded prefix
      if (resumeAt > 0) seekTo(resumeAt); // restore position after the reload
      if (!startedRef.current) {
        // begin playback as soon as the first prefix loads
        startedRef.current = true;
        play();
      }
    });
  }, [url]);
}
```

Two practical strategies:

- **Buffer-ahead (recommended):** decode a few seconds first, `play()`, and only reload a
  larger prefix when playback approaches the end of what's loaded (a rebuffer), re-seeking to
  the current time. Reloading less often = fewer interruptions.
- **Decode-on-interval:** reload on a fixed cadence (e.g. every 1–2s of downloaded data). Simple,
  but each reload re-seeks, so keep the cadence coarse.

---

## Scenario B — Tail a live broadcast

A producer records and forwards the live `SCR3` byte stream; viewers tail it and play.

### Producer (the machine streams it for you)

Pass a `recordingStreamSink` to the editor config. The provider's
[`useRecordingStreamSink`](src/hooks/useRecordingStreamSink.ts) forwards the live `SCR3` stream
(frames, events, **and audio for both mic and selected-file modes**) as it is captured:

```ts
import type { RecordingStreamSink } from "src/core/src";

const sink: RecordingStreamSink = {
  write(bytes) {
    socket.send(bytes);
  }, // append-only SCR3 chunks, in stream order
  close() {
    socket.close();
  }, // sent after the footer is written
};

// const editor = useNextEditor({ editorRef, recordingStreamSink: sink });
```

The bytes a sink receives are the **same `SCR3` stream** the exporter produces, so a viewer
replays them with exactly the decode path below.

### Viewer (tail + decode prefix)

```ts
import { decodeRecordingPrefix } from "src/storage/streamingRecordingCodec";

const parts: Uint8Array[] = [];
let total = 0;

socket.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
  const chunk = new Uint8Array(ev.data);
  parts.push(chunk);
  total += chunk.length;
  const recording = decodeRecordingPrefix(concat(parts, total)); // header duration grows live
  loadRecording(recording);
  seekTo(currentTimeRef.current); // keep watching where you are
};
```

For a live stream the header `duration` is `0`, so the seek bar grows as frames arrive. If you
want the bar to track the latest captured moment, use the last frame's timestamp as the
effective duration in your UI.

---

## Audio behavior (important)

- **Visual playback streams immediately.** Frames, cursor, preview DOM patches, slides, and
  workspace state all replay from a prefix with no waiting.
- **Microphone audio is WebM/Opus**, which is only fully decodable once its byte sequence is
  complete. In a finalized file the audio sits **at the end**, so the picture plays while audio
  finishes downloading; audio becomes available once its bytes have all arrived. Mid-stream
  audio scrubbing of a partial WebM is not supported by the browser.
- **Selected-file audio** (e.g. an `.mp3`/`.m4a` the user picked) is stored as one chunk, also
  near the end of the stream — same "available once received" behavior.
- The **saved recording and local playback are unaffected**: they always use the finalized
  audio blob. The streamed `audioChunks` exist purely to carry audio to a live viewer.

If you need audio that starts before the visuals finish, fetch/seed the audio source separately
(its own URL) and let the editor play frames from the streamed prefix in parallel.

---

## Performance & correctness tips

- **Throttle re-decodes.** Each `decodeRecordingPrefix` is O(bytes so far). Decode on a byte or
  time threshold, not on every chunk.
- **Offload to the worker** for large recordings via
  [`decompressBinaryToRecordings`](src/storage/recordingCodecClient.ts) so deflate stays off the
  main thread.
- **Minimize reload jank.** Prefer the buffer-ahead strategy; reload + `seekTo(currentTime)`
  only when you actually need more buffer.
- **Keyframe cadence = seek granularity.** Keyframes every ≤120 frames bound how early the first
  frame is playable and how cheaply a prefix reconstructs.
- **Final pass.** When the download completes, do one last decode of the full bytes
  (`decodeRecordingStream` / the worker path) so the footer index and complete audio are used.

---

## Optional: seamless extend without re-seeking

The current player reloads a recording as a unit, hence the reload + `seekTo` pattern. If you
want truly seamless growth (append new segments to an already-playing recording without
touching the timeline position), add an "extend" path to the machine that **appends** decoded
frames/events to `context.recording` and updates `timeline.duration` **without** resetting
`lastApplied*` indices or the current time. The replay cursors already operate on growing
arrays, so this is an additive change — no delta, codec, or actor redesign required. Until then,
the buffer-ahead recipe gives smooth playback in practice.

---

## API reference

| Function                                  | Module                                                               | Purpose                                                          |
| ----------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `decodeRecordingPrefix(bytes)`            | [streamingRecordingCodec.ts](src/storage/streamingRecordingCodec.ts) | Decode any in-order prefix (missing footer / truncated tail OK). |
| `decodeRecordingStream(bytes)`            | [streamingRecordingCodec.ts](src/storage/streamingRecordingCodec.ts) | Decode a complete, finalized stream.                             |
| `decompressBinaryToRecordings(bytes)`     | [recordingCodecClient.ts](src/storage/recordingCodecClient.ts)       | Worker-backed decode (prefix or full) → `Recording[]`.           |
| `RecordingStreamSink`                     | [core types](src/core/src/types.ts)                                  | `{ write(bytes), close() }` live sink interface.                 |
| `UseNextEditorConfig.recordingStreamSink` | [core types](src/core/src/types.ts)                                  | Opt-in: forward the live `SCR3` stream while recording.          |
| `loadRecording(recording)`                | [useNextEditor.ts](src/core/src/useNextEditor.ts)                    | Load a (possibly partial) recording into the player.             |

`decodeBase64` ([base64.ts](src/core/src/utils/base64.ts)) converts `.ne` text to bytes; raw
SCR3 binaries skip it.
