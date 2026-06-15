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
- Phase 3 - Recording and playback controls
  - Added a feature-detected camera toggle to the pre-record controls.
  - Passed per-recording camera enablement through `startRecording`.
  - Added a replay camera show/hide control for recordings with camera media.
- Phase 4 - Docs and metadata polish
  - Added `hasCamera` storage metadata for saved recordings.
  - Documented camera recording fields, camera actor flow, SCR3 camera segments, and self-hosting camera permissions.

## Remaining

- None. The camera recording plan is complete.
