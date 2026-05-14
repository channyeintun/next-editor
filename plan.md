# Plan

Scope: Enhancement 2 only: stop cloning full workspace snapshots on hot paths.

Out of scope:
- Enhancements 3-6 from `enhancements.md`
- New tests
- Behavior changes unrelated to workspace snapshot capture, replay loading, or runtime workspace sync

Execution rules:
- Follow this file and `progress.md`.
- After each completed task: update `progress.md`, run formatting for changed code when a formatter is available, and create a git commit.
- Do not start any later enhancement phase without explicit user approval.

Goal:
- Remove deep project cloning from the recording/replay/runtime-sync hot paths.
- Preserve current replay and runtime behavior by relying on the workspace store's immutable project replacement semantics instead of copying whole project trees.

Definition of done:
- Recording workspace snapshots no longer deep-clone the workspace project on capture.
- Replay loading and runtime sync stop deep-cloning the current project on their hot paths.
- No-op runtime sync work is skipped when the exact same project object is already synced.
- Typecheck passes.
- No tests are added.

## Task 1. Reframe planning and tracking for phase 2

Deliverables:
- Update `plan.md` for enhancement 2 only.
- Update `progress.md` so enhancement 2 is the active phase.

Exit criteria:
- The planning files describe only phase-2 work and keep the user's execution rules in force.

## Task 2. Remove deep cloning from workspace recording and replay loading

Deliverables:
- Update `src/contexts/NextEditorProvider.tsx` so workspace snapshot capture stops using `structuredClone(getProject())` on the recording hot path.
- Update `src/contexts/WorkspaceProvider.tsx` so replay `loadProject()` does not create a deep-cloned saved snapshot for every applied workspace event.

Exit criteria:
- Recording and replay loading keep the same behavior while avoiding full-project cloning on these paths.

## Task 3. Remove deep cloning from runtime workspace sync and skip no-op syncs

Deliverables:
- Update `src/contexts/WebContainerRuntimeProvider.tsx` so mounted/synced workspace references are stored without deep cloning.
- Add an identity-based short-circuit so sync work is skipped when the same immutable project object is already current.

Exit criteria:
- Runtime mount/save/start flows stop cloning whole projects and avoid redundant sync passes when the project reference is unchanged.

## Task 4. Validate and finish enhancement 2

Deliverables:
- Run typecheck.
- Update `progress.md` with final status and remaining phase-2 risks only.

Exit criteria:
- Enhancement 2 tasks are marked complete.
- The final commit for this phase contains only phase-2 changes.