# WebContainer Runtime Improvement Plan

## Goal

Upgrade the WebContainer runtime to better support Node app lessons with stronger error visibility, better runtime lifecycle tracking, a real interactive terminal, and safer preview refresh behavior.

## Tasks

1. Preview error forwarding
   - Enable WebContainer preview error forwarding at boot.
   - Listen for `preview-message` events.
   - Surface preview-side errors in runtime metadata and the runtime dock.

2. Runtime lifecycle visibility
   - Listen for `port` and `error` runtime events.
   - Track open ports and richer runtime lifecycle state.
   - Surface runtime lifecycle changes in the dock UI.

3. Interactive terminal session
   - Replace one-shot command-only terminal behavior with a persistent shell session.
   - Support terminal input through the dock.
   - Resize the terminal session with the dock dimensions.

4. Runtime preview refresh
   - Use the WebContainers preview reload API for runtime refreshes.
   - Keep fallback behavior safe when a runtime preview is not active.

## Execution Rules

- After each completed task:
  - update `progress.md`
  - run formatting for touched code
  - validate the touched slice
  - commit with git CLI
- Do not add tests.
