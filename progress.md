# Progress

Active phase: Enhancement 5 replacement of the registration-by-ref bridge with explicit domain adapters

Rules in force:
- No tests will be added.
- No work will start on enhancement 6 until the user approves explicitly.

## Status

1. Task 1. Reopen planning for enhancement 5: Completed
2. Task 2. Add explicit domain adapters: Completed
3. Task 3. Route slides and preview through adapters: Not started
4. Task 4. Route runtime panel playback through adapters: Not started
5. Task 5. Validate and finish enhancement 5: Not started

Enhancement 5 status: In progress

## Log

- Enhancement 1, enhancement 2, enhancement 3, and enhancement 4 are already complete.
- Confirmed that `src/contexts/NextEditorProvider.tsx` still owns mutable refs plus `register*` callbacks for slide, preview, runtime, and slide-navigation bridging.
- Confirmed that `src/contexts/SlidesContext.tsx`, `src/components/preview/usePreviewPlaybackRegistration.ts`, `src/components/TerminalPanel.tsx`, and slide renderer components push callbacks back into `NextEditorProvider` through those registration APIs.
- Completed Task 1 by rewriting `plan.md` and `progress.md` for the approved enhancement-5 scope.
- Completed Task 2 by adding `src/contexts/NextEditorDomainAdaptersContext.tsx`, wrapping the editor tree with explicit adapters, wiring `src/contexts/NextEditorProvider.tsx` to consume adapters for snapshot get/apply logic, and validating with `bun run typecheck`.

## Risks

- Validation for this phase will remain limited to formatting when available and `bun run typecheck` because tests must not be added.
- The slide, preview, and runtime flows share playback-sensitive behavior, so adapter cutover must preserve existing snapshot timing and manual override semantics.
- No enhancement beyond the approved enhancement-5 scope has been started.