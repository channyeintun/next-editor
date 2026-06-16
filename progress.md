# Stream-Oriented Data Model Progress

Updated: 2026-06-17

## Status

- [x] T1 Create this progress tracker and map the current repo state to the stream plan.
- [x] T2 Add first-class media fragment metadata to capture and finalization paths.
- [x] T3 Rewrite SCR3 encode/decode around time-clustered, media-aware segments.
- [x] T4 Update decode and playback plumbing for the new stream model.
- [x] T5 Add stream-aware audio playback actor behavior.
- [x] T6 Apply the same stream-aware playback treatment to camera where needed.
- [x] T7 Refresh docs, finalize cleanup, and verify the completed plan.

## Current Assessment

- The repo already has append-friendly frame capture, SCR3 streaming, `EXTEND_RECORDING`, and a live recording sink.
- Audio and camera capture now retain timeline-aware fragment metadata through the recording session and finalized `Recording` facade.
- SCR3 now writes and reads time-clustered media-aware segments in both offline export and live-stream writer paths, while preserving the assembled `Recording` facade.
- The loader now handles both binary SCR3 prefixes and legacy base64 text `.ne` files, and playback only treats blob audio as ready when the stream metadata says the track is complete.
- The audio playback actor now has a stream-aware path that can reattach a growing contiguous blob snapshot and keep syncing against the editor timeline while new audio bytes arrive.
- Camera playback already follows the same progressive pattern through `CameraOverlay`: prefix decode rebuilds a larger `cameraBlob`, and the overlay reattaches that growing blob snapshot while keeping the same React/UI boundary.
- The plan is complete: capture, container, loader, playback plumbing, audio stream mode, camera replay behavior, and docs are aligned around clustered, prefix-decodable SCR3 playback.

## Next Task

- None. Stream-oriented data model plan completed.
