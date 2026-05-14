# Plan

Scope: Enhancement 5 replacement of the registration-by-ref bridge with explicit domain adapters.

Out of scope:
- Enhancement 6 from `enhancements.md`
- New tests
- Storage, preview-rendering, or editor-machine work unrelated to the registration bridge
- Broad WebContainer runtime refactors beyond the runtime recording adapter surface

Execution rules:
- Follow this file and `progress.md`.
- After each completed task: update `progress.md`, run formatting for changed code when a formatter is available, and create a git commit.
- Do not start any later enhancement phase without explicit user approval.

Goal:
- Replace the mutable registration callback bridge in `src/contexts/NextEditorProvider.tsx` with explicit domain adapters.
- Make slide, preview, and runtime snapshot dependencies explicit in app composition.
- Remove registration helpers from the editor actions surface once all consumers use adapters directly.

Definition of done:
- `NextEditorProvider` no longer owns ref-based registration APIs for slides, preview, or runtime panel state.
- Slide, preview, and runtime snapshot behavior flows through explicit domain adapters created once and passed through app composition.
- Hidden coupling through `register*` callbacks is removed from the public editor actions surface.
- Typecheck passes.
- No tests are added.

## Task 1. Reopen planning for enhancement 5

Deliverables:
- Update `plan.md` for the approved enhancement-5 scope.
- Update `progress.md` so enhancement 5 is the active phase.

Exit criteria:
- The tracking files describe only enhancement 5 work.

## Task 2. Add explicit domain adapters

Deliverables:
- Introduce stable slide, preview, and runtime adapter types plus a composition surface for sharing them.
- Wire the editor provider to consume adapters instead of local registration refs.

Exit criteria:
- The provider configuration reads from explicit adapters rather than mutable registration refs.

## Task 3. Route slides and preview through adapters

Deliverables:
- Update slide and preview code paths to use the explicit adapter surface.
- Remove slide and preview registration helpers from the editor actions API.

Exit criteria:
- Slide and preview snapshot capture and apply flows no longer depend on `register*` callbacks.

## Task 4. Route runtime panel playback through adapters

Deliverables:
- Update runtime panel playback snapshot capture and apply flows to use the explicit adapter surface.
- Remove the remaining runtime registration helpers from the editor actions API.

Exit criteria:
- Runtime panel playback state no longer depends on callback registration into `NextEditorProvider`.

## Task 5. Validate and finish enhancement 5

Deliverables:
- Run typecheck.
- Update `progress.md` with final status and remaining risks for enhancement 5 only.

Exit criteria:
- All approved enhancement-5 tasks are marked complete.
- The final commit for this phase contains only the requested adapter-bridge changes.