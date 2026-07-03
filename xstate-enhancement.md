# XState Integration Review & Enhancement Plan

Reviewed 2026-07-03 against xstate 5.32.4, @xstate/react 6.1.0, @xstate/store-react 2.0.0
(which wraps @xstate/store ^4.0.0 — all current; no upgrades needed).

## What is already done well (do not change)

- **Modern v5 `setup()` usage** in `src/core/src/machine/editorMachine.ts` with typed
  context/events/input, named actors, guards, and actions.
- **Actor model fit**: browser resources (MediaRecorder, camera, Web Audio, pointer
  tracking) live in `fromCallback` actors with correct teardown in the returned cleanup
  (`audioActor.ts`, `cameraActor.ts`, `mouseTrackingActor.ts`). Keep these as callbacks —
  converting them to machines would add ceremony without benefit.
- **React re-render hygiene**: `useActorRef` + module-level selector functions +
  `createActorContext`, with hooks split by update frequency
  (`useNextEditorActions` / `useNextEditorMetadata` / `useLiveTime`).
- **@xstate/store usage**: all five stores use `createStore`/`trigger`/`useSelector`
  with reference-equality bail-outs in every reducer and module-level selectors.
- **Action-body extraction**: `captureActions.ts` / `replayActions.ts` keep the machine
  file readable while preserving `setup()` type inference. `syncPlaybackAudio` in
  `editorMachineHelpers.ts` is a good consolidation of the audio child-actor protocol.
- **Deliberate mutable capture buffer** (`RecordingSession` + `sessionRevision`) — this
  is an intentional O(1)-append design, not a bug. Do not "fix" it into immutable spreads.

## Deferred / rejected (documented so nobody re-litigates)

- **workspaceStore derived slices → selector refactor.** `workspaceStore.ts` maintains
  derived slices (`editorState`, `sidebarState`, `dirtyState`, …) inside context via
  `withRefreshedWorkspaceSlices`/`withDirtyState`. Moving them into comparator-based
  `useSelector` selectors looks cleaner, but the slices are _not_ pure functions of the
  source fields: `updateFileContent` intentionally skips the slice refresh so Monaco
  edits don't echo back into `editorState.activeFile` (which is keyed on
  `projectVersion`). A selector refactor would change those semantics. Deferred.
- **Upgrading @xstate/store packages** — already effectively on @xstate/store v4 via
  @xstate/store-react 2.0.0. Nothing to do.
- **Media `fromCallback` actors → machines** — rejected; imperative resource management
  is the right fit there.

## Global constraints for every phase

- Package manager is **bun**; never npm/yarn/pnpm.
- Verify with `bun run typecheck` and `npx vp test run` (never bare vitest).
- **Do not commit** — leave changes in the working tree.
- React Compiler is enabled: no `useCallback`/`useMemo` for referential stability.
- Zero behavior change is the bar for every phase unless a phase says otherwise.

---

## Phase 1 — Dead code, duplicated constants, selector cleanup (low risk)

**Files:** `src/core/src/machine/editorMachine.ts`, `src/core/src/machine/timelineMachine.ts`,
`src/core/src/useNextEditor.ts`, `src/core/src/machine/editorMachineHelpers.ts`

1. **Delete unused guards** in `editorMachine.ts` `setup({ guards })`:
   `hasRecording`, `hasAudio`, and `isValidSeekTime` are defined but never referenced by
   any transition (verify with grep before deleting). `isValidSeekTime` is safe to drop
   because `seekToTime` already clamps to `[0, duration]` (`replayActions.ts:267`) —
   clamping is strictly better behavior than silently dropping out-of-range seeks.
   If `hasAudio` deletion makes `hasPlaybackAudio` unused in `editorMachine.ts` imports,
   clean the import (the helper itself stays — it's used elsewhere).
2. **timelineMachine dead action**: `emitFinished` is defined in `setup({ actions })` but
   the `PULSE` handler sends `enqueue.sendParent({ type: "FINISHED" })` directly. Use the
   named action (`enqueue({ type: "emitFinished" })`) so the definition isn't dead code.
3. **timelineMachine transition dedup**: `SET_DURATION` is byte-identical in all three
   states — hoist it to a machine-root `on`. `SEEK` and `SET_SPEED` are identical in
   `stopped`/`paused` only — hoist those simple variants to the root `on` and keep the
   `running` state's overriding variants in place (state-level handlers take precedence
   over root-level handlers in XState v5; confirm with the existing tests).
