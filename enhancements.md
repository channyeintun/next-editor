# Enhancements

This codebase already has strong building blocks: XState for orchestration, selector-based subscriptions around workspace/editor state, and a clear separation between workspace, playback, and runtime concepts. The highest-payoff improvements are mostly structural. They should reduce replay bugs, make features cheaper to change, and keep performance stable as projects and recordings get larger.

## 1. Break up the editor state machine

Impact: Very high

Why this matters:
- `src/core/src/machine/editorMachine.ts` is about 1,979 lines and owns recording, playback, audio, mouse tracking, frame reconstruction, preview replay, slide replay, workspace replay, runtime replay, and error handling.
- `applyPreviewEventsAtTime`, `applyWorkspaceEventsAtTime`, `applyRuntimeEventsAtTime`, and `applySlideEventsAtTime` all implement variants of the same time-index scanning pattern.
- The same replay action fan-out is repeated across multiple transitions, which raises the cost of every bug fix in playback.

Improvement direction:
- Keep one top-level machine for orchestration only.
- Move preview, workspace, runtime, and slide replay into smaller child actors or pure reducers with one shared timed-event application utility.
- Treat frame playback separately from non-frame state so the editor replay path does not need to coordinate every side channel directly.

Expected payoff:
- Lower regression rate in playback.
- Faster iteration on replay fixes.
- Easier reasoning about seek, pause, stop, and manual override behavior.

## 2. Stop cloning full workspace snapshots on hot paths

Impact: Very high

Why this matters:
- `src/contexts/NextEditorProvider.tsx` captures workspace recordings with `structuredClone(getProject())` inside `getWorkspaceSnapshot()`.
- `src/components/CodeEditor.tsx` records workspace changes whenever the active file or save version changes.
- `src/contexts/WebContainerRuntimeProvider.tsx` also stores `structuredClone(project)` after syncing the runtime workspace.
- These are full-project copies around recording and runtime sync flows, so cost grows with project size instead of with the actual change.

Improvement direction:
- Replace full workspace snapshots with incremental workspace events for common operations such as file content updates, active file changes, file creates, deletes, and renames.
- Keep occasional checkpoints if full reconstruction is still required, but make diffs the default path.
- Reuse project versions or content hashes to skip redundant cloning and runtime sync work.

Expected payoff:
- Better scalability for larger multi-file projects.
- Less GC pressure during recording and save flows.
- Smaller recordings and cheaper replay setup.

## 3. Split the preview system into smaller controllers and cache derived output

Impact: High

Why this matters:
- `src/components/Preview.tsx` is about 1,795 lines and currently mixes static preview generation, runtime preview state, iframe messaging, interaction capture, replay behavior, scroll restoration, placeholder rendering, and UI transitions.
- The component has 11 `useEffect` blocks and several refs used to work around ordering and closure issues.
- `createStaticWorkspacePreview(getProject())` is executed from render-time logic, even though generating the static preview can require parsing HTML and inlining linked assets.

Improvement direction:
- Split the component into a preview controller hook, a static preview renderer, and a runtime preview renderer.
- Memoize compiled static preview output by `previewVersion` or by a content hash instead of rebuilding it on ordinary renders.
- Move iframe event wiring and replay state application into isolated hooks with narrow responsibilities.

Expected payoff:
- Fewer incidental preview regressions.
- Lower render-time cost.
- Much simpler debugging when replay, runtime preview, and manual editing interact.

## 4. Replace the localStorage recording archive with incremental IndexedDB storage

Impact: High

Why this matters:
- `src/storage/JsonStorage.ts` is about 513 lines and stores all recordings as one compressed binary payload that is base64-encoded into localStorage.
- `save()` loads every recording, rebuilds the combined binary blob, and writes the entire archive back.
- `delete()` does the same work again, which makes save/delete cost proportional to the total recording set rather than the one item being changed.
- Audio-heavy recordings are a poor fit for localStorage size limits and string-based persistence.

Improvement direction:
- Store recordings individually in IndexedDB, with small searchable metadata kept separately from large binary payloads.
- Keep the current export/import file format if it is useful, but decouple export format from in-app persistence.
- Separate metadata operations from blob operations so listing recordings does not require full decompression of every payload.

Expected payoff:
- Better reliability for larger recordings.
- Faster save/delete/load operations.
- Less risk of quota failures and UI stalls.

## 5. Replace the registration-by-ref bridge in NextEditorProvider with explicit domain adapters

Impact: High

Why this matters:
- `src/contexts/NextEditorProvider.tsx` maintains a large set of getter and applier refs for slides, preview state, runtime state, and slide navigation.
- `src/contexts/SlidesContext.tsx`, `src/components/Preview.tsx`, and `src/components/TerminalPanel.tsx` register callbacks back into that provider.
- This creates hidden coupling through mutable refs rather than through explicit typed services or domain stores.

Improvement direction:
- Replace the callback registration pattern with explicit domain adapters that are created once and passed into the editor/runtime system.
- Make each domain expose a stable `getSnapshot()` and `applySnapshot()` interface, or move those responsibilities into dedicated stores that the recorder can query directly.
- Reduce the number of mutable refs that exist only to bridge context boundaries.

Expected payoff:
- Fewer lifecycle-ordering bugs.
- Clearer ownership of preview, slides, and runtime state.
- Easier future refactors because dependencies become explicit.

## 6. Separate WebContainer runtime concerns into smaller modules

Impact: Medium to high

Why this matters:
- `src/contexts/WebContainerRuntimeProvider.tsx` is about 1,197 lines and handles booting, filesystem sync, runner lifecycle, terminal lifecycle, preview message forwarding, environment persistence, and recording snapshot support in one place.
- Save-triggered sync currently runs through provider-level effects and shares state with runtime lifecycle concerns.
- The provider is doing too much orchestration and too much concrete work at the same time.

Improvement direction:
- Extract filesystem sync, runner control, terminal session management, and preview message capture into separate modules or hooks.
- Keep the provider focused on composing those pieces and exposing a small public surface.
- Add an explicit sync queue or debounce policy so rapid save bursts do not compete with runtime lifecycle transitions.

Expected payoff:
- Fewer runtime edge-case bugs.
- Easier recovery from failed installs, failed runs, or stale preview state.
- Better maintainability for future runtime features.

## Suggested order

1. Break up the editor machine.
2. Replace full workspace snapshots with incremental recording and sync.
3. Split `Preview` and cache derived static preview output.
4. Move recording persistence to IndexedDB.
5. Replace the registration-by-ref bridge with explicit adapters.
6. Split the WebContainer runtime provider once snapshot and preview responsibilities are narrower.

If only one change is funded, the best single investment is reducing full-project snapshot churn while decomposing the editor playback path. That combination directly affects correctness, performance, and the cost of nearly every future feature in this app.