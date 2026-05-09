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
- Reworked the workspace sidebar to use inline create and rename flows plus per-file hover actions instead of prompt-driven file management.
- Added first-class workspace folder state so empty folders can be created and kept in the project tree.
- Rebuilt the sidebar into a folder-aware tree with dedicated `new file` and `new folder` controls.
- Added a right-click file context menu with `New File`, `New Folder`, `Copy Path`, `Copy Relative Path`, `Rename`, and `Delete File` actions.
- Changed rename to a buttonless inline text selection flow that highlights the editable filename portion instead of opening a save/cancel editor.
- Synced WebContainer filesystem state to workspace file mutations so runtime preview uses the active project tree instead of a disconnected starter mount.
- Synced explicit folder creation into the WebContainer filesystem so empty directories are represented in the runtime too.
- Upgraded the terminal panel from read-only output to command execution with cleaned runtime stream rendering.
- Replaced the floating terminal card with a bottom runtime dock that exposes `Runner`, `Terminal`, and `Console` tabs without changing the rest of the editor chrome.
- Polished the workspace sidebar and terminal chrome to match the rest of the editor UI more closely.
- Fixed the sidebar row structure and dock placement after browser validation so footer tabs do not block file actions.
- Validated the workspace UI and runtime sync changes with `bun run build`, `bun run lint`, and a local browser check on `/code`.
- Introduced recording version 3 metadata for workspace and runtime snapshots while preserving version 2 imports.
- Captured workspace and runtime snapshots when recordings are finalized.
- Let the terminal panel fall back to recorded runtime output when no live runtime is active.
- Validated the Phase 5 changes with `bun run build` and `bun run lint`.
- Added explicit recording-version normalization on import/load to keep version 2 and version 3 files supported.
- Kept the single-file preview path as the compatibility fallback for legacy recordings and non-runtime sessions.
- Reworked the runner dock to match the footer-style `Runner`, `Terminal`, and `Console` layout more closely, including a collapsible shell-like terminal view.
- Added configurable runner settings for `Enable Runner`, `Run on startup`, `Run on file-save`, `Init Command`, and `Run Command`.
- Moved the runner settings popover above the dock and removed the dock clipping so the full config panel stays visible.
- Converted the runner settings UI into a full-page overlay modal with a dimmed backdrop instead of a dock-local popover.
- Removed the modal title bar and bottom close action so the runner settings overlay uses only the backdrop for dismissal.
- Fixed the sidebar inline create and rename input so the default filename selection happens only when the input opens, not on every keystroke.
- Added explicit workspace save persistence so `CMD+S` stores the current project and active file in local storage before triggering any runtime save behavior.
- Changed file-save behavior so an already running WebContainer dev server is not restarted on save, allowing preview updates to come through normal hot reload instead of flashing the fallback source preview.
- Fixed the Monaco listener lifecycle by rebinding editor listeners on every mount, so newly switched files start syncing immediately and no longer revert when you leave and reopen them.
- Added sidebar unsaved indicators driven by workspace dirty-file tracking, so files show a dot while their content differs from the last saved workspace snapshot.
- Replaced the runtime-start fallback preview with a dedicated runtime placeholder so booting/installing/starting states no longer render raw source code under the "Single-file preview" label.
- Simplified the non-ready runtime placeholder to a plain spinner, keeping raw source hidden while the WebContainer preview is still booting.
- Added `Edit Environment` and `Download As Zip` toolbar actions so the workspace can jump straight into `package.json` and export the current multi-file project as a zip archive.
- Corrected `Edit Environment` so it now edits WebContainer Node env values via a modal and injects them into every spawned runtime command instead of opening `package.json`.
- Moved rerun into the editor header with a dedicated `CMD+S to save` hint and removed the extra runtime toolbar controls.
- Restored the original editor header layout so the save hint and rerun button are additive controls instead of a full toolbar replacement.
- Simplified the sidebar header to only show `FILES`, `Create file`, and `Create folder` controls without the extra description chrome.
- Collapsed `Edit Environment` and `Download As Zip` behind a settings icon popup and reduced the environment modal header to only `Edit Environment`.
- Added workspace lesson types so users can switch between `SPA Lesson` and `HTML/CSS Lesson`, with HTML/CSS lessons using static preview and hiding runner and terminal UI.
- Added `Open in Preview` to the file context menu for HTML/CSS lessons and switched the save hint to `CMD+S` or `CTRL+S` based on the current user agent.
- Fixed HTML/CSS preview refresh so it stays pinned to the selected preview file instead of falling back to the active editor buffer.
- Added `New Editor` to the settings popup so users can discard the current workspace after confirmation and reset to a fresh single-file `index.html` editor.

## Current Task

- Latest follow-up completed: the settings popup now includes `New Editor`, which confirms before discarding the current workspace and resets to a fresh `index.html` editor.
