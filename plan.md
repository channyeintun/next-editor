# Xterm Integration Plan

## Goal
Replace the custom text-based terminal renderer with an xterm-powered terminal that works with WebContainer live sessions and supports recording/replay with raw terminal events.

## Constraints
- Never add tests.
- Preserve the existing multi-session dock UX.
- Keep the runtime and replay model compatible with the existing recording architecture.
- Use Bun project commands for install, formatting, and validation.

## Task 1: Create planning artifacts
- Create `plan.md` and `progress.md`.
- Track tasks, status, and commits.

## Task 2: Integrate xterm for live WebContainer terminals
- Add xterm dependencies needed for browser rendering and resizing.
- Introduce a reusable xterm React view for dock terminal sessions.
- Stop sanitizing live terminal output before display.
- Feed raw WebContainer output into xterm instances.
- Route xterm keyboard input back to the active terminal session.
- Keep the existing dock session creation, activation, and close behavior.

## Task 3: Upgrade terminal recording model for replay
- Extend runtime recording types to store terminal events instead of only terminal text snapshots.
- Record per-session terminal output chunks, resize events, and session lifecycle changes with timestamps.
- Preserve compatibility with existing runtime snapshot playback where practical.
- Keep replay data explicit and simple.

## Task 4: Add xterm-based replay rendering
- Render recorded terminal sessions through xterm during playback.
- Reconstruct terminal state by applying recorded events in timestamp order.
- Ensure seeking and paused playback can restore the correct terminal buffer for the active session.
- Keep non-playback live runtime behavior unchanged.

## Task 5: Final validation and cleanup
- Run formatting for code changes.
- Run typecheck after each code task.
- Commit each completed task with git CLI before starting the next task.
- Update `progress.md` after every completed task.
