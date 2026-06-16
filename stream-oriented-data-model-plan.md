# Stream-Oriented Data Model Plan

## Decision

Choose the single-file streaming path: keep `.ne` as the complete portable lesson artifact, but redesign the recording data model and SCR3 layout so finalized files are written in playback-time order.

The goal is not to split audio and camera into sidecar files. The goal is a `.ne` file whose prefixes are useful slices of the lesson:

```text
header
track metadata
time cluster 0: editor frames/events + audio fragment + camera fragment
time cluster 1: editor frames/events + audio fragment + camera fragment
...
footer index
```

This aligns live streaming, progressive download, local import, export, and offline playback around one model: decode a growing prefix, append new timeline data, keep playing.

## Why This Is The Right Direction

- It preserves the product promise that one `.ne` is self-contained.
- It fixes the current finalized-file bottleneck at the container layout level instead of working around it with separate delivery assets.
- It makes live and finalized playback converge. Live capture already emits append-only chunks over time; finalized export should preserve that time ordering.
- It gives camera the same streaming treatment as editor frames and audio, instead of appending camera at the very end of long recordings.
- It keeps the existing XState parent machine useful. The rewrite changes media actors and data payloads more than it changes the playback state topology.

## Current Problems To Solve

Current finalized SCR3 export is type-ordered:

```text
header -> all frame segments -> event segments -> audio blob -> camera blob -> footer
```

That means a partial download gives visual playback early, but audio and camera only become available near the tail. The current `Recording` shape also stores finalized media as `audioBlob` and `cameraBlob`, while active recording uses `session.audioChunks` and `session.cameraChunks` only as transient streaming inputs.

The stream-oriented model should promote media chunks from transient session implementation details into first-class timeline track data.

## Non-Goals

- Do not make hosted sidecar audio/video the primary architecture.
- Do not replace `HTMLAudioElement` with Web Audio or WebCodecs as the default audio playback surface.
- Do not put media buffer mechanics directly inside `editorMachine` actions.
- Do not keep relying on one finalized `audioBlob` or `cameraBlob` as the only media representation for streamed playback.

## Compatibility Principle

Audio playback should remain `HTMLAudioElement`-first.

The safe browser-compatibility stack is:

```text
audioPlaybackActor
  blob mode:   HTMLAudioElement + object URL from complete Blob
  stream mode: HTMLAudioElement + MediaSource + SourceBuffer when supported
  fallback:    accumulate fragments, then use complete Blob mode
```

This keeps browser-native codec handling, output routing, autoplay policy, playback rate, volume, and media controls behavior. MediaSource is only the progressive feeding mechanism; the playback surface remains an `HTMLAudioElement`.

Important constraint: do not assume every `MediaRecorder.ondataavailable` Blob is directly appendable to a `SourceBuffer`. The plan must verify whether microphone WebM chunks contain a usable initialization segment and appendable media fragments in the target browsers. If not, add a remux/fragmentation step or fall back to complete Blob playback for that MIME type.

## Proposed Data Model

Introduce a stream-oriented recording model alongside the current assembled `Recording` view.

```ts
type RecordingTrackKind =
  | "editor"
  | "audio"
  | "camera"
  | "cursor"
  | "preview"
  | "workspace"
  | "runtime"
  | "slide";

interface RecordingTrackMeta {
  id: string;
  kind: RecordingTrackKind;
  mimeType?: string;
  codec?: string;
  source?: string;
  startOffsetMs?: number;
  durationMs?: number;
}

interface RecordingClusterMeta {
  index: number;
  startTimeMs: number;
  endTimeMs: number;
  containsKeyframe: boolean;
}

interface RecordingMediaFragment {
  trackId: string;
  clusterIndex: number;
  startTimeMs: number;
  endTimeMs: number;
  bytes: Uint8Array;
  isInit?: boolean;
  isKeyframe?: boolean;
}

interface RecordingStreamDelta {
  clusters: RecordingClusterMeta[];
  frames: DeltaFrame[];
  events: unknown[];
  mediaFragments: RecordingMediaFragment[];
  durationMs: number;
  finalized: boolean;
}
```

The exact names can change during implementation, but the important shift is conceptual: prefix decode should produce a delta of newly available timeline data and media fragments, not only a fully reassembled `Recording` with optional blobs.

## SCR3 Layout Direction

