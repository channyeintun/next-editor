# `src` Review — 2026-07-06

A focused review of the main logic layers: core state machine (`src/core/src/machine`), storage/codec (`src/storage`, `src/core/src/utils`), hooks/stores (`src/hooks`, `src/stores`), and preview/runtime rendering (`src/components/preview`).

The project is mature and has been reviewed repeatedly, so this pass targets **reachable correctness bugs, races, and leaks** — not style. Most findings are narrow edge cases; each lists a concrete trigger so you can judge whether it's worth fixing. Nothing here was implemented (review-only, as requested).

Legend: **[High]** likely user-visible under realistic use · **[Medium]** reachable but narrow · **[Low]** fragility / inconsistency, not a live bug.

---

## 1. Core state machine (`src/core/src/machine`)

### [Medium] Out-of-order `EXTEND_RECORDING` can replace state with a shorter recording

`replayActions.ts` — `extendRecording` (~110-130) has no monotonicity guard (e.g. `event.recording.frames.length >= context.recording.frames.length`). If two in-flight streaming decodes resolve out of order, a stale shorter recording replaces the current one while `lastAppliedFrameIndex` stays put, so `applyFrameDelta(currentFrame, targetFrame, frameIndex)` (~177) diffs frames from unrelated recordings.

- This is the same _class_ as the previously-fixed batch remove_node desync, but via a **new** path (out-of-order streaming extension).
- **Caveat:** the append-only-superset invariant is documented at the call site (comment ~106-109); this handler deliberately trusts the upstream codec/streaming sink to emit only strictly-growing recordings. So this is an _assumption-dependent_ risk (guard the invariant here defensively, or ensure the streaming layer serializes decodes), not a standalone bug in `extendRecording`.

### [Medium] `syncPlaybackAudio` can silently drop an append while paused

`editorMachineHelpers.ts` (~690-703) — with `appendPolicy: "playing-or-finalized"`, a non-finalized append while paused sends no `APPEND_FRAGMENT` but still returns `true` ("controlling"). The `EXTEND_RECORDING` handler (`editorMachine.ts` ~594-602) proceeds as if audio is in sync.

- **Repro:** `EXTEND_RECORDING` arrives while paused, then seek forward past the previously-loaded audio boundary. `audioActor.ts` `seekTo` (~910-916) can't play the scrubbed region (buffer never advanced) until another `EXTEND_RECORDING` happens to coincide with the `playing` state.

### [Medium] `resolveWorkspaceSnapshotForReplay` delta math assumes synchronous apply

`replayState/workspace.ts` — the per-event delta sum (`getWorkspaceWidthDelta` ~28-68, consumed by `resolveWorkspaceSnapshotForReplay` ~70-114) trusts that `lastAppliedWorkspaceEventIndex` reflects what's baked into the live `sidebarWidthDelta`. Since that index is deliberately not reset on SEEK, a rapid double-seek within one macrotask (before `applyWorkspaceSnapshot` commits) can compute the second delta against an unapplied baseline. Only a real bug if `applyWorkspaceSnapshot` is async/debounced on the UI side — worth confirming it's synchronous.

### [Low] `RUNTIME_EVENT` handler ignores its event payload

`captureActions.ts` (~594-602) — re-derives the snapshot via `getRuntimeSnapshot?.()` and ignores `event`. Harmless today; a footgun if a caller ever sends event-specific runtime data expecting it to be captured.

### [Low] End-of-buffer detection may restart stretch source at wrong offset

`audioActor.ts` (~478-490) — on `finalized && inputSeconds >= duration - 0.06`, it stops then (stream mode) restarts via `startSource()` without first setting `targetTimeMs = getSourceTimelineTime()` as other call sites do. If `pendingBuffer` was consumed by a concurrent SEEK/APPEND in the same tick, the restart can begin at a wrong offset.

_Verified OK:_ `cursor.ts`/`frameDelta.ts` scans are off-by-one-safe; `preview.ts`/`slide.ts` seek-vs-forward branches diverge correctly; mouse-tracking iframe listener cleanup is symmetric. **Ruled out** (earlier draft flagged this as High): _backward seek across a file switch does not suppress frames._ `APPLY_REPLAY_STATE_ACTIONS` (`editorMachineHelpers.ts` ~455-462) runs `applyWorkspaceEventsAtTime` **before** `applyFrameAtTime` in the same transition, and it always writes `lastAppliedWorkspaceEventIndex = replayResult.nextIndex` — which `findTimedEventIndexAtOrBefore` (`cursor.ts` ~77-78) rewinds via binary search on a backward seek. So by the time `applyFrameAtTime` reads `latestWorkspaceEvent` the index already points at file A's event, and the `timestamp <` guard is correctly false. A cross-file seek also sets `pendingPlaybackEditorSync`, which suppresses frames until the Monaco model resyncs — identical, intentional behavior to a forward file switch.

