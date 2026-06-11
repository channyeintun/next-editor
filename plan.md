# Plan: Sidebar Replay, Menu Bounds, and 2x Audio Start

## Summary

Fix three playback/UI issues: record and replay sidebar scroll position, keep the file context menu fully inside the viewport, and remove the remaining audio echo when playback starts at `2x`.

## Key Changes

- Replace the current `plan.md` contents with this plan; the existing file is for the completed xterm work.
- Add optional `sidebarScrollTop` to `WorkspaceRecordingSnapshot` and include it in workspace snapshot equality so scroll-only changes are recorded and replayed.
- Store sidebar scroll in workspace state/actions, update it from `FileSidebar` with throttling, and restore it after `applyWorkspaceSnapshot`/`loadProject` during playback.
- Change `FileSidebar` context menu positioning to use measured menu dimensions plus viewport clamping, with a small margin and `max-height` fallback when the menu is taller than the viewport.
- Update `audioPlaybackActor` so high-speed SoundTouch playback never starts through the native pitch-preserving path first; defer rate application until the SoundTouch/fallback mode is known, disable native pitch preservation for the SoundTouch path before first `play()`, and keep native pitch preservation only for fallback playback.

## Tests

- Extend workspace replay tests for scroll-only snapshots and backward seek restoration.
- Add/extend sidebar menu positioning helper tests for bottom/right viewport clamping.
- Add audio actor regression coverage for `playbackRate: 2` from initial start, including a delayed SoundTouch setup case where `PLAY` must wait for setup and must not use native pitch preservation first.
- Run `bun run test`, `bun run typecheck`, and `bun run lint`.

## Assumptions

- Sidebar scroll means vertical file-tree scroll only, so `sidebarScrollTop` is enough.
- Existing recordings remain compatible by treating missing `sidebarScrollTop` as `0`.
- No recording schema version bump is required because the new snapshot field is optional.
