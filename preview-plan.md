# Preview (iframe) Record & Replay — Design Review & Plan

> Scope decision (from you): **Preview area only.** The recording engine
> (timeline state machine, `streamingRecordingCodec`, segment kinds, IndexedDB
> store, seek logic) is **not** being redesigned — it stays a fixed transport that
> carries opaque JSON records per segment.
>
> Direction decision (from you): **Adopt a mature library (rrweb-style)** for the
> in-iframe DOM + scroll record/replay, instead of continuing to harden the
> hand-rolled MutationObserver differ.
>
> Compatibility decision (from you): **No legacy. Old recordings do not need to
> play.** The custom runtime recorder + patch-apply engine are **deleted outright**
> and fully replaced by rrweb — no format discriminator, no fallback applier, no
> migration path. (Verified: the custom patch format is emitted _only_ by the
> runtime preview; `"static-preview"` is a dormant type-union member nothing
> produces — static/slide previews use full-snapshot content and are unaffected.)

---

## 1. Goal (restated)

For the **runtime (node.js) preview iframe**:

1. **Record** the preview as compact diffs/deltas of the live DOM across frames
   (never store a full HTML document per frame).
2. **Replay** by applying those deltas into a sandboxed iframe, reproducing
   _exactly_ what happened — including at the **actual float/unfloat viewport
   size** of each moment.

Everything works today except **edge cases**, most visibly:

- The preview goes **empty** during replay (on float, and as the replayed cursor
  drifts over the iframe).
- **Scroll position is inconsistent** across recordings, worst for the
  **virtualized list** in the default project (`useWindowVirtualizer`,
  `src/types/workspace.ts:687`).

---

## 2. How it works today (current architecture)

### Recording (runtime preview)

- `injectRuntimeSnapshotScript` (`src/contexts/webContainerRuntimeSupport.ts:601`)
  injects an inline `<script>` into the served `index.html` of the WebContainer
  app. That script runs **three** recorders inside the preview page:
  1. `createRuntimePatchRecorderScript` (`webContainerRuntimeSupport.ts:136`) — a
     `MutationObserver` DOM differ. Emits one **initial document** (full
     `documentElement.outerHTML`) then **patch batches** (one per animation
     frame) of ops: `insert_node`, `remove_node`, `move_node`, `replace_subtree`,
     `set_text`, `set_attribute`, `remove_attribute`, `set_property`.
  2. `createIframeInteractionCaptureScript` (`src/utils/iframeInteractionCapture.ts`)
     — click/scroll/input/focus/key/mousemove → `IFRAME_INTERACTION` messages.
  3. console bridge.
- Node identity: a `WeakMap` assigns `n{N}` ids, **written as the attribute
  `data-next-editor-preview-node-id` on elements only**. Text/comment nodes can't
  hold attributes, so they're referenced positionally:
  `{ anchorId: parentMarkerId, path: [childIndex] }`
  (`createNodeRef`, `webContainerRuntimeSupport.ts:248`).
- The host bridge (`src/components/preview/usePreviewMessageBridge.ts`) validates
  and forwards: initial documents → `previewInitialDocuments`, patch batches →
  `previewPatchBatches`, scroll/interactions → `previewEvents`
  (`preview_scroll`, `preview_interaction`, …).
- These three arrays are appended to the recording session
  (`src/core/src/machine/recordingSession.ts`) and persisted by the engine as
  segments `preview` / `previewDoc` / `previewPatch`
  (`src/storage/streamingRecordingCodec.ts:63`, `STREAM_FORMAT_VERSION = 2`).

### Replay (runtime preview)

- The replay iframe is **not** the live `:PORT` app. It's a same-origin iframe
  seeded with the recorded initial document, with scripts **neutralized**
  (`createPatchReplaySeedFromHtml`, `previewIframeUtils.ts:606`), then driven by
  recorded patch batches.
- **Two independent appliers**, on two independent cursors:
  - **DOM patch applier** (`usePreviewPlaybackRegistration.ts:241` →
    `applyPreviewDomPatchBatchToIframe` in `previewIframeUtils.ts:489`). Resolves
    refs via `findNodeByPreviewRef` (`previewIframeUtils.ts:257`): element refs by
    marker id (stable), **non-element refs by walking `parent.childNodes[index]`**.
  - **Scroll / interaction applier** (`usePreviewPlaybackRegistration.ts:407`,
    the `setSnapshotApplier`). Re-asserts `scrollTop/scrollLeft` via a `rAF` and
    `scrollTo`, resolving the scroll target by XPath.
