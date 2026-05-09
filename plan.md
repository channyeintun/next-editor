# WebContainers Migration Plan

This document is a research plan only. No implementation has been done.

## Verdict

Yes, WebContainers can give next-editor multi-file projects, an in-browser terminal, and SPA projects with npm packages.

The integration is feasible because WebContainers supports:

- booting a browser-side Node runtime
- mounting a full file tree
- running `npm install` and `npm run dev`
- streaming process output for terminal rendering
- exposing a preview URL through the `server-ready` event
- exporting filesystem contents and tearing the runtime down cleanly

This is not a small change. The current app is built around a single Monaco document and a single HTML preview payload, so WebContainers affects the editor model, preview model, and recording/export model.

## What Exists Today

Current architecture findings from the repo:

- `src/components/Preview.tsx` writes editor content directly into `iframe.srcdoc`, which hard-codes a single-document preview model.
- `src/contexts/NextEditorProvider.tsx` exposes one `editorRef`, which implies one active Monaco editor model as the main source of truth.
- `src/core/src/types.ts` defines `Recording.version` as `2` and stores frame state as single `content` strings plus `previewEvents` and `slideEvents`.
- `src/types/slides.ts` defines preview state around `content`, `scrollTop`, `scrollLeft`, and iframe interactions, not around a workspace, file tree, command state, or dev server URL.
- `vercel.json` currently has SPA rewrites but no COOP/COEP headers.
- `vite.config.ts` currently has no dev headers for cross-origin isolation.

## WebContainers Findings

Research notes from the WebContainers docs:

- `WebContainer.boot()` can only create one active instance at a time, so runtime ownership should live in a single top-level service or provider.
- `mount()` accepts a `FileSystemTree`, so the current `.ne` payload can eventually evolve toward a project tree instead of one HTML string.
- `spawn()` runs commands like `npm install` and `npm run dev`, and each process exposes a `ReadableStream<string>` for terminal output.
- `server-ready` emits `(port, url)`, which can drive the preview iframe by URL instead of `srcdoc`.
- `teardown()` allows the runtime to be disposed before booting a new one.
- `export()` can return filesystem data, which is useful for future export flows.
- WebContainers requires cross-origin isolation via `Cross-Origin-Embedder-Policy` and `Cross-Origin-Opener-Policy`.
- Production must be served over HTTPS.
- Browser support is strongest on Chromium-based browsers. Safari and Firefox have caveats, especially around embedded previews and compatibility.

## Recommended Product Shape

Do not try to bolt WebContainers directly into the current `Preview` component.

The cleaner direction is:

1. Introduce a dedicated WebContainer runtime layer.
2. Introduce a workspace/file-tree model above Monaco.
3. Let Monaco edit the currently selected file, not the whole project.
4. Replace `srcdoc` preview with a dev-server URL preview.
5. Treat terminal, preview, and filesystem changes as first-class recording data.

## Proposed Architecture

### 1. Runtime Owner

Create one top-level runtime service or React context responsible for:

- booting WebContainers once
- mounting the current project tree
- spawning install and dev processes
- tracking process lifecycle
- listening for `server-ready`
- exposing terminal output streams
- tearing the container down when switching projects or resetting state

This should not live inside `Preview.tsx`. It belongs beside or under the existing provider layer, because the runtime becomes a shared dependency for editor, terminal, preview, import/export, and recording.

### 2. Workspace Model

Replace the single-document mental model with a workspace shape such as:

- project metadata
- files tree
- active file path
- selected package manager and scripts
- runtime status
- preview URL

Monaco remains the editor UI, but the source of truth becomes `activeFilePath + workspace.files[path]` rather than one `editor.getValue()` string.

### 3. Preview Model

Replace this flow:

- editor content -> `iframe.srcdoc`

With this flow:

- workspace files -> WebContainer filesystem
- `npm install`
- `npm run dev`
- `server-ready` URL -> preview iframe `src`

This is the main boundary change that enables React/Vite/SPA/npm-package projects.

