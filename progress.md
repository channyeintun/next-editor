# Progress

## Status

- Task 1: completed
- Task 2: completed
- Task 3: completed
- Task 4: completed

## Notes

- Plan reset on May 10, 2026.
- No tests will be added.
- Task 1 completed: WebContainer preview errors now forward through runtime metadata and land in the runtime dock console.
- Task 2 completed: runtime port open/close events and internal runtime errors now update metadata and appear in the dock UI.
- Task 3 completed: the terminal dock now reuses a persistent shell session, forwards live input, and resizes the terminal with the dock.
- Task 4 completed: runtime preview refresh now uses the WebContainers reload API with a safe URL fallback.
- Post-plan follow-up: workspace recording now keys off `syncVersion`, so replay includes real file-content changes instead of only structural workspace changes.
- Post-plan follow-up: `CMD+S` / `CTRL+S` now creates explicit save checkpoints, and preview/runtime updates plus replayed preview changes follow those checkpoints instead of every edit.
- Post-plan follow-up: starting a recording now refreshes the preview immediately so playback begins from the recording's initial visible result, and the header shortcut label now says refresh instead of save/checkpoint.
- Post-plan follow-up: runtime replay now captures a replayable iframe snapshot so playback start restores the recording's initial preview state instead of leaking the last live runtime result.
- Post-plan follow-up: playback-applied preview HTML now overrides the live runtime iframe immediately, so replay starts from the recorded initial result instead of waiting for the next checkpoint.
- Post-plan follow-up: replayed workspace snapshots now bump saveVersion, so the WebContainer runtime resyncs on replay start and checkpoint transitions instead of staying on the current live workspace result.
