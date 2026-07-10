# Whiteboard Feature — Implementation Plan

Status: **plan only, not implemented**. Written 2026-07-10 after codebase + library research.

## 1. Goal & scope

Add a whiteboard the presenter can draw on while recording, with strokes/shapes **recorded on the shared audio-anchored timeline and replayed deterministically** like every existing track (editor frames, cursor, preview, workspace, runtime, slides).

**v1 scope**

- Freehand drawing, shapes, arrows, text, select/move/delete, undo/redo (all free from the library).
- Record: incremental scene deltas + periodic keyframes + panel visibility.
- Replay: scene reconstructed at any `currentTime`, forward playback and arbitrary seek (both directions), read-only during playback.
- Dark/light theme, lazy-loaded chunk.

**Non-goals (v1)** — image/file embeds in the whiteboard (binary blobs would bloat the `.ne`), collaboration, laser-pointer tool, exporting the board as an image. Listed as follow-ups in §11.

## 2. Library decision: Excalidraw (`@excalidraw/excalidraw`)

| Option                           | License                                                                                               | Record/replay API                                                                                                                                                                   | Verdict                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Excalidraw**                   | MIT, no restrictions                                                                                  | `onChange(elements, appState, files)` full-array snapshots; deltas derivable via per-element `version`/`versionNonce`; `excalidrawAPI.updateScene()` + `viewModeEnabled` for replay | **Chosen**                                                                                                                       |
| tldraw v5                        | Proprietary; production needs a paid license key, watermark otherwise, enforcement built into the SDK | Technically nicer (`store.listen` emits native `RecordsDiff` deltas)                                                                                                                | Rejected on license alone                                                                                                        |
| Custom canvas (perfect-freehand) | MIT, ~6 KB                                                                                            | Full control, trivially deterministic                                                                                                                                               | Rejected: months of work for shapes/text/selection/undo we'd get for free; keep as fallback only if Excalidraw integration fails |
| react-konva / fabric.js          | MIT / Apache-2                                                                                        | Generic 2D libs, no whiteboard semantics                                                                                                                                            | Rejected                                                                                                                         |

Why Excalidraw wins despite tldraw's better change API: the delta derivation we must write for Excalidraw is small, pure, and unit-testable (§4), while tldraw's license/watermark is a hard product constraint. Excalidraw is actively maintained (0.18.x as of mid-2026), React 19 compatible, MIT, and its scene JSON is stable and versioned.

Known costs, accepted:

- **Bundle size** — several hundred KB gzipped. Mitigated: lazy `lazy(() => import(...))` chunk exactly like `Preview` ([CodeEditor.tsx:32](src/components/CodeEditor.tsx)). Never loaded unless the panel is opened or a recording contains a whiteboard track. No impact on the mobile landing path.
- **onChange gives full arrays, not deltas** — we diff by `(id, version)`; see §4.
- **onChange fires per pointer-move while drawing** — we throttle/coalesce at capture; see §4.

## 3. Architecture: a new track, same shape as the existing ones

The system is already built for this. Verified extension points:

- **Segment format is forward-compatible**: `SEGMENT_KIND` is `frames(0) … cursor(7)` and the format doc says _"8+ are free for future segment kinds"_; every segment is self-delimiting so **old players skip an unknown whiteboard segment instead of crashing** ([format.ts:44-78](src/storage/streamingRecordingCodec/format.ts)). No `meta.version` bump needed (stays `4`; we only add optional fields).
- **Closest analog is the slide track**: store → `getSlideState`/`applySlideState` config callbacks → machine event → session buffer → segment → replay action. The whiteboard track copies this pipeline end to end ([NextEditorProvider.tsx:183-217](src/contexts/NextEditorProvider.tsx:183), `SLIDE_EVENT` at [editorMachine.ts:430](src/core/src/machine/editorMachine.ts:430)).
- **Keyframe+delta reconstruction** is the same idea the editor frames track already uses (`keyframeInterval` in meta), applied to scene elements instead of text.

```
record:  Excalidraw onChange ──throttle──▶ whiteboardStore ──handleWhiteboardEvent──▶
         WHITEBOARD_EVENT ──captureWhiteboardEvent──▶ session.whiteboardEvents[]
         (timestamp = performance.now() - session.startedAtPerf)

encode:  whiteboardEvents ──▶ SEGMENT_KIND.whiteboard(8), msgpack+zlib, clustered

replay:  TICK/SEEK ──applyWhiteboardEventsAtTime──▶ reduce(keyframe ≤ t, deltas ≤ t)
         ──applyWhiteboardState──▶ whiteboardStore ──▶ excalidrawAPI.updateScene()
         (viewModeEnabled during playback)
```

