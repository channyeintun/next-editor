# Progress

Active phase: Enhancement 4 recording persistence migration to incremental IndexedDB storage

Rules in force:
- No tests will be added.
- No work will start on enhancement 5 or enhancement 6 until the user approves explicitly.

## Status

1. Task 1. Reopen planning for enhancement 4: Completed
2. Task 2. Add an IndexedDB recording store: Completed
3. Task 3. Route recording persistence through metadata and payload operations: Completed
4. Task 4. Remove legacy storage compatibility: Completed
5. Task 5. Validate and finish enhancement 4: Not started

Enhancement 4 status: In progress

## Log

- Enhancement 1, enhancement 2, and enhancement 3 are already complete.
- Confirmed that `src/storage/JsonStorage.ts` still stores all recordings as one base64-encoded compressed archive in localStorage.
- Confirmed that `save()` and `delete()` currently call `load()` and then rewrite the full archive, so their cost scales with the whole recording set.
- Confirmed that there is no existing IndexedDB recording persistence helper in `src/` to reuse for enhancement 4.
- Completed Task 1 by rewriting `plan.md` and `progress.md` for the approved enhancement-4 scope.
- Completed Task 2 by adding `src/storage/IndexedDBRecordingStore.ts` with separate metadata, payload, and system stores for per-recording persistence, and validated with `bun run typecheck`.
- Completed Task 3 by routing `src/storage/JsonStorage.ts` through the IndexedDB store for save/load/delete/clear, keeping `.ne` export/import intact, and switching stats to IndexedDB metadata with `bun run typecheck` validation.
- Updated the phase-4 plan to remove legacy localStorage compatibility by user instruction.
- Completed Task 4 by deleting the localStorage archive fallback and migration plumbing from `src/storage/JsonStorage.ts`, removing the unused IndexedDB system store, and keeping persistence IndexedDB-only.

## Risks

- Any recordings that existed only in the old localStorage archive are intentionally ignored by the new IndexedDB-only persistence path.
- Validation remains constrained to formatting and typechecking because tests must not be added.
- No enhancement beyond the approved enhancement-4 scope has been started.