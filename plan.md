# NextEditor XState React Migration Plan

## Goal

Replace the custom `NextEditor` state contexts with `@xstate/react` actor context where it improves clarity and keeps the current rendering behavior.

## Scope

- Migrate `NextEditorProvider` to use `createActorContext(editorMachine)`.
- Replace `NextEditorMetadataContext` and `NextEditorPlaybackContext` reads with actor-context selectors.
- Keep the stable non-actor bridge APIs in plain React context only where they are not machine state.
- Preserve the current public hook surface used by components.

## Non-goals

- Do not rewrite `WorkspaceProvider` to XState.
- Do not rewrite `WebContainerRuntimeProvider` to XState.
- Do not add tests.

## Task Breakdown

### Task 1: Create migration docs
- Add `plan.md` and `progress.md`.
- Record the scoped decision so execution stays narrow.

### Task 2: Add actor context for NextEditor
- Create a dedicated actor context for `editorMachine` using `createActorContext`.
- Update `NextEditorProvider` to provide the machine through actor context with `options={{ input: ... }}`.
- Keep auxiliary registration/storage APIs in a small plain context.

### Task 3: Switch hooks and exports
- Update `useNextEditorContext.ts` to read metadata and playback values from actor selectors instead of custom state contexts.
- Keep action helpers stable and route event sends through the actor ref.
- Remove obsolete `NextEditorMetadataContext` and `NextEditorPlaybackContext` exports if they are no longer needed.

### Task 4: Validate and finish
- Run formatting on changed code files.
- Run `bun run typecheck`.
- Run `bun run build`.
- Update `progress.md` and commit each completed task with git CLI.

### Task 5: Prevent Replay Preview Flash
- Stop replayed workspace snapshots from syncing the live WebContainer preview during playback.
- Keep recorded workspace/file switches visible in the editor without triggering runtime refreshes.
- Validate with `bun run typecheck` and `bun run build`.

### Task 6: Stop Replay Provider Rerenders
- Remove the `NextEditorProvider` subscription to active-file changes during playback.
- Read the active file path through a workspace getter when recording snapshots.
- Validate with `bun run typecheck` and `bun run build`.

## Validation Strategy

- Primary check after code changes: `bun run typecheck`
- Secondary check: `bun run build`

## Working Rules

- Follow this plan in order.
- After each completed task, update `progress.md`, format touched code, and create a git commit.
- Keep changes minimal and avoid widening scope.