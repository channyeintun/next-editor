# Camera Recording Progress

## Completed

- Phase 1 - Capture and persistence core
  - Added optional camera recording data fields and public config plumbing.
  - Added a video-only camera `MediaRecorder` actor.
  - Wired camera start, chunk capture, stop draining, and finalization into the editor machine.
  - Added SCR3 camera segment encoding/decoding and live stream bridge forwarding.
- Phase 2 - Replay overlay
  - Added a circular camera replay overlay mounted beside the cursor overlay.
  - Synced video play, pause, seek, and speed against the existing playback timeline.
  - Added draggable viewer-side positioning with localStorage persistence.

## Remaining

- Phase 3 - Recording and playback controls.
- Phase 4 - Docs and metadata polish.
