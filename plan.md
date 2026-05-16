# Fix Plan

Constraints:

- Do not add tests.
- Update `progress.md` after each completed task.
- Format touched code after each completed code task.
- Commit each completed task with git CLI before moving to the next one.

Tasks:

1. Create planning artifacts.
   - Add `plan.md` and `progress.md` with task tracking and verification notes.

2. Record runtime preview interactions.
   - Extend the injected WebContainer preview bootstrap script to emit `IFRAME_INTERACTION` messages for clicks, focus, blur, keyboard, input, hover, and scroll.
   - Keep runtime snapshot messages intact so recording still captures replayable HTML.
   - Validate with targeted type/error checks.

3. Fix runtime preview playback reapplication.
   - Allow recorded runtime preview interactions and scroll state to replay while playback is active.
   - Prevent stale editor-bootstrap polling from overwriting the runtime iframe after mode changes.
   - Validate with targeted type/error checks.

4. Scope runner lifecycle events to the active run.
   - Guard preview URL and readiness updates so stale runner lifecycle events cannot overwrite the current run.
   - Preserve existing runtime metadata and recording snapshots.
   - Validate with targeted type/error checks.

5. Replace the hardcoded URL proxy assumption.
   - Stop hard-wiring the remote proxy host.
   - Prefer a same-origin proxy route when available and fall back to direct fetch otherwise.
   - Keep URL query loading behavior intact.
   - Validate with targeted type/error checks.

6. Final verification and wrap-up.
   - Update `progress.md` with the completed state and commit references.
   - Run a final repository validation pass.

7. Fix paused runtime preview ownership regression.
   - Keep node.js runtime preview playback attached to the recorded runtime snapshot for paused and ended playback states.
   - Preserve paused-state preview interaction/testing without falling back to the live runtime iframe.
   - Validate with targeted type/error checks.

8. Restore paused live runtime handoff and guard cross-origin preview access.
   - Make paused node.js preview follow actual playback ownership instead of playback state labels.
   - Guard preview playback DOM reads so cross-origin runtime iframes cannot crash the route.
   - Validate with targeted type/error checks.

9. Replay preview cursor during playback.
   - Capture preview iframe mouse movement for runtime playback without regressing existing same-origin cursor tracking.
   - Feed cross-origin preview cursor movement into the existing playback cursor system.
   - Keep existing preview interaction replay behavior intact.
   - Validate with targeted type/error checks.
