# Plan

Scope: Enhancement 1 only: break up the editor state machine.

Out of scope:
- Enhancements 2-6 from `enhancements.md`
- New tests
- Behavior changes unrelated to editor recording/playback orchestration

Execution rules:
- Follow this file and `progress.md`.
- After each completed task: update `progress.md`, run formatting for changed code when a formatter is available, and create a git commit.
- Do not start any later enhancement phase without explicit user approval.

Goal:
- Reduce the size and coupling of `src/core/src/machine/editorMachine.ts` while preserving current recording/playback behavior.
- Move repeated replay and recording logic into smaller, typed, pure modules so the top-level machine mostly orchestrates states and actor interactions.

Definition of done:
- `editorMachine.ts` delegates replay state derivation and recording event accumulation to extracted modules.
- Repeated playback action fan-out is consolidated into shared action lists or orchestration helpers.
- Typecheck passes.
- No tests are added.

## Task 1. Establish planning and tracking artifacts

Deliverables:
- Create `plan.md`.
- Create `progress.md`.
- Record that enhancement 1 is the only active phase.

Exit criteria:
- Both files exist and reflect the execution rules above.

## Task 2. Extract replay state reducers and shared timed-event utilities

Deliverables:
- Add a dedicated machine helper module for replay-time state derivation.
- Move preview, workspace, runtime, and slide replay scanning/derivation logic out of `editorMachine.ts` into pure typed functions.
- Introduce one shared utility for resolving current playback time and advancing event indexes.

Exit criteria:
- `editorMachine.ts` stops owning the detailed scanning logic for the four non-frame replay channels.
- Playback behavior still typechecks through the existing machine wiring.

## Task 3. Consolidate repeated playback orchestration inside the machine

Deliverables:
- Replace repeated action sequences such as workspace/runtime/frame/preview/slide application with shared action arrays/constants.
- Keep state transitions readable by making the orchestration intent explicit.

Exit criteria:
- Playback entry, tick, seek, stop, pause, and editor-ref sync paths reuse shared orchestration blocks instead of duplicating the same action list.

## Task 4. Extract recording event appenders from the machine

Deliverables:
- Move slide/preview/workspace/runtime recording accumulation into a dedicated helper module.
- Keep deduplication logic with the extracted recording helpers rather than inline in XState action bodies.

Exit criteria:
- `editorMachine.ts` no longer contains the inline session array append logic for those event types.
- Recording still typechecks with the existing context and event model.

## Task 5. Validate and finish enhancement 1

Deliverables:
- Run typecheck.
- Update `progress.md` with final status and any remaining risks for enhancement 1 only.

Exit criteria:
- Enhancement 1 tasks are marked complete.
- The final commit for this phase contains only phase-1 changes.