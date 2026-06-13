# Memory Leak Fix Progress

Date: 2026-06-14

## Plan

- [x] Fix recording mouse tracking cleanup across iframe document changes.
- [ ] Dispose Monaco playback models when playback/unmount no longer needs them.
- [ ] Add explicit cleanup for injected static iframe interaction listeners.

## Current Evaluation

- Plan is not complete. Task 1 is complete and ready to commit after the required validation loop.
- Runtime preview snapshot size and recording data retention are not changed because they are intentional replay data paths and need separate product tradeoff decisions.
- The app-lifetime recording codec worker is not changed because the review rates it low severity and likely intentional for this app lifecycle.

## Completed Tasks

### 1. Recording iframe mouse tracking cleanup

- Stored the exact iframe document used for mouse listener attachment so cleanup removes listeners from the same document after iframe navigation.
- Removed capture-phase listeners with the matching capture flag.
- Replaced stale iframe window mappings when an iframe navigates and cleared the reverse window map during cleanup.
- Validation passed with `bun run check --fix`, `bun run format`, `bun run lint`, `bun run check`, and `bun run build`.
