# Progress

Active phase: Enhancement 3 preview decomposition and static preview caching

Rules in force:
- No tests will be added.
- No work will start on enhancements 4-6 until the user approves explicitly.

## Status

1. Task 1. Reopen planning for enhancement 3: Completed
2. Task 2. Cache compiled static preview output: Completed
3. Task 3. Extract preview controller and renderers: Completed
4. Task 4. Isolate iframe messaging and playback wiring: Completed
5. Task 5. Validate and finish enhancement 3: Completed

Enhancement 3 status: Completed

## Log

- Enhancement 1 and enhancement 2 are already complete.
- Confirmed that `src/components/Preview.tsx` still compiles static workspace preview output inline during render through `createStaticWorkspacePreview(getProject())`.
- Confirmed that `Preview.tsx` currently mixes runtime preview state, iframe message handling, preview replay registration, interaction capture, and preview UI composition in one component.
- Completed Task 1 by rewriting `plan.md` and `progress.md` for the approved enhancement-3 scope.
- Completed Task 2 by extracting static preview compilation into `src/components/preview/staticWorkspacePreview.ts`, memoizing it by `previewVersion`, and validating with `bun run typecheck`.
- Completed Task 3 by moving preview orchestration into `src/components/preview/usePreviewController.ts`, extracting preview chrome plus static and runtime renderer components, and validating with `bun run typecheck`.
- Completed Task 4 by moving iframe message handling, preview getter/applier registration, and interaction capture into dedicated preview hooks and validating with `bun run typecheck`.
- Completed Task 5 with a final `bun run typecheck` pass after formatting, and no enhancement beyond the approved phase-3 scope was started.

## Risks

- Validation for enhancement 3 is limited to formatting and typechecking because tests must not be added.
- Manual browser validation was not run, so the main residual risk is interactive preview behavior during refresh, paused playback, and iframe interaction capture.
- No enhancement beyond the approved enhancement-3 scope has been started.