4. **Extract the fuzzy playback-end epsilon.** The literal `100` (ms) is duplicated in
   three places: the `ended → PLAY` guard in `editorMachine.ts` (~line 928, comment
   "Fuzzy end check") and `selectIsPaused`/`selectHasEnded` in `useNextEditor.ts`.
   Export `export const PLAYBACK_END_EPSILON_MS = 100;` from `editorMachineHelpers.ts`
   and use it in all three sites.
5. **Selector micro-cleanup**: `selectIsPaused` calls `getPlaybackState(state)` twice;
   restructure so each selector computes it once (this dovetails with Phase 2's
   `matches()` change — coordinate).

## Phase 2 — Idiomatic state matching & consolidation of duplicated actions

**Files:** `src/core/src/useNextEditor.ts`, `src/core/src/machine/editorMachine.ts`

1. **Replace manual `state.value` walking with `snapshot.matches()`.**
   `getPlaybackState` in `useNextEditor.ts` inspects `state.value` structurally. Rewrite
   the playback selectors on top of the idiomatic API:
   `state.matches({ playback: "playing" })`, `{ playback: "paused" }`,
   `{ playback: "ended" }`, and `state.matches("recording")` for `selectIsRecording`.
   Keep the exported selector signatures unchanged (they are exported and used by
   `Cursor.tsx`, `CameraOverlay.tsx`, `useNextEditorContext.ts`).
2. **Stop reading `self.getSnapshot()` mid-transition.** In the `EXTEND_RECORDING`
   handler (`editorMachine.ts` ~line 704), `play: self.getSnapshot().matches({ playback: "playing" })`
   reads the actor's own snapshot during a transition — discouraged because the snapshot
   may not reflect the in-flight microstep. `enqueueActions` provides a `check` helper:
   use `check(stateIn({ playback: "playing" }))` (import `stateIn` from `xstate`).
   Verify the exact `stateIn` argument form against the installed
   `node_modules/xstate` types before writing it. Behavior must stay identical
   (EXTEND_RECORDING is handled on the `playback` parent and never changes the child
   state, so both forms agree — this is about idiom/safety, not a bug fix).
3. **Deduplicate the `startingRecording` audio cleanup.** The `ERROR` and
   `STOP_RECORDING` handlers both do `stopChild("audioRecorder")` + a near-identical
   audio-reset `assign`. Extract a named `assign` action (e.g.
   `resetAudioAfterRecorderStop`) for the shared reset; `ERROR` additionally sets
   `error` + runs `notifyError`, which stays per-transition.
4. **Name the caption-track actions.** `ADD_CAPTION_TRACK` / `REMOVE_CAPTION_TRACK` at
   the machine root are the only remaining large inline `assign` blobs; move the bodies
   into named actions in `setup({ actions })` (bodies may live in `replayActions.ts`
   following the existing wrapped-assign convention) and reference them by name.

## Phase 3 — Consolidate the six "append to session + bump revision" handlers

**Files:** `src/core/src/machine/editorMachine.ts`, `src/core/src/machine/captureActions.ts`
(or `recordingSession.ts` — pick whichever reads better with the existing layout)

The `recording` state handles `SLIDE_EVENT`, `PREVIEW_EVENT`, `PREVIEW_INITIAL_DOCUMENT`,
`PREVIEW_PATCH_BATCH`, `WORKSPACE_EVENT`, `RUNTIME_EVENT` with six structurally identical
inline assigns: guard on `context.session` (plus snapshot getters for workspace/runtime),
append via the matching `recordingSession.ts` appender, and return
`{ session, sessionRevision: sessionRevision + 1 }`.

Create one shared helper, e.g. in `captureActions.ts`:

```ts
export const appendToSession = (
  context: EditorMachineContext,
  append: (session: RecordingSession) => boolean, // false => nothing appended
): Partial<EditorMachineContext> =>
  !context.session || !append(context.session)
    ? {}
    : { session: context.session, sessionRevision: context.sessionRevision + 1 };
```

then express each of the six handlers as a named action wrapping it. Semantics to
preserve exactly:

- `WORKSPACE_EVENT` / `RUNTIME_EVENT` must NOT bump `sessionRevision` when the appender
  returns `false` (deduplicated event) or when the snapshot getter returns null.
