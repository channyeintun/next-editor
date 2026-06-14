# Preview Patch/Diff Record and Replay Progress

Date: 2026-06-15

## Plan

- [x] Phase 1: Types and recording storage.
- [x] Phase 2: Injected patch recorder.
- [ ] Phase 3: Parent message handling.
- [ ] Phase 4: Patch apply utilities.
- [ ] Phase 5: Replay integration.
- [ ] Phase 6: Prefer patch path for new recordings.

## Current Evaluation

- Phase 2 is complete, validated, and committed.
- The injected runtime support script now emits an initial preview document and RAF-batched DOM patch batches while keeping the existing full snapshot path active.
- Next task: Phase 3, validate and append patch messages in the parent bridge without changing preview event semantics.

## Completed Tasks

### 1. Types and Recording Storage

- Added versioned preview DOM patch operation, batch, node reference, serialized node, and initial document seed types.
- Added optional `previewInitialDocuments` and `previewPatchBatches` fields to persisted recordings.
- Added recording-session storage arrays and append helpers for initial documents and patch batches.
- Finalized recordings now carry the new arrays through without consuming them during replay.
- Validation passed with `bun run format`, `bun run lint`, `bun run check`, and `bun run build`.
- Committed with message `Add preview patch recording storage`.

### 2. Injected Patch Recorder

- Added runtime preview message constants for initial documents and patch batches.
- Added an iframe-side patch recorder that posts one initial document seed per logical preview document.
- Added MutationObserver normalization for text, attribute, child insert/remove/move, and coarse subtree replacement operations.
- Batched mutation records with `requestAnimationFrame` and tracked document revision metadata.
- Kept the existing full HTML snapshot observer active as compatibility fallback.
- Generated recorder script syntax check passed by evaluating the helper and compiling the returned script string.
- Validation passed with `bun run format`, `bun run lint`, `bun run check`, and `bun run build`.
- Committed with message `Emit runtime preview patch batches`.
