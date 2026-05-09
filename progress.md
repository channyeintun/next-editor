# Progress

## Decisions

- Runtime boot policy: boot WebContainers on demand when the workspace mode is entered, not on initial app load.
- Browser policy for the first release: Chromium-based browsers are the primary supported target for WebContainers mode.
- Compatibility policy: keep the existing single-file recorder working while the WebContainers workspace path is added incrementally.

## Phase Status

- Phase 1: Completed
- Phase 2: In progress
- Phase 3: Not started
- Phase 4: Not started
- Phase 5: Not started
- Phase 6: Not started

## Completed Work

- Created the migration plan in `plan.md`.
- Added `@webcontainer/api` to the project dependencies.
- Added cross-origin isolation headers to Vite dev and preview servers.
- Added matching COOP/COEP headers to the Vercel deployment config.
- Validated the Phase 1 changes with `bun run build`.

## Current Task

- Define workspace file-tree types and active-file state.
- Add the first compatibility layer so single-file editing can map into a workspace model.