- `SLIDE_EVENT` keeps its trailing `"captureFrame", "notifyFrame"` actions;
  `PREVIEW_EVENT` keeps `"capturePreviewRefreshFrame", "notifyFrame"`;
  the other four have no trailing actions.
- The appenders mutate `session` in place by design (see `RecordingSession` doc comment);
  do not convert to immutable copies.

## Phase 4 — Use `invoke` where child lifecycle exactly matches a state

**Files:** `src/core/src/machine/editorMachine.ts`

Two children are spawned on state entry and stopped on state exit — exactly what
`invoke` automates:

1. **`timeline` in the `playback` state.** Replace the `enqueue.spawnChild("timeline", …)`
   in `playback.entry` and the `stopChild("timelineActor")` in `playback.exit` with:

   ```ts
   invoke: {
     src: "timeline",
     id: "timelineActor",
     input: ({ context }) => ({
       speed: context.timeline.speed,
       duration: context.timeline.duration,
       startPosition: context.timeline.currentTime,
     }),
   }
   ```

   All existing `sendTo("timelineActor", …)` calls keep working (invoked actors are
   addressable by `id`). Note the current spawn happens inside the same
   `enqueueActions` that calls `syncPlaybackAudio` — the audio part stays in `entry`;
   only the timeline spawn moves. Verify with the machine tests that entry ordering
   still applies replay state before the first TICK arrives (invoked actors start
   after entry actions complete, so ordering is preserved).

2. **`mouseTracking` in the `recording` state.** Replace the `spawnChild("mouseTracking",
{ id: "mouseTracker", input: ({ self }) => … })` entry action and the
   `stopChild("mouseTracker")` exit action with an `invoke` on the `recording` state
   (invoke `input` factories also receive `{ self }`). Keep
   `stopChild("recordingAudioPlayer")` in `recording.exit` — that child is spawned
   conditionally elsewhere and is not covered by this change.
3. **Leave as `spawnChild` (add a one-line comment where each is spawned saying why):**
   - `audioRecorder` — spawned in `startingRecording` but must survive into
     `recording`/`stoppingRecording` (its `STOPPED` event arrives after leaving the
     spawning state).
   - `cameraRecorder` — conditional on `enableCameraRecording`.
   - `audioPlayer` — lazily/conditionally spawned by `syncPlaybackAudio`.

`editorMachine.test.ts` exercises playback with timeline ticks — it must pass unchanged.

## Phase 5 — React layer: the provider should not subscribe to state it doesn't use

**Files:** `src/core/src/useNextEditor.ts`, `src/contexts/NextEditorProvider.tsx`

`NextEditorProviderContent` calls `useNextEditorActorBindings(actorRef, config)` but only
consumes the **action senders** from its return value. The bindings hook internally
subscribes to ~10 selectors (`isRecording`, `isPlaying`, `duration`, `currentRecording`
with `shallowEqual`, …), so the provider re-renders on every machine state transition and
recording/load change for no benefit — the actions all close over the stable `actorRef`.

Refactor inside `useNextEditor.ts`:

1. Extract the pure senders (`startRecording` … `handleRuntimeEvent`, `syncEditorRef`)
   into a subscription-free hook/factory, e.g. `useNextEditorActorActions(actorRef)`
   (plain functions closing over `actorRef`; no `useSelector` calls).
2. Extract the three effects (editor-ref sync, playback-interaction listeners, global
   space-key listener) into a hook that subscribes only to what those effects need
   (`selectIsPlaying`, `selectEditor`) and returns nothing, e.g.
   `useNextEditorInteractionEffects(actorRef, config)`.
3. `useNextEditorActorBindings` becomes a composition of (1), (2), and the existing
   state subscriptions — its return shape must stay byte-identical (it is the public
   `useNextEditor` API and feeds `UseNextEditorReturn`).
4. `NextEditorProviderContent` switches to (1) + (2) and stops calling the full bindings
   hook. Check every field of `actionsValue` still has a source; `getEditorState`/
   `getFrame` (if the provider needs them — currently it does not) can read
   `actorRef.getSnapshot()` instead of subscribing.
5. `useRecordingStreamSink(actorRef, …)` is untouched.

Success criteria: `bun run typecheck` + `npx vp test run` green, and
`NextEditorActionsContext` consumers observe an unchanged API.
