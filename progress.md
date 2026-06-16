# Stream-Oriented Data Model Progress

Updated: 2026-06-17

## Status

- [x] T1 Create this progress tracker and map the current repo state to the stream plan.
- [ ] T2 Add first-class media fragment metadata to capture and finalization paths.
- [ ] T3 Rewrite SCR3 encode/decode around time-clustered, media-aware segments.
- [ ] T4 Update decode and playback plumbing for the new stream model.
- [ ] T5 Refresh docs, finalize cleanup, and verify the completed plan.

## Current Assessment

- The repo already has append-friendly frame capture, SCR3 streaming, `EXTEND_RECORDING`, and a live recording sink.
- The remaining implementation gap is that media is still captured as plain `Blob[]` and finalized SCR3 layout still appends audio/camera by type instead of by time cluster.
- Prefix decoding still rebuilds an assembled `Recording` from the full prefix and does not yet expose stream deltas or media-fragment-aware playback inputs.

## Next Task

- T2 Add stream-oriented media fragment metadata so audio and camera chunks carry timeline information through finalization.
