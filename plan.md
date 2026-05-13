# @xstate/store Review Plan

## Findings

### 1. Workspace provider is the strongest migration target
- Current shape: manual external-store plumbing with many slice contexts and `useSyncExternalStore` hooks.
- Recommendation: migrate workspace state to a single `@xstate/store-react` store while preserving the existing `useWorkspace*` hook surface and explicit save semantics.
- Acceptance: workspace selectors continue to expose the same derived values, and save/dirty behavior remains explicit rather than auto-persisted.

### 2. Slides state is replaceable but lower priority
- Current shape: simple local React state with localStorage persistence.
- Recommendation: defer for now. Revisit only after the workspace migration lands cleanly.
- Reason: there is some selector upside, but the payoff is smaller than the workspace store migration.

### 3. WebContainer runtime is only a partial fit
- Current shape: imperative async orchestration plus a broad metadata context.
- Recommendation: do not migrate the provider wholesale. At most, consider a later metadata-only store split.
- Reason: the orchestration layer is not simpler in `@xstate/store`.

### 4. NextEditor should stay actor-based
- Current shape: XState actor/machine coordination with timeline and audio actors.
- Recommendation: no migration.
- Reason: this is complex orchestration and already belongs in XState actors, not `@xstate/store`.

## Execution Plan

### Task 1. Record the review outcomes
- Create `plan.md` and `progress.md` to capture the findings, scope, and execution status.

### Task 2. Migrate workspace state to `@xstate/store-react`
- Add `@xstate/store-react`.
- Replace the manual workspace slice contexts with a single workspace store context.
- Preserve `WorkspaceActionsContext` and the public `useWorkspace*` hooks.
- Preserve explicit localStorage save behavior and the current dirty/save/sync version semantics.

### Task 3. Validate and document the result
- Run formatting for touched code.
- Run narrow validation for the migration.
- Update `progress.md` with the implementation outcome.

### Task 4. Close the remaining findings without code migration
- Mark Slides, WebContainer runtime, and NextEditor as deferred or no-change decisions in `progress.md`.
- Finish once the workspace migration is committed and the remaining findings are recorded as explicit decisions.