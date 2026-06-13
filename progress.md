# Memory Leak Fix Progress

Date: 2026-06-14

## Plan

- [x] Fix recording mouse tracking cleanup across iframe document changes.
- [x] Dispose Monaco playback models when playback/unmount no longer needs them.
- [x] Add explicit cleanup for injected static iframe interaction listeners.

## Current Evaluation

- Plan is complete. All selected memory-leak review fixes are validated and committed.
- Runtime preview snapshot size and recording data retention are not changed because they are intentional replay data paths and need separate product tradeoff decisions.
- The app-lifetime recording codec worker is not changed because the review rates it low severity and likely intentional for this app lifecycle.

## Completed Tasks

### 1. Recording iframe mouse tracking cleanup

- Stored the exact iframe document used for mouse listener attachment so cleanup removes listeners from the same document after iframe navigation.
- Removed capture-phase listeners with the matching capture flag.
- Replaced stale iframe window mappings when an iframe navigates and cleared the reverse window map during cleanup.
- Validation passed with `bun run check --fix`, `bun run format`, `bun run lint`, `bun run check`, and `bun run build`.

### 2. Monaco playback model cleanup

- Added a playback-model disposal helper for Monaco models under the replay URI root.
- Disposed stale playback models after the editor switches back to a normal workspace model and on editor unmount.
- Kept the current playback model alive while playback still owns the active editor model.
- Validation passed with `bun run check --fix`, `bun run format`, `bun run lint`, `bun run check`, and `bun run build`.

### 3. Static iframe interaction capture cleanup

- Added an injected cleanup function keyed by the setup marker so parent cleanup can remove iframe interaction listeners from the owning window/document.
- Restored wrapped `history.pushState` and `history.replaceState` methods when cleanup runs.
- Cancelled pending mouse and scroll animation frames so detached iframe documents do not keep event targets alive longer than needed.
- Validation passed with `bun run check --fix`, `bun run format`, `bun run lint`, `bun run check`, `bun run build`, and a generated-script syntax check.