**Timestamping rule (learned the hard way with rrweb):** timestamps are assigned in the capture action from `performance.now() - session.startedAtPerf`, never from `Date.now()` inside the widget — this is what caused the preview-replay timeline drift and its rebasing fix. The whiteboard track avoids the entire problem class by construction.

## 4. Data model

```ts
// src/core/src/whiteboard.ts (new)
interface WhiteboardKeyframeEvent {
  type: "keyframe";
  timestamp: number; // ms since startedAtPerf
  elements: ExcalidrawElementJSON[]; // full scene incl. isDeleted:true elements
  view?: { scrollX: number; scrollY: number; zoom: number };
}

interface WhiteboardDeltaEvent {
  type: "delta";
  timestamp: number;
  upserts?: ExcalidrawElementJSON[]; // new or changed elements, full element JSON
  removedIds?: string[]; // hard-removed (vanished from the array)
  view?: { scrollX: number; scrollY: number; zoom: number }; // only when changed
}

interface WhiteboardVisibilityEvent {
  type: "visibility";
  timestamp: number;
  isOpen: boolean;
  isMaximized?: boolean;
}

type WhiteboardRecordingEvent =
  | WhiteboardKeyframeEvent
  | WhiteboardDeltaEvent
  | WhiteboardVisibilityEvent;
```

Design decisions:

- **Delta derivation** (pure function, the heart of the feature): keep the previous elements array indexed by `id → version`; on each (throttled) `onChange`, an element is an _upsert_ if its `id` is new or its `version` changed, a _removal_ if its `id` vanished. Soft deletes arrive naturally as upserts with `isDeleted: true`. Full element JSON per upsert is fine — elements are small (~300–800 B raw) and segments are msgpack+zlib'd ([format.ts:40](src/storage/streamingRecordingCodec/format.ts)); do **not** add per-field diffing or dmp on element JSON without measured numbers.
- **Verify at implementation time** whether `onChange` elements include `isDeleted` elements in the installed version; if not, use `excalidrawAPI.getSceneElementsIncludingDeleted()` in the capture path. This is the one API detail research could not pin down definitively.
- **Throttle/coalesce at ~100 ms** (leading + trailing) while a stroke is being drawn. Freehand elements grow their `points` array continuously, so successive upserts of the same element make the stroke _animate_ on replay — we get progressive drawing for free.
- **Keyframes**: emit a full-scene keyframe at recording start (in `initRecordingSession`, like the workspace/runtime snapshots, [captureActions.ts:193-294](src/core/src/machine/captureActions.ts)) and then every N deltas (start with N=200) or 15 s, whichever first. Bounds seek cost: reconstruct = nearest keyframe ≤ t, then apply ≤ N deltas.
- **Viewport (`view`)**: recorded, coalesced with the same throttle — presenter panning/zooming is part of the presentation. Compared with epsilon to avoid noise events.
- **`files` (images)**: explicitly not recorded in v1; image tool hidden via Excalidraw UI options.

## 5. Capture side — file-by-file

All locations verified against the current tree.

1. **`src/core/src/whiteboard.ts`** (new) — the types above + `deriveWhiteboardDelta(prevIndex, elements)` pure helper + `reduceWhiteboardEvents(events, uptoIndex)` pure reducer (shared by replay and tests).
2. **[types.ts:98-152](src/core/src/machine/types.ts:98)** — add `whiteboardEvents: WhiteboardRecordingEvent[]` to `RecordingSession` (append-only, same mutation contract as the other arrays — push in place, bump `sessionRevision`).
3. **[captureActions.ts](src/core/src/machine/captureActions.ts)** — `whiteboardEvents: []` in `initRecordingSession` (+ initial keyframe via a new `getWhiteboardState` config callback, mirroring `getSlideState`); new `captureWhiteboardEvent` action (no-op when no session, like the others).
4. **[editorMachine.ts](src/core/src/machine/editorMachine.ts)** — `WHITEBOARD_EVENT` handler in the `recording` state next to `SLIDE_EVENT` (line 430); register the action.
5. **Sender plumbing** — `handleWhiteboardEvent` in `useNextEditorActorActions` and `NextEditorProvider`'s `actionsValue` ([NextEditorProvider.tsx:102-132](src/contexts/NextEditorProvider.tsx:102)). Keep senders subscription-free like the rest of that provider.
6. **`UseNextEditorConfig`** — add `getWhiteboardState?: () => WhiteboardSceneState | null` and `applyWhiteboardState?: (state) => void`, wired to the whiteboard store exactly like `getSlideState`/`applySlideState` ([NextEditorProvider.tsx:183-217](src/contexts/NextEditorProvider.tsx:183)).