Current SCR3 can stay append-only and footer-indexed, but segment ordering and metadata need to become track-aware and time-clustered.

Recommended stream format versioning:

- Keep old SCR3 decoding for existing version 3 recordings during the transition.
- Introduce a new SCR3 stream format version for time-clustered recordings.
- Introduce a new recording schema version only when the public `Recording` shape changes.

Recommended segment kinds:

```text
metadata/header
clusterStart
frames
slide events
preview events/docs/patches
workspace/runtime events
cursor events
audioInit
audioFragment
cameraInit
cameraFragment
clusterEnd (optional)
footer index
```

Every segment that participates in progressive playback should carry at least:

- track id or kind
- cluster index
- start timestamp
- end timestamp
- payload length
- keyframe/init flags where relevant

The footer remains useful for finalized seek/range loading, but playback must not require it.

## Recording Capture Changes

Recording should keep the current session arrays for frames/events, but media capture should retain chunk metadata that survives finalization.

Required changes:

- Store audio chunks as timeline fragments with MIME type, start time, end time, and bytes or Blob reference.
- Store camera chunks the same way, including `cameraStartOffsetMs`.
- Flush editor frame clusters on keyframe boundaries, as today.
- Align media clusters to the same approximate time windows as editor keyframe clusters when possible.
- Preserve original external audio format when selected-file audio is used, but mark it as complete-blob fallback unless it can be fragmented safely.

The finalized recording should no longer be built by reading one final `audioBlob` and appending it at the end. It should be finalized from the same stream fragments that live capture produced.

## Playback Architecture Changes

Keep the parent XState shape:

```text
editorMachine
  timelineActor
  audioPlaybackActor
  cameraPlaybackActor or CameraOverlay controller
```

Keep parent events where possible:

- `LOAD_RECORDING`
- `EXTEND_RECORDING`
- `PLAY`
- `PAUSE`
- `SEEK`
- `SET_SPEED`
- `SET_VOLUME`
- `STOP`

Change what `EXTEND_RECORDING` carries and does:

```text
EXTEND_RECORDING(delta)
  -> append newly decoded frames/events to replay stores
  -> send APPEND_FRAGMENTS to audioPlaybackActor
  -> send APPEND_FRAGMENTS to camera playback
  -> preserve timeline currentTime and replay cursors
```

The parent machine should orchestrate. Media append queues, SourceBuffer state, media element errors, buffering, and fallback decisions should remain inside media actors.

## Audio Actor Direction

Keep `audioPlaybackActor` centered on `HTMLAudioElement`.

Evolve its input/events from complete-blob-only to dual-mode playback:

```ts
type AudioPlaybackInput =
  | {
      mode: "blob";
      blob: Blob;
      volume: number;
      playbackRate: number;
      startPositionMs: number;
    }
  | {
      mode: "stream";
      mimeType: string;
      volume: number;
      playbackRate: number;
      startPositionMs: number;
    };

type AudioPlaybackEvent =
  | {
      type: "APPEND_FRAGMENT";
      bytes: Uint8Array;
      startTimeMs: number;
      endTimeMs: number;
      isInit?: boolean;
    }
  | { type: "FINALIZE_STREAM" }
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "SEEK"; timeMs: number }
  | { type: "SET_VOLUME"; volume: number }
  | { type: "SET_PLAYBACK_RATE"; rate: number }
  | { type: "SYNC"; timeMs: number };
```

Stream mode should attempt:

```text
new Audio()
MediaSource
SourceBuffer.appendBuffer(fragment)
```

If unsupported or if append fails for the MIME type, the actor should switch to fallback accumulation and report a degraded state to the parent rather than crashing playback.

## Camera Playback Direction

Camera can follow the same track-fragment model, but the UI boundary can stay React-based.

Recommended approach:

- Keep `CameraOverlay` as the visible UI component.
- Introduce a camera playback controller or actor that owns the underlying `HTMLVideoElement` media source when streaming fragments are available.
- Keep `cameraStartOffsetMs` as track metadata.
- Fall back to current complete `cameraBlob` playback when streaming fragments are unsupported.

Camera is optional, so audio should be implemented first and camera should follow after the track model is stable.

## Decoder Direction

Current prefix decoding repeatedly rebuilds a `Recording` from all bytes seen so far. That works, but it becomes expensive and awkward once media fragments are first-class.

