# Progress

## Decisions

- Runtime boot policy: boot WebContainers on demand when the workspace mode is entered, not on initial app load.
- Browser policy for the first release: Chromium-based browsers are the primary supported target for WebContainers mode.
- Compatibility policy: keep the existing single-file recorder working while the WebContainers workspace path is added incrementally.

## Phase Status

- Phase 1: Completed
- Phase 2: Completed
- Phase 3: In progress
- Phase 4: Not started
- Phase 5: Not started
- Phase 6: Not started

## Completed Work

- Created the migration plan in `plan.md`.
- Added `@webcontainer/api` to the project dependencies.
- Added cross-origin isolation headers to Vite dev and preview servers.
- Added matching COOP/COEP headers to the Vercel deployment config.
- Validated the Phase 1 changes with `bun run build`.
- Added workspace project and file types for the upcoming multi-file model.
- Added a workspace provider with active-file state and ref-backed content synchronization.
- Connected Monaco to the workspace compatibility layer without changing the recording engine yet.
- Reused the workspace default document across the editor and recorder reset path.
- Validated the Phase 2 changes with `bun run build`.
- Upgraded Vite to `8.0.11` and Rolldown to `1.0.0`.
- Replaced the ESLint toolchain with Oxlint and removed the ESLint config.
- Updated the Vite checker setup to use TypeScript checks only.
- Validated the toolchain migration with `bun run build` and `bun run lint`.

## Current Task

- Boot a single WebContainer instance behind a dedicated runtime layer.
- Mount an in-memory starter project and expose runtime status.
- Keep the current single-file flow intact while the runtime path is introduced.
