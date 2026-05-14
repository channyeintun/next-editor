# Plan

Scope: Enhancement 6 separation of WebContainer runtime concerns into smaller modules.

Out of scope:
- Enhancement 7 or any later phase from `enhancements.md`
- New tests
- Storage, preview-rendering, or editor-machine refactors unrelated to the WebContainer runtime provider
- Changes to the public runtime context surface unless needed to support the provider split

Execution rules:
- Follow this file and `progress.md`.
- After each completed task: update `progress.md`, run formatting for changed code when a formatter is available, and create a git commit.
- Never add tests.
- Do not start any later enhancement phase without explicit user approval.

Goal:
- Split `src/contexts/WebContainerRuntimeProvider.tsx` so filesystem sync, runner control, terminal lifecycle, and shared runtime helpers live in smaller modules.
- Keep the provider focused on composing runtime pieces and exposing the existing public surface.
- Add an explicit queued sync policy so repeated save bursts do not overlap runtime lifecycle transitions.

Definition of done:
- `WebContainerRuntimeProvider` delegates filesystem sync, runtime session control, and shared runtime support code to smaller modules or hooks.
- Workspace sync runs through an explicit queue or debounce policy instead of ad-hoc provider effects calling sync work directly.
- The existing runtime actions and metadata surface still works through the provider.
- Typecheck passes.
- No tests are added.

## Task 1. Reopen planning for enhancement 6

Deliverables:
- Update `plan.md` for the approved enhancement-6 scope.
- Update `progress.md` so enhancement 6 is the active phase.

Exit criteria:
- The tracking files describe only enhancement 6 work.

## Task 2. Extract shared runtime support utilities

Deliverables:
- Move pure runtime helper logic such as workspace tree creation, command parsing, preview-message formatting, terminal sanitizing, and environment normalization into focused runtime support modules.
- Keep `WebContainerRuntimeProvider` behavior unchanged while shrinking its concrete implementation surface.

Exit criteria:
- The provider imports shared helpers instead of defining those pure utilities inline.

## Task 3. Introduce a queued workspace sync controller

Deliverables:
- Extract mount/sync responsibilities into a dedicated controller or hook.
- Add an explicit queue or debounce policy so save-triggered sync requests serialize cleanly and do not race each other.

Exit criteria:
- Provider-level save and effect flows no longer call the raw sync routine directly.

## Task 4. Extract runtime session control

Deliverables:
- Move runner lifecycle, terminal session management, and WebContainer event wiring into a focused controller or hook.
- Keep the provider responsible only for composing state, actions, and context values.

Exit criteria:
- The provider no longer owns the concrete runner and terminal orchestration inline.

## Task 5. Validate and finish enhancement 6

Deliverables:
- Run typecheck.
- Update `progress.md` with final status and remaining risks for enhancement 6 only.

Exit criteria:
- All approved enhancement-6 tasks are marked complete.
- The final commit for this phase contains only the requested runtime-provider refactor.