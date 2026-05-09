# Progress

## Decisions

- Runtime boot policy: boot WebContainers on demand when the workspace mode is entered, not on initial app load.
- Browser policy for the first release: Chromium-based browsers are the primary supported target for WebContainers mode.
- Compatibility policy: keep the existing single-file recorder working while the WebContainers workspace path is added incrementally.
- Mode policy: WebContainer multi-file recordings remain opt-in runtime mode, not the default editor path.

## Phase Status

- Phase 1: Completed
- Phase 2: Completed
- Phase 3: Completed
- Phase 4: Completed
- Phase 5: Completed
- Phase 6: Completed

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
- Added a dedicated lazy WebContainer runtime provider with a single-instance boot path.
- Mounted an in-memory Vite starter project inside the runtime and started `npm install` plus `npm run dev`.
- Exposed runtime status, errors, and preview URL through the editor header without changing the legacy iframe preview yet.
- Validated the Phase 3 changes with `bun run build` and `bun run lint`.
- Added a runtime-backed preview bridge that prefers the WebContainer dev-server URL when available.
- Kept the legacy `srcdoc` preview path as the fallback for the existing single-file recording flow.
- Added a read-only terminal panel backed by WebContainer process output.
- Validated the Phase 4 changes with `bun run build` and `bun run lint`.
- Introduced recording version 3 metadata for workspace and runtime snapshots while preserving version 2 imports.
- Captured workspace and runtime snapshots when recordings are finalized.
- Let the terminal panel fall back to recorded runtime output when no live runtime is active.
- Validated the Phase 5 changes with `bun run build` and `bun run lint`.
- Added explicit recording-version normalization on import/load to keep version 2 and version 3 files supported.
- Kept the single-file preview path as the compatibility fallback for legacy recordings and non-runtime sessions.

## Current Task

- All planned phases are complete.
