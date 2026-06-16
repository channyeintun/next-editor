# Stream-Oriented Data Model Progress

Updated: 2026-06-17

## Status

- [x] T1 Create this progress tracker and map the current repo state to the stream plan.
- [x] T2 Add first-class media fragment metadata to capture and finalization paths.
- [x] T3 Rewrite SCR3 encode/decode around time-clustered, media-aware segments.
- [x] T4 Update decode and playback plumbing for the new stream model.
- [ ] T5 Add stream-aware audio playback actor behavior.
- [ ] T6 Apply the same stream-aware playback treatment to camera where needed.
- [ ] T7 Refresh docs, finalize cleanup, and verify the completed plan.

## Current Assessment

- The repo already has append-friendly frame capture, SCR3 streaming, `EXTEND_RECORDING`, and a live recording sink.
- Audio and camera capture now retain timeline-aware fragment metadata through the recording session and finalized `Recording` facade.
- SCR3 now writes and reads time-clustered media-aware segments in both offline export and live-stream writer paths, while preserving the assembled `Recording` facade.
- The loader now handles both binary SCR3 prefixes and legacy base64 text `.ne` files, and playback only treats blob audio as ready when the stream metadata says the track is complete.
- The remaining implementation gap is inside the media playback surfaces themselves: the audio actor is still blob-only, and camera playback still relies on the finalized blob path.

## Next Task

- T5 Add stream-aware audio playback actor behavior so progressive audio can attach and continue from streamed media fragments instead of waiting for a finalized whole blob.