### 4. Terminal Model

Use process output streams from `spawn()` as the backing source for the terminal UI.

Practical direction for later implementation:

- create a terminal panel separate from the preview panel
- pipe `WebContainerProcess.output` into the terminal renderer
- support at least `npm install`, `npm run dev`, and optional ad hoc commands
- persist enough terminal metadata to replay or summarize terminal state during recordings

## Recording And Export Impact

This is the biggest non-UI consequence.

The current recording model is optimized for:

- one content string
- one preview iframe state
- slide interactions
- cursor and editor movement

That is not enough for multi-file projects.

### Required schema shift

Plan for a new recording format version rather than forcing this into version 2.

The new format should be able to represent at least:

- initial project file tree
- active file changes over time
- file create, rename, and delete operations
- active tab/path changes
- terminal commands and terminal output events, or a reduced replay-friendly terminal state model
- preview lifecycle events based on server URL rather than raw HTML `content`
- package install and run command metadata

### Export implications

The current `.ne` export path likely needs to evolve from “compressed recording data” into “compressed project + recording data”.

Two reasonable future directions:

- store the project as a JSON file tree inside `.ne`
- store a WebContainer-exported snapshot plus next-editor recording metadata

The first option is simpler to reason about in your codebase. The second option may be more efficient later.

## Required Hosting Changes

Before any runtime work, hosting must support cross-origin isolation.

### Vite dev server

Add dev headers for:

- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Opener-Policy: same-origin`

### Vercel

Extend `vercel.json` with matching headers on the SPA routes.

### Deployment

- production must stay on HTTPS
- Chromium should be the primary supported browser for the first release
- Safari and Firefox should be treated as follow-up compatibility work unless you explicitly want to accept their current limitations up front

## Suggested Migration Phases

### Phase 1: Platform groundwork

- add WebContainers runtime dependency
- add COOP/COEP headers in dev and production
- define browser support policy
- decide whether the runtime boots on page load or on demand

### Phase 2: Workspace foundation

- define project tree types
- add file explorer state and active file state
- teach Monaco to switch files cleanly
- keep the existing single-file mode working behind a compatibility adapter if needed

### Phase 3: Runtime integration

- boot one WebContainer instance
- mount an in-memory project tree
- run install and dev commands
- expose preview URL and runtime status

### Phase 4: Terminal and preview replacement

- add terminal panel backed by process output
- replace `srcdoc` preview with `server-ready` URL preview
- define refresh/restart semantics for the dev server

### Phase 5: Recording model redesign

- introduce a new recording version
- record filesystem events, active file state, terminal state, and runtime preview state
- update playback to reconstruct a project, not just a document
- update `.ne` import/export compatibility strategy

### Phase 6: Cleanup and compatibility

- define migration behavior for old version 2 recordings
- keep single-file HTML playback working for existing exports
- decide whether multi-file recordings are a new mode or the default mode

## Recommended First Implementation Slice Later

When you move from planning to code, the smallest defensible slice is:

1. Add WebContainers runtime boot behind a dedicated provider.
2. Hard-code a tiny Vite sample project tree in memory.
3. Start `npm install` and `npm run dev`.
4. Point a new preview iframe to the `server-ready` URL.
5. Add a basic read-only terminal output panel.

Do not start with recording or export changes first. Prove the runtime boundary before changing the persistence format.

## Main Risks

- browser compatibility is weaker outside Chromium
- cross-origin isolation is a hard requirement, not an optional optimization
- WebContainer boot is expensive, so lifecycle mistakes will make the app feel slow
- recording complexity increases materially once files, commands, and runtime state become part of playback
- trying to preserve the current preview event model unchanged will create unnecessary complexity

## Recommendation

Proceed only if you want next-editor to become a workspace-based product instead of a single-document recording tool.

If that is the direction, WebContainers is a technically valid foundation.

If you want a smaller step first, keep the existing single-file recorder intact and add WebContainers as a separate experimental workspace mode rather than replacing the current preview path immediately.