- Apply is **best-effort**: an op whose node can't be resolved is **skipped**
  (`previewIframeUtils.ts:516`), and a **one-shot** re-seed + fast-forward
  (`patchReplayDriftRef` / `patchReplayResyncAttemptedRef`,
  `usePreviewPlaybackRegistration.ts:153`) tries to recover **once**, then gives up.

---

## 3. Diagnosis — why it fails (two coupled root causes)

This is **architectural**, not a stray bug. There are two decouplings, both of
which bite hardest exactly in a high-churn virtualized list.

### Root cause A — positional node refs drift across a serialize/reparse boundary

- Stable identity exists **only for elements** (attribute-based). **Text/comment
  nodes, and the `index` field of every insert/remove/move op, are positional**
  — computed against the **live** recording DOM's `childNodes`.
- On replay they're resolved against a **serialized-then-reparsed** DOM (the seed
  is `outerHTML` → `DOMParser`; `replace_subtree`/`insert_node` payloads are HTML
  re-parsed too). HTML serialize→parse is **not** node-identity preserving:
  whitespace text nodes collapse, adjacent text nodes merge, table foster-parenting
  moves nodes, raw-text elements (`<style>`/`<textarea>`) differ, `<head>/<body>`
  auto-correction, plus the injected `<base>`. So `childNodes` indices shift.
- Element refs survive (marker id). **Non-element refs and op indices drift.**
  Your memory note's smoking gun is exactly this: a **batch-1 `remove_node` of a
  text/comment node** misses its target (`Missing target node`,
  `usePreviewPlaybackRegistration.ts:318`).
- Because apply is **best-effort skip** and recovery is a **bounded one-shot**, a
  single drifted index isn't corrected — and in a virtual list (rows constantly
  inserted/removed/`translateY`'d, many text nodes per post) the drift **compounds
  every frame** until the list renders empty.

> This is a _tolerate-drift_ recovery model layered on a _drift-prone_ reference
> model. The two combine to guarantee eventual divergence in the churny case.

### Root cause B — scroll and DOM are two unsynchronized streams

- In the live app, scroll and the rendered rows are **causally coupled**: scroll →
  `useWindowVirtualizer` → new rows + new spacer height + new `translateY`.
- In the recording they're split into **two streams** (scroll in `previewEvents`,
  DOM in `previewPatchBatches`) and on replay applied by **two appliers with
  independent cursors/timing**. The virtualizer **does not run** in replay
  (scripts neutralized), so the rows for a scroll position exist _only if_ the DOM
  patches that created them have already been applied.
