# Plan

Scope: Enhancement 2 plus approved workspace follow-up fixes.

Out of scope:
- Enhancements 3-6 from `enhancements.md`
- New tests
- Behavior changes unrelated to workspace snapshot capture, workspace sidebar state, replay loading, or runtime workspace sync

Execution rules:
- Follow this file and `progress.md`.
- After each completed task: update `progress.md`, run formatting for changed code when a formatter is available, and create a git commit.
- Do not start any later enhancement phase without explicit user approval.

Goal:
- Keep the phase-2 clone removals intact.
- Fix default workspace creation so toolbar-based file and folder creation starts at the project root instead of the active file's parent folder.
- Record and replay workspace folder collapse and expand state as part of workspace snapshots.

Definition of done:
- Toolbar-based file creation defaults to the project root.
- Workspace collapse state is stored outside `FileSidebar` local component state.
- Workspace recording snapshots capture collapsed folders and replay applies them.
- Workspace event recording reacts to sidebar state changes that matter for playback, including collapse and expand actions.
- Typecheck passes.
- No tests are added.

## Task 1. Reopen phase-2 planning for workspace follow-up fixes

Deliverables:
- Update `plan.md` for the approved phase-2 workspace follow-up scope.
- Update `progress.md` so the new phase-2 tasks are active.

Exit criteria:
- The planning files describe only the currently approved phase-2 scope.

## Task 2. Fix default workspace creation target

Deliverables:
- Update `src/components/FileSidebar.tsx` so toolbar-based create actions default to the project root instead of the active file's parent folder.

Exit criteria:
- Clicking the top-level create file action no longer defaults to `src/` when the active file is under `src/`.

## Task 3. Store and replay folder collapse state in workspace snapshots

Deliverables:
- Move folder collapse state into the workspace store.
- Extend workspace snapshot capture and replay application to include collapsed folders.
- Ensure workspace state transitions normalize collapsed folders against the current folder tree and keep active-file ancestors expanded.

Exit criteria:
- Collapse/expand state survives workspace snapshot capture and replay.
- `FileSidebar` no longer owns collapse state as local component state.

## Task 4. Record workspace sidebar changes needed for playback

Deliverables:
- Update workspace event recording so it reacts to sidebar-state changes relevant to playback, including folder collapse and expand.
- Keep file content edits out of this recording trigger path.

Exit criteria:
- Collapse/expand actions produce workspace recording events without turning file typing into workspace event spam.

## Task 5. Validate and finish the phase-2 workspace follow-up

Deliverables:
- Run typecheck.
- Update `progress.md` with final status and remaining risks for this approved phase-2 scope only.

Exit criteria:
- All approved phase-2 follow-up tasks are marked complete.
- The final commit for this follow-up contains only the requested workspace changes.