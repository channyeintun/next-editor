# Preview Patch/Diff Record and Replay Progress

Date: 2026-06-15

## Plan

- [x] Phase 1: Types and recording storage.
- [x] Phase 2: Injected patch recorder.
- [x] Phase 3: Parent message handling.
- [x] Phase 4: Patch apply utilities.
- [x] Phase 5: Replay integration.
- [ ] Phase 6: Prefer patch path for new recordings.

## Current Evaluation

- Phase 5 is complete, validated, and committed.
- Replay now invokes a dedicated preview patch replay adapter during tick/seek and applies patch batches into the persistent preview iframe when patch data exists.
- Next task: Phase 6, prefer patch replay for new recordings while keeping snapshot fallback for compatibility and recovery.

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

### 3. Parent Message Handling

- Added shared runtime initial document and patch batch message constants.
- Added editor machine events for preview initial documents and DOM patch batches.
- Exposed stable editor actions for recording preview initial documents and patch batches.
- Wired the preview controller and bridge to record validated patch messages separately from semantic preview events.
- Cached the latest runtime initial document so recordings that start after the preview has loaded can still seed the patch stream.
- Normalized initial document HTML through the existing replayable runtime preview helper before recording.
- Validation passed with `bun run check --fix`, `bun run format`, `bun run lint`, `bun run check`, and `bun run build`.
- Committed with message `Record preview patch messages`.

### 4. Patch Apply Utilities

- Added `morphdom` as a runtime dependency for in-place subtree reconciliation.
- Added preview node lookup by private replay marker id or path fallback.
- Added serialized preview node deserialization with inert script reconstruction.
- Added direct application for text, attribute, node insert/remove/move, subtree replacement, and form-property operations.
- Added iframe helpers for applying initial preview documents and DOM patch batches with soft failure results.
- Validation passed with `bun run check --fix`, `bun run format`, `bun run lint`, `bun run check`, and `bun run build`.
- Committed with message `Add preview DOM patch applier`.

### 5. Replay Integration

- Added a preview patch replay callback to the preview domain adapter and editor machine config.
- Added a preview patch replay cursor to the editor machine and reset it alongside other replay cursors.
- Applied patch replay during shared tick/seek replay actions before semantic preview event replay.
- Registered an iframe-side patch replay cursor that seeds from the nearest initial document and applies patch batches forward by time.
- Kept semantic preview replay active for route, scroll, focus, and interaction state while skipping full snapshot content writes when patch replay is healthy.
- Falls back to the existing snapshot content path if patch replay cannot seed or apply a batch.
- Validation passed with `bun run check --fix`, `bun run format`, `bun run lint`, `bun run check`, and `bun run build`.
- Committed with message `Integrate preview patch replay`.
