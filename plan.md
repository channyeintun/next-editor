# Plan

Scope: Enhancement 3 preview decomposition and static preview caching.

Out of scope:
- Enhancements 4-6 from `enhancements.md`
- New tests
- Behavior changes unrelated to preview rendering, preview replay, or preview iframe wiring

Execution rules:
- Follow this file and `progress.md`.
- After each completed task: update `progress.md`, run formatting for changed code when a formatter is available, and create a git commit.
- Do not start any later enhancement phase without explicit user approval.

Goal:
- Remove static workspace preview compilation from ordinary `Preview` renders.
- Split preview orchestration from preview presentation.
- Isolate iframe messaging, playback registration, and interaction capture into narrower preview hooks.

Definition of done:
- Static workspace preview output is cached by `previewVersion` and not rebuilt on unrelated rerenders.
- `src/components/Preview.tsx` is reduced to composition around extracted preview modules.
- Separate static and runtime preview renderers exist.
- Iframe event wiring and replay state application are moved into isolated hooks or modules with narrow responsibilities.
- Typecheck passes.
- No tests are added.

## Task 1. Reopen planning for enhancement 3

Deliverables:
- Update `plan.md` for the approved enhancement-3 scope.
- Update `progress.md` so enhancement 3 is the active phase.

Exit criteria:
- The tracking files describe only enhancement 3 work.

## Task 2. Cache compiled static preview output

Deliverables:
- Extract static preview compilation from `src/components/Preview.tsx` into a dedicated preview module.
- Cache compiled static preview output by `previewVersion` so ordinary preview rerenders do not rebuild the document.

Exit criteria:
- Static preview generation no longer runs inline from render-time branching.

## Task 3. Extract preview controller and renderers

Deliverables:
- Move preview orchestration into a dedicated controller hook.
- Add separate static and runtime preview renderer components while preserving existing preview chrome and sizing behavior.

Exit criteria:
- `Preview.tsx` becomes a thin composition layer over extracted preview logic and renderers.

## Task 4. Isolate iframe messaging and playback wiring

Deliverables:
- Move iframe message handling, preview state getter/applier registration, and interaction capture into isolated preview hooks.
- Keep preview replay behavior and refresh flows consistent with the current implementation.

Exit criteria:
- The remaining preview side effects live in focused hooks instead of one monolithic component.

## Task 5. Validate and finish enhancement 3

Deliverables:
- Run typecheck.
- Update `progress.md` with final status and remaining risks for enhancement 3 only.

Exit criteria:
- All approved enhancement-3 tasks are marked complete.
- The final commit for this phase contains only the requested preview changes.