Add an incremental decoder state:

```ts
interface Scr3DecodeState {
  bytesConsumed: number;
  tracks: RecordingTrackMeta[];
  clustersDecoded: number;
  frameCount: number;
  eventCounts: Record<string, number>;
}

function decodeNextScr3Prefix(state: Scr3DecodeState, bytes: Uint8Array): RecordingStreamDelta;
```

The decoder should:

- parse only complete new segments
- ignore truncated trailing segments until more bytes arrive
- emit only newly decoded frames/events/fragments
- preserve a path to assemble a full `Recording` for existing UI/storage APIs during migration

## Migration Strategy

Phase 1 should be additive.

- Keep current SCR3 version 3 import/playback working.
- Add the stream-oriented model behind new code paths.
- Make the exporter capable of writing the new time-clustered layout.
- Keep the current `Recording` facade so existing components can keep reading frames/events/duration.

Phase 2 can shift internal playback to stream deltas.

- `LOAD_RECORDING` loads metadata and initial decoded clusters.
- `EXTEND_RECORDING` appends deltas instead of replacing the entire normalized recording.
- Audio uses stream mode where possible, blob mode where required.

Phase 3 can simplify old compatibility code if the product no longer needs to create old layouts.

## Implementation Phases

### Phase 1 - Model And Container

- Define track metadata, cluster metadata, and media fragment types.
- Add SCR3 segment metadata for track id, cluster index, start/end timestamps, and init/keyframe flags.
- Implement time-clustered writer output without changing the player yet.
- Add an assembler that can still produce the existing `Recording` shape from the new stream.

### Phase 2 - Incremental Prefix Decode

- Add decoder state that emits `RecordingStreamDelta` for new complete segments only.
- Update URL loading to use binary SCR3 decode where possible and base64 only for legacy `.ne` text.
- Keep current `decodeRecordingPrefix` as a compatibility wrapper.

### Phase 3 - Parent Machine Integration

- Add a new event or evolve `EXTEND_RECORDING` so it can carry stream deltas.
- Keep replay cursor preservation unchanged for editor frames/events.
- Spawn audio/camera actors based on track metadata, not only final blobs.
- Route media fragments to child actors from playback parent actions.

### Phase 4 - HTMLAudioElement Streaming Actor

- Add audio actor stream mode with `HTMLAudioElement` plus MediaSource when supported.
- Keep blob mode as the compatibility fallback.
- Add append serialization inside the actor so `SourceBuffer` updates never overlap.
- Preserve existing `PLAY`, `PAUSE`, `SEEK`, `SYNC`, `SET_VOLUME`, and `SET_PLAYBACK_RATE` semantics.

### Phase 5 - Camera Streaming

- Add camera track fragments to decode deltas.
- Add a video playback controller that can append fragments or fall back to complete `cameraBlob`.
- Keep `CameraOverlay` responsible for placement, controls, and viewer preferences.

### Phase 6 - Cleanup And Documentation

- Update data-flow, data-structures, state-machines, and streaming-playback docs.
- Mark old finalized-media-tail layout as legacy.
- Document browser support and fallback rules for audio/camera streaming.

## Build/Check Gates

Each phase should keep the repository passing:

```sh
vp check --fix
npm run check
npm run build
```

Browser validation should cover normal Chrome/Safari/Firefox behavior for the selected audio MIME types, with special attention to whether the recorded WebM chunks are appendable through MediaSource.

## Main Risks

- MediaRecorder chunks may not be directly appendable to MediaSource in every browser.
- WebM/Opus support differs between recording, HTMLAudioElement playback, and MediaSource append paths.
- External audio files may not be safely fragmentable without format-specific parsing.
- Prefix decoding can become expensive if it continues to rebuild whole recordings instead of producing deltas.
- Camera streaming may require more browser-specific handling than audio.

## Recommended First Milestone

Start with audio-only stream fragments inside one `.ne` while preserving the existing visual replay path.

Milestone output:

- New SCR3 writer can emit time-clustered audio fragments.
- New decoder can emit incremental audio fragment deltas.
- `audioPlaybackActor` can run in `HTMLAudioElement` blob mode or stream mode.
- Current finalized Blob audio remains the fallback.
- Existing editor frame playback and `EXTEND_RECORDING` cursor preservation stay intact.

After audio is stable, apply the same model to camera.