---

## 2. Storage & codec (`src/storage`, `src/core/src/utils`)

### [High] "Missing segments" is indistinguishable from "recording not found"

`IndexedDBRecordingStore.ts` (~203-213) — `getEntry()` returns `null` when `concatSegments` yields `null` (zero segments) even if `metadata` was found. Callers can't tell "doesn't exist" from "metadata exists but its segment write was lost." The latter (dangling metadata, e.g. from an aborted `putMany`) gets reported as a generic decode failure, masking a distinct corruption mode.

### [Medium] `persistWorkspaceAssets` swallows IndexedDB failures

`workspaceAssetStore.ts` (~91, 117-133) — `persistQueue = persistQueue.then(run, run)` feeds a rejected prior run into `run` as the rejection handler and continues the chain. A real IDB failure (quota exceeded, blocked) is never surfaced: a later call's returned promise resolves fine even though an earlier save silently failed, and `loadWorkspaceAssetContents` later falls back to `{}` with no user-visible signal of data loss.

### [Medium] `buildSegmentChunk` writes `payload.length` unclamped

`streamingRecordingCodec/format.ts` (~207) — `view.setUint32(1, payload.length, true)` with no `clampU32`, unlike every sibling field. `setUint32` throws `RangeError` outside `[0, 0xFFFFFFFF]`. Low likelihood (needs a ~4GB payload) but inconsistent with the footer path's deliberate descriptive guard (`buildFooterChunk` ~229-233).

### [Low] `RecordingStorage.clear()` doesn't wrap errors

`RecordingStorage.ts` (~456-458) + `IndexedDBRecordingStore.clear()` (~310-326) — unlike `save`/`delete`/`exportAsFile`, `clear()` has no try/catch, so a quota/abort surfaces as a raw `DOMException` instead of the wrapped `Error` used elsewhere.

### [Low] `resolveClusterIndexForTime` assumes sorted clusters

`streamingRecordingCodec/clusters.ts` (~35-41) — the backward linear scan assumes clusters are sorted by `startTimeMs` ascending. Encode-side callers pass sorted data today (unreachable), but there's no defensive sort/assert for a tampered/hand-built stream.

---

## 3. Hooks & stores (`src/hooks`, `src/stores`)

### [High] `useAudioRecording` leaks the mic if unmounted mid-recording

`core/src/hooks/useAudioRecording.ts` — `stopRecording` (~96-119) _does_ stop the `MediaStream` tracks (`stream.getTracks().forEach(t => t.stop())`, ~104), so the normal stop path is clean. The gap is the **unmount-while-recording** case: there is no `useEffect` cleanup to stop tracks if a consumer unmounts before `stopRecording` is called (navigation, error boundary). In that window the mic stream runs indefinitely (browser mic indicator stays on, resource leak). Fix: add an unmount effect that stops the recorder/tracks.

### [High] `fetchNextEditorFile` has no staleness/cancellation guard

`useUrlLoader.ts` (~486-537) — no generation token or `AbortController`. Overlapping calls run `loadRecording`/`extendRecording`/`resolveExternalMedia` concurrently against the same actor, and a slow first request's late writes can land after a faster second request's `loadRecording`, overwriting newer state with stale media/caption data. Reachable two ways: (a) `retry()` (`useUrlQuery.ts` ~48-54) fired while a prior load is still in flight; (b) a genuine `?url=` change re-firing the loader effect (`useUrlQuery.ts` ~40-46) before the previous load finishes. Worse, the out-of-band tails — `fetchSiblingCaptions(...).then(addCaptionTrack)` (~520-524) and `void resolveExternalMedia(...)` (~527-529) — are deliberately **not awaited**, so they outlive the `fetchNextEditorFile` promise and can resolve well after a newer recording has loaded.

### [Medium] `useDragAndDropUrl` fetch has no unmount guard

`useDragAndDropUrl.ts` (~64-67) — `fetchNextEditorFile(text)` fires from the `drop` handler with no guard; an in-flight fetch after unmount still calls `loadRecording`. Part of the same unguarded-async pattern as the loader above.

### [Low] `useCollapseTransition` mutate-then-return ref pattern

