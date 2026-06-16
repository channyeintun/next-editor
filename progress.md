# Stream-Oriented Data Model Progress

Updated: 2026-06-17

## Status

- [x] T1 Create this progress tracker and map the current repo state to the stream plan.
- [x] T2 Add first-class media fragment metadata to capture and finalization paths.
- [x] T3 Rewrite SCR3 encode/decode around time-clustered, media-aware segments.
- [ ] T4 Update decode and playback plumbing for the new stream model.
- [ ] T5 Refresh docs, finalize cleanup, and verify the completed plan.

## Current Assessment

- The repo already has append-friendly frame capture, SCR3 streaming, `EXTEND_RECORDING`, and a live recording sink.
- Audio and camera capture now retain timeline-aware fragment metadata through the recording session and finalized `Recording` facade.
- SCR3 now writes and reads time-clustered media-aware segments in both offline export and live-stream writer paths, while preserving the assembled `Recording` facade.
- The remaining implementation gap is playback/load plumbing: consumers still load text/base64 `.ne` files and audio playback still keys off the reassembled final blob rather than stream-aware metadata.

## Next Task

- T4 Update loader and playback plumbing so the player consumes the new stream model cleanly, including binary prefixes and stream-aware audio readiness.