## 6. Serialization — file-by-file

7. **[format.ts:67-78](src/storage/streamingRecordingCodec/format.ts:67)** — `whiteboard: 8` in `SEGMENT_KIND`. Optional `RecordingStreamMeta.whiteboardSnapshot` is **not** needed (the t=0 keyframe lives in the track), keeping meta untouched.
8. **[encode.ts:320-326](src/storage/streamingRecordingCodec/encode.ts:320)** — `queueClusteredEventSegments(SEGMENT_KIND.whiteboard, normalized.whiteboardEvents, 1)` alongside the other tracks; include in `normalizeRecording` and the tracks/clusters derivation.
9. **[decode.ts](src/storage/streamingRecordingCodec/decode.ts)** — `case SEGMENT_KIND.whiteboard` in **both** switch sites (~line 237 batch path and ~line 409 streaming path), appending to `recording.whiteboardEvents`.
10. **`Recording` type** (`src/core/src/types.ts`) — optional `whiteboardEvents?: WhiteboardRecordingEvent[]`.
11. **Live-stream sink** — `useRecordingStreamSink` path picks the new array up automatically once the encoder does; verify with the existing round-trip tests.

Compatibility: old builds reading a new `.ne` skip kind 8 (self-delimiting segments); new builds reading old `.ne` files see no whiteboard segments → track absent → panel never forced open. No migration.

## 7. Replay side — file-by-file

12. **`src/core/src/machine/replayState/whiteboard.ts`** (new) — `getWhiteboardReplayResult({ events, currentTime, lastAppliedIndex })` using the `advanceReplayCursor` pattern from [replayState/cursor.ts](src/core/src/machine/replayState/cursor.ts) (binary search + bounded linear scan). Forward tick: apply only new events since `lastAppliedIndex`. Seek (index reset to −1) or any backward jump: locate nearest keyframe ≤ t, reduce forward — the reducer output is a full scene, applied as one `updateScene`.
13. **[replayActions.ts](src/core/src/machine/replayActions.ts)** — `applyWhiteboardEventsAtTime` calling `context.applyWhiteboardState`; reset `lastAppliedWhiteboardEventIndex = -1` in the SEEK reset block (~line 278, with preview/slide/runtime — _not_ the workspace-style no-reset, since our state is absolute).
14. **[editorMachine.ts](src/core/src/machine/editorMachine.ts)** — register the action, add it to `APPLY_REPLAY_STATE_ACTIONS`, add the context fields (`lastAppliedWhiteboardEventIndex`, `applyWhiteboardState`).
15. **Playback rendering** — during `playback.*`, the whiteboard renders `viewModeEnabled` (Excalidraw's controlled read-only mode) and visibility events open/close the panel. `updateScene` is called through the store→component bridge; scene equality short-circuit in the store prevents redundant updates (same pattern as `applySlideState`'s change check).

## 8. UI

- **`src/stores/whiteboardStore.ts`** (new) — `createStore` from `@xstate/store` (project convention; no Zustand, no hand-rolled `useSyncExternalStore`): `{ isOpen, isMaximized, scene: { elements, view }, mode: "live" | "replay" }`.
- **`src/components/WhiteboardPanel.tsx`** (new, `lazy()` like `Preview`) — hosts `<Excalidraw excalidrawAPI={...} onChange={...} viewModeEnabled={mode === "replay"} theme={...}>`; imports `@excalidraw/excalidraw/index.css` inside the lazy chunk. Rendered as a maximizable overlay like `SlidePanel` ([SlidePanel.tsx](src/components/SlidePanel.tsx)) rather than a fourth dock — no new workspace-width delta events needed, and visibility is recorded in the whiteboard track itself.
- **Toggle button** in the toolbar next to the slides control; opening/closing during recording emits a `visibility` event.
- **No `useCallback`/`useMemo`** for referential stability (React Compiler handles it); note the compiler skips hookless `use*` functions, so keep the throttle state in the store or a ref inside a component that calls hooks.
- Dark mode: pass the app theme to Excalidraw's `theme` prop.

