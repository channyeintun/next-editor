# Progress

Active phase: Enhancement 4 recording persistence migration to incremental IndexedDB storage

Rules in force:
- No tests will be added.
- No work will start on enhancement 5 or enhancement 6 until the user approves explicitly.

## Status

1. Task 1. Reopen planning for enhancement 4: Completed
2. Task 2. Add an IndexedDB recording store: Not started
3. Task 3. Route recording persistence through metadata and payload operations: Not started
4. Task 4. Migrate legacy localStorage archives: Not started
5. Task 5. Validate and finish enhancement 4: Not started

Enhancement 4 status: In progress

## Log

- Enhancement 1, enhancement 2, and enhancement 3 are already complete.
- Confirmed that `src/storage/JsonStorage.ts` still stores all recordings as one base64-encoded compressed archive in localStorage.
- Confirmed that `save()` and `delete()` currently call `load()` and then rewrite the full archive, so their cost scales with the whole recording set.
- Confirmed that there is no existing IndexedDB recording persistence helper in `src/` to reuse for enhancement 4.
- Completed Task 1 by rewriting `plan.md` and `progress.md` for the approved enhancement-4 scope.

## Risks

- Existing recordings currently depend on the legacy localStorage archive, so enhancement 4 must include migration rather than a hard storage cutover.
- Validation remains constrained to formatting and typechecking because tests must not be added.
- No enhancement beyond the approved enhancement-4 scope has been started.