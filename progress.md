# Preview Patch/Diff Record and Replay Progress

Date: 2026-06-15

## Plan

- [x] Phase 1: Types and recording storage.
- [ ] Phase 2: Injected patch recorder.
- [ ] Phase 3: Parent message handling.
- [ ] Phase 4: Patch apply utilities.
- [ ] Phase 5: Replay integration.
- [ ] Phase 6: Prefer patch path for new recordings.

## Current Evaluation

- Phase 1 is complete, validated, and committed.
- The recording model can now represent initial preview document seeds and DOM patch batches without changing runtime or replay behavior.
- Next task: Phase 2, emit normalized patch batches from the injected runtime preview recorder while keeping full snapshots active.

## Completed Tasks

### 1. Types and Recording Storage

- Added versioned preview DOM patch operation, batch, node reference, serialized node, and initial document seed types.
- Added optional `previewInitialDocuments` and `previewPatchBatches` fields to persisted recordings.
- Added recording-session storage arrays and append helpers for initial documents and patch batches.
- Finalized recordings now carry the new arrays through without consuming them during replay.
- Validation passed with `bun run format`, `bun run lint`, `bun run check`, and `bun run build`.
- Committed as `cfaf626` with message `Add preview patch recording storage`.
