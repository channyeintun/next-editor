# Progress

Active phase: Enhancement 5 replacement of the registration-by-ref bridge with explicit domain adapters

Rules in force:
- No tests will be added.
- No work will start on enhancement 6 until the user approves explicitly.

## Status

1. Task 1. Reopen planning for enhancement 5: Completed
2. Task 2. Add explicit domain adapters: Completed
3. Task 3. Route slides and preview through adapters: Completed
4. Task 4. Route runtime panel playback through adapters: Completed
5. Task 5. Validate and finish enhancement 5: Completed

Enhancement 5 status: Completed

## Log

- Enhancement 1, enhancement 2, enhancement 3, and enhancement 4 are already complete.
- Confirmed that `src/contexts/NextEditorProvider.tsx` still owns mutable refs plus `register*` callbacks for slide, preview, runtime, and slide-navigation bridging.
- Confirmed that `src/contexts/SlidesContext.tsx`, `src/components/preview/usePreviewPlaybackRegistration.ts`, `src/components/TerminalPanel.tsx`, and slide renderer components push callbacks back into `NextEditorProvider` through those registration APIs.
- Completed Task 1 by rewriting `plan.md` and `progress.md` for the approved enhancement-5 scope.
- Completed Task 2 by adding `src/contexts/NextEditorDomainAdaptersContext.tsx`, wrapping the editor tree with explicit adapters, wiring `src/contexts/NextEditorProvider.tsx` to consume adapters for snapshot get/apply logic, and validating with `bun run typecheck`.
- Completed Task 3 by routing `src/contexts/SlidesContext.tsx`, `src/components/preview/usePreviewController.ts`, `src/components/preview/usePreviewPlaybackRegistration.ts`, and slide navigation components through the shared adapters, then removing slide and preview registration helpers from the editor action types with a validating `bun run typecheck` pass.
- Completed Task 4 by routing `src/components/TerminalPanel.tsx` through the runtime adapter, deleting the last runtime registration helpers from `src/contexts/NextEditorContext.ts` and `src/contexts/NextEditorProvider.tsx`, validating with `bun run typecheck`, and confirming the old `register*` bridge symbols are gone from `src/`.
- Completed Task 5 with a final `bun run typecheck` pass, and enhancement 5 now ends with explicit slide, preview, and runtime adapters in place and no `register*` bridge API remaining in `src/`.

## Risks

- Validation for this phase remained limited to `bun run typecheck`; no formatter command is configured in `package.json`, and tests must not be added.
- The slide, preview, and runtime flows remain playback-sensitive, so any future refactor around adapter mounting order or replay timing should be revalidated in the UI.
- No enhancement beyond the approved enhancement-5 scope was started.