- If `scrollTop` is asserted before/without the matching DOM (or the spacer
  `.timeline` height hasn't been patched to size yet), the browser **clamps**
  scrollTop to the current (too-short) `scrollHeight` → you land on an empty
  region or snap to top → **empty / wrong scroll**. This is independent of, and
  additive to, root cause A.
- The default list uses `useWindowVirtualizer` → the scroll is the **document**
  scroll inside the runtime iframe, the spacer height is an inline style on
  `.timeline` (`workspace.ts:757`), and each row is absolutely placed via inline
  `transform: translateY(...)` (`workspace.ts:762`). All of that is recorded as
  attribute/childList mutations whose **ordering vs. the scroll assertion is not
  guaranteed** on replay.

### Why this is a bottleneck, not an implementation detail

The system is a _partial_ re-implementation of rrweb that took one shortcut
(ids for elements only; positional refs for everything else) and one risky
recovery posture (skip + one-shot). Both shortcuts are load-bearing and both fail
in the same scenario. You can keep patching symptoms, but each fix only closes one
surface of a single root.

---

## 4. Why the last commit (`78d955d`) didn't fix it

`78d955d` made three changes:

1. `replayState.ts:236` — stop re-asserting recorded scroll on `preview_float` /
   `preview_unfloat` (carry it forward for seeks, but don't apply on the mode
   change). This is a **targeted patch on one manifestation of root cause B** (the
   reflow at float/unfloat). It does nothing for normal scrubbing/seeking scroll
   desync, and nothing for root cause A.
2. `usePreviewController.ts` `forceIframeRepaint()` — a `translateZ(0)` compositor
   nudge. This addresses a _paint_ hypothesis, but per your memory note the empty
   preview is **DOM desync**, not a paint/compositing problem — so this is a
   no-op for the real failure.
3. Added tests for non-element node removal — useful, but they exercise tiny
   hand-built DOMs, not the dense virtual-list mutation stream where index drift
   actually accumulates.

Net: it fixed a small real bug (float/unfloat scroll jump) and added a paint
band-aid, but the headline empty/scroll-drift issue (roots A + B) was untouched.
The fact that a focused fix "didn't resolve it" is itself the tell that the
failure has multiple surfaces fed by one architectural root.

---

## 5. Verdict

**Current design is not good enough for the virtualized case**, and the gap is
architectural. The right move (your call) is to **replace the hand-rolled
in-iframe record/replay with rrweb**, which is purpose-built for exactly this and
eliminates both roots by construction:

- rrweb assigns a stable id to **every node including text/comment**, carried in
  the **serialized full snapshot** and referenced by id in every incremental
  mutation — **no positional index, no serialize/reparse drift** (kills root A).
- rrweb records scroll/input/mouse **in the same incremental event stream** as
  DOM mutations and its `Replayer` applies them **in one ordered timeline** — DOM
  and scroll stay coupled (kills root B).
- rrweb rebuilds from a serialized snapshot and **does not execute page scripts**
  in replay — same security posture we already rely on.

---

## 6. Target design (rrweb, scoped to the Preview area)

Keep the recording engine as an opaque transport. Change only **what the preview
puts into the records** and **how the preview replays them**.

### 6.1 Recording side

- **Inject rrweb `record` (record-only build) into the runtime preview page**,
  replacing `createRuntimePatchRecorderScript` (and the inner scroll/input/mouse
  parts of `createIframeInteractionCaptureScript`) for runtime previews.
  - Inline the rrweb record bundle as a string the same way the current recorder
    is inlined (an IIFE injected via `injectRuntimeSnapshotScript`,
    `webContainerRuntimeSupport.ts:601`). Vendor a prebuilt record-only bundle and
    inline it (e.g. a `?raw` import / generated asset) so the WebContainer app
    needs **no** new dependency in its own `package.json`.
  - Wire rrweb's `emit` to the existing `window.parent.postMessage` channel.
- **Map rrweb events onto the existing two preview segments** so the engine is
  untouched:
  - rrweb **FullSnapshot** (+ Meta) → `previewInitialDocuments` records.
  - rrweb **IncrementalSnapshot** (mutations, scroll, input, mouse, viewport) →
    `previewPatchBatches` records (one rrweb event per record, or batched per
    frame — keep the per-frame batching to preserve segment clustering).
  - Each record keeps the existing envelope fields the engine/seek rely on
    (`time`, `documentId`, monotonic ordering). **No discriminator needed** —
    runtime previews are 100% rrweb, so `previewInitialDocuments` /
    `previewPatchBatches` carry only rrweb events.
  - **No change** to `streamingRecordingCodec.ts`, `recordingSession.ts`,
    segment kinds, or the seek machine — they keep carrying opaque JSON.
- **Panel-level events stay in `previewEvents`** (open/close/float/unfloat/resize,
  route change). These drive panel **size/mode**, which is what satisfies the
  "play at the actual float/unfloat view size" constraint. rrweb owns only the
  **inside-iframe** content (DOM + inner scroll + inputs).
- Configure rrweb record for fidelity vs. size: `inlineStylesheet: true`,
  `recordCanvas` off by default, `collectFonts` as needed, `sampling` tuned for
  scroll/mousemove. (rrweb already coalesces; we keep our per-frame flush.)

### 6.2 Replay side

- **Delete** the custom applier (`usePreviewPlaybackRegistration.ts:241`) and the
  custom apply engine (`applyPreviewDomPatchBatchToIframe` + the whole op-apply /
  node-ref / seed-patch machinery in `previewIframeUtils.ts`) and replace with an
  **rrweb `Replayer`** instance bound to our existing replay iframe/panel.
  - Drive it from the **existing seek-aware applier signature**
    (`PreviewPatchReplayInput`: `currentTime`, `isSeeking`, the record arrays):
    on each tick/seek call `replayer.pause(currentTime - recordingStartOffset)`,
    which **applies all events up to that offset deterministically** (perfect for
    scrubbing). Disable rrweb's own player UI and let our timeline machine remain
    the single clock.
  - Feed the Replayer the reconstructed rrweb event list (FullSnapshot from
    `previewInitialDocuments` + incrementals from `previewPatchBatches`, merged
    and time-sorted — the engine already sorts these segments).
- **Viewport / float-unfloat fidelity (hard requirement):**
  - Keep panel **size/mode** replay via `previewEvents` (unchanged) so the panel
    is the same dimensions at replay time as at record time.
  - Make the rrweb replay iframe **fill the panel** (responsive width/height)
    rather than rrweb's default Meta-driven fixed pixel size. Because we replay
    the _recorded_ DOM mutations (exact rows, exact `translateY`, exact spacer
    height) and size the panel to match the recording, the result is faithful at
    both float and unfloat sizes **without** re-running the virtualizer.
  - This is the key win: scroll is replayed **inside the rrweb stream**, coupled
    to the DOM, so the empty/clamped-scroll failure cannot occur.
- **Retire the decoupled scroll path for runtime previews**: the
  `preview_scroll`/`setSnapshotApplier` scroll re-assertion
  (`usePreviewPlaybackRegistration.ts:477`) is no longer used for runtime (rrweb
  owns inner scroll). It can remain for the **static** preview (see 6.3).

### 6.3 Static / slide previews (untouched — not legacy)

- The **static workspace preview** and **slide previews** are a separate, active
  path: they replay **full-snapshot content** (`previewEvents.content` swaps) +
  `usePreviewInteractionCapture`, and never emit DOM patch batches. They don't
  have the virtualizer/desync problem, so they stay exactly as-is. (This is _not_
  the "legacy" being removed — that term refers only to old runtime recordings and
  the custom runtime patch path.) Optionally adopt rrweb for them later for
  consistency — out of scope.

### 6.4 Cursor overlay

- The replayed "fake cursor" is a separate system (`cursorReplay.ts`,
  `cursorEvents`) and stays as-is. The "empty when cursor moves over iframe"
  symptom was a desync artifact, not a cursor-system bug; it disappears once roots
  A/B are gone. (rrweb can also record pointer trails; we keep our existing cursor
  system to avoid scope creep.)

---

## 7. No backward compatibility (clean cut)

- **Old recordings do not need to play.** There is no discriminator, no routing
  branch, and no fallback applier.
- The custom runtime path is **deleted in full**:
  - the recorder: `createRuntimePatchRecorderScript` (`webContainerRuntimeSupport.ts:136`);
  - the apply engine + node-ref + seed-patch transforms in `previewIframeUtils.ts`
    (`applyPreviewDomPatchBatchToIframe`, `applyPreviewDomPatchOp`,
    `findNodeByPreviewRef`, `createNodeRef` logic, `createPatchReplaySeedFromHtml`,
    `patchIframeContentFromHtml`, etc.);
  - the custom patch loop in `usePreviewPlaybackRegistration.ts` and its
    drift/resync state;
  - the per-op validators in `usePreviewMessageBridge.ts` (`isPreviewDomPatchOp`,
    `isSerializedPreviewNode`, `isPreviewNodeRef`) and the custom op types in
    `slides.ts` (`PreviewDomPatchOp` & friends).
- The **segments stay the same** (`previewDoc` / `previewPatch`) but now carry
  **rrweb events exclusively**. The engine/codec don't care (opaque JSON), so they
  remain untouched.
- Net simplification: one recorder, one replayer, one format. No version branching
  anywhere.

---

## 8. Risks & open implementation decisions

1. **Replayer driving model.** Prefer rrweb `Replayer` driven by
   `pause(timeOffset)` per tick/seek (deterministic, matches our seek machine)
   over `play()` (its own timer would fight our clock). Confirm `pause` applies
   the full event prefix correctly across our seek jumps. _Fallback_: use the
   lower-level `rebuild` + `applyMutation` from `rrweb-snapshot`/`@rrweb/replay`
   if `Replayer`'s wrapper iframe/UI is too opinionated.
2. **Responsive iframe sizing.** rrweb hard-sizes its iframe from Meta; we must
   override to fill the panel for the float/unfloat constraint. Needs CSS override
   on the generated iframe and verification that layout matches recording.
3. **Bundle injection into WebContainer.** Inlining the record build adds ~tens of
   KB to the injected script. Acceptable, but verify it loads before app mutations
   so the FullSnapshot is captured cleanly (mirror the current "wait for
   DOMContentLoaded before seeding" guard, `webContainerRuntimeSupport.ts:589`).
4. **Security posture.** We currently neutralize scripts / inline handlers /
   `javascript:` URLs on replay (`neutralizeReplaySubtree`). Confirm rrweb's
   rebuild does not execute page scripts (it doesn't by default) and that our
   sandboxing (same-origin `allow-scripts` iframe) remains safe with rrweb's
   rebuilt DOM. Keep CSP/sanitization equivalent to today.
5. **Cross-origin assets.** rrweb records asset URLs; in replay they resolve
   against the WebContainer origin. Keep the `<base href>` rewrite behavior so
   images/fonts still load (today done in the seed transforms).
6. **Record size.** rrweb full snapshots can be large; ensure `previewDoc`
   clustering/segmentation in the codec still handles them (it already streams
   segments; verify no per-record size assumptions).
7. **License/footprint.** rrweb is MIT — fine. Pin a version and vendor the
   record build to keep the injected payload stable.

---

## 9. Testing & verification

- **Round-trip unit test** (extend `previewPatchReplay.test.ts`): drive rrweb
  record over a **virtual-list mutation stream** in jsdom, then replay via the
  rrweb path and assert the replayed DOM equals the final live DOM (the current
  test only covers tiny DOMs — add the churny case that actually reproduces drift).
- **Scroll-coupling test**: a recorded scroll-through of the default
  `TrendingStatusList` must, at every seek offset, show the same rows + scroll
  position as the recording (no empty, no clamp).
- **Float/unfloat fidelity test**: assert replay content matches at both panel
  sizes and that toggling float during playback does not empty the iframe.
- **Manual verification** with `/verify` or `/run` on the default project: record
  a scroll through the virtualized feed, float/unfloat mid-scroll, then scrub the
  timeline and confirm rows + scroll stay correct.

---

## 10. Phased rollout

1. **Phase 0 — spike:** vendor rrweb record-only build; inject into the runtime
   preview; confirm events arrive over the existing postMessage bridge and
   serialize through the engine unchanged (behind a flag, recording only).
2. **Phase 1 — replay:** add the rrweb `Replayer` path driven by the existing
   seek applier. Single format, no routing.
3. **Phase 2 — scroll/viewport:** retire the decoupled runtime scroll path; make
   the replay iframe responsive; verify float/unfloat + virtual-list fidelity.
4. **Phase 3 — delete the custom path:** remove the custom recorder, apply engine,
   seed-patch transforms, op types, and validators (see §7); add tests. No legacy
   code remains.

---

## 11. Files in scope (Preview area only — engine untouched)

- `src/contexts/webContainerRuntimeSupport.ts` — **delete**
  `createRuntimePatchRecorderScript`; inject the rrweb record bundle instead.
- `src/components/preview/usePreviewMessageBridge.ts` — **delete** custom op
  validators (`isPreviewDomPatchOp`/`isSerializedPreviewNode`/`isPreviewNodeRef`);
  accept rrweb event records; map to `previewInitialDocuments` /
  `previewPatchBatches`.
- `src/components/preview/usePreviewPlaybackRegistration.ts` — **delete** the
  custom patch loop + drift/resync state + runtime scroll re-assertion; add rrweb
  Replayer driving.
- `src/components/preview/previewIframeUtils.ts` — **delete** the custom apply
  engine, node-ref resolver, and seed-patch transforms; add rrweb seed/iframe
  helpers as needed.
- `src/components/preview/usePreviewInteractionCapture.ts` — runtime path removed
  (rrweb owns inner interactions); static path unchanged.
- `src/components/preview/usePreviewController.ts` — drop the `forceIframeRepaint`
  band-aid once rrweb replay is in; manage Replayer lifecycle/sizing.
- `src/types/slides.ts` — **delete** the custom op types (`PreviewDomPatchOp` &
  friends, `PreviewNodeRef`, `SerializedPreviewNode`); the segment payloads now
  hold rrweb events. Keep `PreviewState` / `PreviewEvent` (panel-level).
- `src/utils/iframeInteractionCapture.ts` — keep for static; remove runtime usage.
- Tests: replace `src/components/preview/previewPatchReplay.test.ts` with rrweb
  round-trip tests (virtual-list churn + scroll/float-unfloat fidelity).
- **Not touched:** `src/core/src/machine/*` (engine/seek), `src/storage/*` (codec,
  segments, store), `replayState.ts` (panel-state merge stays as-is, including the
  `78d955d` float/unfloat scroll-carry which remains correct for panel sizing).

---

## 12. TL;DR

- The empty preview and the virtual-list scroll drift are **one architectural
  root** with two surfaces: (A) positional node refs that drift across
  serialize/reparse with only-tolerate-drift recovery, and (B) scroll recorded as
  a stream decoupled from, and unsynchronized with, the DOM patches.
- `78d955d` patched one narrow symptom of (B) plus a paint band-aid; it could not
  fix (A) or general (B), which is why it persists.
- **Adopt rrweb** for the runtime preview's in-iframe record/replay: stable ids
  for all nodes (kills A) and a single ordered event stream for DOM+scroll (kills
  B), replayed into our existing panel sized by the existing `previewEvents`
  (preserves the float/unfloat-size requirement). Keep the recording engine and
  on-disk format as an opaque transport.
- **No legacy:** delete the custom runtime recorder, apply engine, seed-patch
  transforms, op types, and validators outright. One recorder, one replayer, one
  format — old recordings are not supported.
