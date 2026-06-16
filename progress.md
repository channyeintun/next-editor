# Stream-Oriented Data Model Progress

Updated: 2026-06-17

## Status

- [x] T1 Create this progress tracker and map the current repo state to the stream plan.
- [x] T2 Add first-class media fragment metadata to capture and finalization paths.
- [ ] T3 Rewrite SCR3 encode/decode around time-clustered, media-aware segments.
- [ ] T4 Update decode and playback plumbing for the new stream model.
- [ ] T5 Refresh docs, finalize cleanup, and verify the completed plan.

## Current Assessment

- The repo already has append-friendly frame capture, SCR3 streaming, `EXTEND_RECORDING`, and a live recording sink.
- Audio and camera capture now retain timeline-aware fragment metadata through the recording session and finalized `Recording` facade.
- The remaining implementation gap is in the SCR3 container and playback plumbing: export/decode still use the old type-ordered layout and do not yet preserve stream metadata across import.
- Prefix decoding still rebuilds an assembled `Recording` from the full prefix and does not yet expose stream deltas or media-fragment-aware playback inputs.

## Next Task

- T3 Rewrite SCR3 segment encoding/decoding so finalized recordings are emitted and read in time-cluster order with media-aware metadata.