`useCollapseTransition.ts` (~37-77) — `previousCollapsedRef` is mutated in the effect body; correctness under Strict Mode double-invocation relies on synchronous mount-order effects. Works today; fragile vs. deriving the ref during render.

### [Low] `useGitHubStars` isn't truly fire-once

`useGitHubStars.ts` — no `enabled` gate; despite the comment implying fire-once, the query still runs on mount and a rate-limited request retries (per the client's `retry: 1` in `queryClient.ts`, so 1 retry — not 3×) before falling back to `undefined`. `staleTime`/`gcTime: Infinity` do prevent auto-refetch, so the "cached for the session" intent mostly holds; the caveat is only the mount-time run + single retry.

_Verified OK:_ `workspaceStore`, `apiClientStore`, `captionStore`, `runtimePanelStore`, `slidesStore`, `previewAdapterHandle`, `useCaptionStore`, `useNextEditorContext`, `useWorkspace`, `useWebContainerRuntime`, `useRecordingStreamSink`, `useNextEditor` (deliberate ref re-assertion). **Ruled out** (earlier draft flagged `useUrlQuery`'s `searchParams` as an unstable-identity Medium): react-router v8's `useSearchParams` memoizes on `[location.search]` (`react-router/dist/.../lib/dom/lib.js` ~757), so the loader effect only re-fires on a real query-string change, not on every render — it is _not_ a fresh object each render.

---

## 4. Preview & runtime rendering (`src/components/preview`)

### [High] `IFRAME_INTERACTION` branch dereferences `payload` without validating it

`usePreviewMessageBridge.ts` (~174, 252) — every other message branch guards `payload` first (via `isRecord()` in the initial-document/patch-batch validators, or optional chaining / truthy checks elsewhere); the `IFRAME_INTERACTION` path reads `payload.type === "mousemove"` directly. Any `postMessage({type:"IFRAME_INTERACTION"})` (no `payload`) whose `event.source` matches the tracked iframe's `contentWindow` throws inside the global message handler. Unreachable only because the paired injected script always includes `payload`; a future/same-origin sender omitting it will throw.

### [Medium] Scroll-sync RAF is never cancelled

`usePreviewPlaybackRegistration.ts` (~348-417) — `rafRef.current = requestAnimationFrame(...)` scheduled inside `snapshotApplier.current` is never `cancelAnimationFrame`'d on unmount or container/patch-replay change (contrast the sibling `rrwebReplayerRef` teardown at ~128-136). Dangling RAF; low impact today (callback guards `iframeRef.current`), but escalates if `iframeRef.current` is reused for a new iframe before the stale RAF fires — it would apply a stale scroll target to the new iframe.

### [Medium] `patchChildNodes` is positional-only diffing

`previewIframeUtils.ts` (~96-117) — no key/identity matching. A non-trailing insertion/removal misaligns all subsequent siblings, so `patchNode` mutates the wrong element's attributes/text. This is the static/runtime snapshot-fallback patcher (not rrweb replay), reachable whenever `patchIframeContentFromHtml` reconciles two snapshots differing by a mid-list change. Confirm it's intentionally scoped to append/trim-only diffs.

### [Low] Message-bridge origin trust & fragile effect deps

- `usePreviewMessageBridge.ts` guards only on `event.source` (no `event.origin`) — consistent with the codebase's WebContainer trust model; noted, not flagged.
- `usePreviewController.ts` (~756-761) — `runtimePreviewSrcNeedsReset` effect keys on `panelMode`/`previewVersion`, unrelated to the src comparison; harmless given the attribute guard, but a fragile dep list that would reintroduce the historical reload-on-switch bug if the guard were removed.

_Verified OK:_ rrweb replay ordering (`buildRrwebReplayEvents`/`RrwebPreviewReplayer`), resize/size math (NaN-safe clamping), `useApiClient`/`usePreviewInteractionCapture` cleanup. Ruled out: `PreviewEvent.timestamp` mixing `Date.now()`/`performance.now()` — `recordingSession.ts` overwrites `.timestamp` with its relative clock before persisting.

---

## Suggested priority order

1. **`useAudioRecording` mic cleanup** (§3) — clear user-facing impact (unmount-mid-recording only), simple fix.
2. **`fetchNextEditorFile` staleness guard** (§3) — stale-overwrite race on real navigation/retry, widened by the un-awaited caption/media tails.
3. **`IFRAME_INTERACTION` payload guard** (§4) — cheap defensive fix aligning with sibling branches.
4. **`persistWorkspaceAssets` error surfacing** (§2) — silent data loss is worth at least logging.

The remaining Medium/Low items are edge-case hardening and consistency cleanups; safe to defer.
