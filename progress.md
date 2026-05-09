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
- Phase 4: In Progress
- Phase 5: In Progress
- Phase 6: In Progress

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
- Promoted the workspace default from a single HTML document to a starter multi-file Vite SPA project tree.
- Added workspace file operations for create, rename, delete, and active-file switching.
- Added a dedicated workspace sidebar so users can manage files directly in the editor layout.
- Synced WebContainer filesystem state to workspace file mutations so runtime preview uses the active project tree instead of a disconnected starter mount.
- Upgraded the terminal panel from read-only output to command execution with cleaned runtime stream rendering.
- Polished the workspace sidebar and terminal chrome to match the rest of the editor UI more closely.
- Validated the workspace UI and runtime sync changes with `bun run build`, `bun run lint`, and a local browser check on `/code`.
- Introduced recording version 3 metadata for workspace and runtime snapshots while preserving version 2 imports.
- Captured workspace and runtime snapshots when recordings are finalized.
- Let the terminal panel fall back to recorded runtime output when no live runtime is active.
- Validated the Phase 5 changes with `bun run build` and `bun run lint`.
- Added explicit recording-version normalization on import/load to keep version 2 and version 3 files supported.
- Kept the single-file preview path as the compatibility fallback for legacy recordings and non-runtime sessions.

## Current Task

- Carry real multi-file workspace behavior through recording and replay, and finish the remaining runtime preview cleanup.
