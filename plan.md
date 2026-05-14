# Plan

Scope: Enhancement 4 recording persistence migration to incremental IndexedDB storage.

Out of scope:
- Enhancements 5-6 from `enhancements.md`
- New tests
- Changes to the `.ne` import/export file format beyond what is needed to keep it working
- Preview, runtime, or editor-machine refactors unrelated to recording persistence

Execution rules:
- Follow this file and `progress.md`.
- After each completed task: update `progress.md`, run formatting for changed code when a formatter is available, and create a git commit.
- Do not start any later enhancement phase without explicit user approval.

Goal:
- Replace the in-app localStorage recording archive with per-recording IndexedDB persistence.
- Separate lightweight recording metadata from larger recording payloads.
- Preserve the existing `.ne` import/export behavior while decoupling it from app persistence.
- Migrate legacy localStorage archives forward so existing recordings remain available.

Definition of done:
- Saving or deleting one recording no longer reloads and rewrites the entire in-app archive.
- Recordings are persisted individually in IndexedDB.
- Metadata operations do not require decompressing every stored recording payload.
- Existing localStorage archives are migrated into IndexedDB automatically.
- Typecheck passes.
- No tests are added.

## Task 1. Reopen planning for enhancement 4

Deliverables:
- Update `plan.md` for the approved enhancement-4 scope.
- Update `progress.md` so enhancement 4 is the active phase.

Exit criteria:
- The tracking files describe only enhancement 4 work.

## Task 2. Add an IndexedDB recording store

Deliverables:
- Introduce an IndexedDB-backed recording store for per-recording persistence.
- Store lightweight metadata separately from larger payload data.

Exit criteria:
- The storage layer can save, load, delete, and clear recordings without rebuilding a combined archive.

## Task 3. Route recording persistence through metadata and payload operations

Deliverables:
- Update the existing storage API to use IndexedDB for in-app persistence.
- Keep `.ne` export and import behavior working through the storage layer.
- Make stats and listing-style operations use metadata instead of full archive decompression.

Exit criteria:
- In-app persistence is decoupled from the export/import format.

## Task 4. Migrate legacy localStorage archives

Deliverables:
- Detect the existing localStorage recording archive and migrate its recordings into IndexedDB.
- Prevent repeat migrations once the archive has been imported.

Exit criteria:
- Existing localStorage-backed recordings remain available after the storage migration.

## Task 5. Validate and finish enhancement 4

Deliverables:
- Run typecheck.
- Update `progress.md` with final status and remaining risks for enhancement 4 only.

Exit criteria:
- All approved enhancement-4 tasks are marked complete.
- The final commit for this phase contains only the requested storage changes.