## 9. Performance notes

- Capture cost: one `(id, version)` map diff per throttled onChange — O(elements), scenes are typically < 500 elements. Session arrays stay append-only/O(1) push per the `RecordingSession` contract.
- Size estimate: a 10-minute talk with heavy drawing ≈ a few thousand delta events; msgpack+zlib should land well under the preview track's weight. Measure in the round-trip test; don't optimize past that without numbers.
- Excalidraw chunk loads only when the panel opens or a loaded recording contains whiteboard events.

## 10. Testing & verification

Per project practice: `npx vp test run` (never bare vitest), plus `tsc` typecheck. No Claude preview-browser verification — user eyeballs the UI.

- **Unit (pure, highest value)**: `deriveWhiteboardDelta` (new/changed/vanished/soft-deleted elements, view epsilon), `reduceWhiteboardEvents` determinism (reduce(all) === reduce(keyframe)+deltas), keyframe cadence.
- **Replay cursor**: forward ticks, seek backward, seek before first event, seek past end — mirror the existing `replayState` tests.
- **Codec round-trip**: recording with whiteboard events → `encodeRecordingToStream` → `decodeRecordingStream` → deep-equal; plus old-reader-skips-kind-8 tolerance (decode a stream containing kind 8 with the kind's case removed is already covered by format design, but add a truncation/skip test alongside existing codec tests).
- **Machine test**: extend `editorMachine.test.ts` pattern — record session captures `WHITEBOARD_EVENT`, playback invokes `applyWhiteboardState`.

## 11. Phased milestones (decomposition for implementation)

Phases are sequential; **within** each phase the starred items are independent and parallelizable.

- **Phase 0 — spike (½ day)**: install `@excalidraw/excalidraw` (with **bun**), lazy-mount it, confirm onChange semantics (incl. the `isDeleted` question in §4), measure actual gzipped chunk size. Abort criteria → fall back to custom canvas only if onChange/updateScene can't round-trip a scene.
- **Phase 1 — core data (parallel⭐)**: ⭐ `whiteboard.ts` types + derive/reduce helpers + unit tests; ⭐ codec changes (format/encode/decode) + round-trip test; ⭐ machine capture wiring (types/captureActions/editorMachine/senders).
- **Phase 2 — replay**: replayState/whiteboard.ts + replayActions + machine wiring + tests (depends on Phase 1).
- **Phase 3 — UI**: whiteboardStore, WhiteboardPanel, toolbar toggle, provider config callbacks, theming.
- **Phase 4 — integration pass**: end-to-end manual recording/replay/seek check by the user, size measurement, `tsc` + full test run.

Note for implementation sessions: serialize any subagent commits (pre-commit stash/pop collides on parallel commits).

## 12. Risks & open questions

1. **`onChange` and deleted elements** — must verify in the pinned version whether soft-deleted elements are included; fallback API exists (§4). _Resolved in Phase 0._
2. **Excalidraw version pinning** — pin exact version in package.json; its scene schema is versioned but the React API has moved between 0.x minors.
3. **Undo during recording** — arrives as ordinary version-bumped upserts; replay shows the undo happening. Expected behavior, but confirm it feels right.
4. **Live board state vs playback** — when the user plays a recording while having their own live drawing open, playback overwrites the store. v1: snapshot/restore live scene around playback, or simply clear on playback start (decide in Phase 3; slides have the same semantics today).
5. **tsgo/xstate constraint** — xstate is pinned at 5.32.2 (tsgo stack-depth bug); new machine context fields are fine, but don't bump xstate while adding them.
6. **Text tool fonts** — Excalidraw lazy-loads its fonts; verify they load under the app's CSP/asset setup during Phase 0.

## 13. Follow-ups (post-v1)

- Image/file embeds (store blobs as sibling files like audio/camera, referenced from elements).
- Laser-pointer/ephemeral ink (record as its own transient event type, replay with fade-out).
- Export board as PNG/SVG from `exportToBlob`.
- Whiteboard-only lessons (recording with no editor frames).
