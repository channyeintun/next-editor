# Fix Plan: Preview Patch Replay Broken During Playback

## Status

Diagnosis + remediation plan only. **No code is changed by this document.**

This addresses the regression introduced by the DOM patch/diff replay work
(`morphdom` apply engine + delta storage codec via comlink) described in
`plan.md`. Recording still works; **playback preview is broken**.

## Symptom

During playback the preview iframe no longer reflects the recorded runtime DOM.
The console fills with the same log, dozens of times:

```
Preview patch replay failed
Object   // { ok: false, appliedOps: N, error: "..." }
```

Source of the log: [`usePreviewPlaybackRegistration.ts:252`](src/components/preview/usePreviewPlaybackRegistration.ts:252),
emitted when [`applyPreviewDomPatchBatchToIframe`](src/components/preview/previewIframeUtils.ts:400)
returns `{ ok: false }`.

The matching `recording-error.txt` line is **a red herring**:

```
Cannot track mouse in iframe (cross-origin): SecurityError ...
at setupIframeListeners (editorMachine.ts:797)
```

That is the parent failing to attach mouse listeners onto the **cross-origin
WebContainer preview iframe** during recording. It is pre-existing and unrelated
to patch replay (patches are captured by an _injected_ script that runs inside
the iframe and `postMessage`s out, so cross-origin access is never needed).
Do not chase it.

## How the system is supposed to work

1. **Record (inside the live preview iframe)** —
   [`createRuntimePatchRecorderScript`](src/contexts/webContainerRuntimeSupport.ts:136)
   is injected into the runtime HTML. At `DOMContentLoaded` it:
   - tags every element with a private marker attribute
     `data-next-editor-preview-node-id` ([`tagElementTree`](src/contexts/webContainerRuntimeSupport.ts:186) /
     [`getNodeId`](src/contexts/webContainerRuntimeSupport.ts:202)),
   - posts an **initial document seed** = `document.documentElement.outerHTML`
     ([`postInitialDocument`](src/contexts/webContainerRuntimeSupport.ts:170)),
   - then observes mutations and posts **patch batches** of normalized ops,
     each op referencing nodes by `{ id, path }` (elements) or
     `{ anchorId, path }` (text/comment nodes).

2. **Bridge (parent)** —
   [`usePreviewMessageBridge`](src/components/preview/usePreviewMessageBridge.ts:293)
   validates and forwards the seed + batches. The machine re-stamps each one's
   `time` to recording-relative time
   ([`appendPreviewInitialDocument` / `appendPreviewPatchBatch`](src/core/src/machine/recordingSession.ts:52)).

3. **Replay (parent)** — on each timeline tick the machine runs
   [`applyPreviewPatchBatchesAtTime`](src/core/src/machine/editorMachine.ts:2083),
   which calls the applier registered in
   [`usePreviewPlaybackRegistration`](src/components/preview/usePreviewPlaybackRegistration.ts:201).
   The applier seeds a persistent same-origin iframe with the initial document
   ([`applyPreviewInitialDocumentToIframe`](src/components/preview/previewIframeUtils.ts:393)),
   then applies batches in order, resolving each ref with
   [`findNodeByPreviewRef`](src/components/preview/previewIframeUtils.ts:175).

For node resolution to succeed, **the seeded replay DOM must be structurally
identical to the live DOM the recorder measured its refs against** (same node
identities, same child ordering/indices).

## Root cause

**The replay seed is structurally rewritten before it is applied, so the patch
stream's node references no longer line up with the seeded DOM.**

The seed is passed through
[`createReplayableRuntimePreviewFromHtml`](src/components/preview/previewIframeUtils.ts:489)
inside [`createValidatedInitialDocument`](src/components/preview/usePreviewMessageBridge.ts:212).
That function does two structure-changing things:

1. **Removes every `<script>`** ([previewIframeUtils.ts:507-509](src/components/preview/previewIframeUtils.ts:507)).
2. **Prepends a `<base href>` as the first child of `<head>`** ([previewIframeUtils.ts:511-519](src/components/preview/previewIframeUtils.ts:511)).

Both mutate the document-level structure that the recorder's refs were computed
against:

- The recorder serialized the seed and computed every `path` / `index` /
  `anchorId+path` against the **live** DOM, which **contained** the module
  script(s), the injected recorder/snapshot scripts, and **no** injected
  `<base>`.
- The replay seed has all scripts deleted and a `<base>` inserted at
  `head.childNodes[0]`. Every direct child index under `<html>`, `<head>`, and
  `<body>` is now shifted, and any node that a later op references by a script's
  marker id is simply gone.

Consequences during apply:

- **Element ops** (`set_attribute`, `set_text` on element-anchored text, etc.)
  that resolve purely by surviving marker `id` still work — markers are
  preserved by `cloneNode`.
- **Text/comment ops** resolved via `{ anchorId, path: [index] }` where the
  anchor is `<head>`/`<body>`/`<html>` now read a **shifted** index →
  wrong node or `null`.
- **Refs to a removed script** (whose marker id no longer exists) hit the silent
  **fallback** in [`findNodeByPreviewRef`](src/components/preview/previewIframeUtils.ts:184):
  when `id` is not found it walks `ref.path` from `documentElement`, but that
  path encodes the _recording-time_ structure (with scripts, no base) → wrong
  node or `null`.
- `insert_node` / `move_node` use **absolute child `index`**
  ([webContainerRuntimeSupport.ts:434-441](src/contexts/webContainerRuntimeSupport.ts:434));
  after the rewrite these indices place nodes in the wrong slot even when they
  don't hard-fail, accumulating drift.

The first batch that hits a missing/`null` ref returns `{ ok: false, error:
"Missing target node" | "Missing insert parent" | ... }`, the applier aborts
(see below), and the preview never advances past the seed.

### Why it loops dozens of times instead of failing once

On failure the applier
([usePreviewPlaybackRegistration.ts:249-255](src/components/preview/usePreviewPlaybackRegistration.ts:249))
returns `cursor.lastAppliedBatchIndex` **unchanged** and sets
`patchReplayFailedRef = true`. The machine therefore stores the same
`lastAppliedPreviewPatchBatchIndex`, so on the next tick `ensureReplaySeed`'s
`needsSeed` test
([usePreviewPlaybackRegistration.ts:181-185](src/components/preview/usePreviewPlaybackRegistration.ts:181))
is **false** (`input.lastAppliedPatchBatchIndex` is not `<` the cursor) — no
reseed, no recovery. Every subsequent tick retries the **same** failing batch
and logs the identical error. There is effectively no working recovery path.

### Why the preview looks frozen/blank rather than partially right

Once `patchReplayFailedRef` is set, the snapshot applier
([usePreviewPlaybackRegistration.ts:355](src/components/preview/usePreviewPlaybackRegistration.ts:355))
flips `shouldApplySnapshotContent` to `true` and falls back to full-content
preview events. But patch-first recordings deliberately stop storing ordinary
DOM evolution as full HTML, so the only content available is the last
`preview_refresh` boundary — the live DOM evolution between refreshes is lost.
The viewer sees a stale/empty frame.

### Why the test suite did not catch it

[`previewPatchReplay.test.ts`](src/components/preview/previewPatchReplay.test.ts)
drives the **real** recorder, but then replays the **raw** seed
(`scenario.seed.html`) directly into the iframe
([previewPatchReplay.test.ts:172](src/components/preview/previewPatchReplay.test.ts:172)).
It never applies the production
`createReplayableRuntimePreviewFromHtml` transform, and its `SEED_HTML` contains
no `<script>` and no `<base>`. So the exact transform that breaks production is
absent from the test, giving false confidence.

## Confirmed non-causes

- **Timing / timeline drift** — seed and batch `time` values are re-stamped to
  recording-relative time at record
  ([recordingSession.ts:52-82](src/core/src/machine/recordingSession.ts:52)), so
  they share the playback clock. Not the bug.
- **Revision mismatch** — that path logs a _different_ message
  ([usePreviewPlaybackRegistration.ts:240](src/components/preview/usePreviewPlaybackRegistration.ts:240));
  the observed log is the op-apply failure, so `baseRevision` lined up.
- **Comlink storage codec** — `comlink` is only used by the recording
  encode/decode worker (`recordingCodec.worker.ts`), not by patch apply. Not
  implicated in this failure path.
- **Cross-origin `setupIframeListeners`** — recording-side mouse tracking, see
  "Symptom".

## Fix

### Principle

The seed that replay applies must preserve the **exact node identities and child
ordering** that the recorder measured. Resource rewriting and script
neutralization must not change document structure.

### 1. Use a structure-preserving seed transform for patch replay (primary fix)

Stop routing the patch-replay seed through
`createReplayableRuntimePreviewFromHtml` (keep that function untouched for the
legacy full-snapshot paths at
[usePreviewMessageBridge.ts:328](src/components/preview/usePreviewMessageBridge.ts:328)
and [previewIframeUtils.ts:469](src/components/preview/previewIframeUtils.ts:469),
where full replacement _wants_ scripts stripped).

Add a dedicated transform used only for `PreviewInitialDocument.html` that:

- **Neutralizes scripts in place instead of removing them** — rewrite each
  `<script>`'s `type` to the inert sentinel already used by the apply engine
  (`application/x-next-editor-inert-script`, see
  [previewIframeUtils.ts:227](src/components/preview/previewIframeUtils.ts:227))
  and drop/blank its `src`, but **keep the element and its marker id in the
  tree**. This preserves every child index and keeps script-anchored refs
  resolvable.
- **Adds the `<base>` without shifting recorded indices** — append it as the
  **last** child of `<head>` (existing head children keep indices `0..n-1`)
  rather than prepending. Alternatively, set the base via a method that does not
  introduce a new indexed child. Prefer the option that keeps all
  recording-time indices valid.
- Leaves all `data-next-editor-preview-node-id` markers intact (already the
  case).

Net effect: the seeded replay DOM is index-for-index identical to what the
recorder measured, so `findNodeByPreviewRef` resolves correctly.

### 2. Make node resolution strict and drift-resistant

In [`findNodeByPreviewRef`](src/components/preview/previewIframeUtils.ts:175):

- For element refs that carry an `id`, resolve **only** by marker id. If the id
  is missing, treat it as a recoverable desync (trigger §4) rather than silently
  falling back to a `documentElement` path that encodes stale structure
  ([previewIframeUtils.ts:184-200](src/components/preview/previewIframeUtils.ts:184)).
- Keep `anchorId + path` for text/comment nodes, but with §1 in place the anchor
  indices are now stable. Optionally validate the resolved node's `nodeType`
  before applying and surface a desync if it mismatches.

This guarantees a wrong-but-present node is never silently mutated (today an
out-of-range index can land on the wrong node and "succeed", corrupting state
for later batches).

### 3. Keep `insert_node` / `move_node` positioning valid

With §1 the absolute child indices are valid again. As hardening, consider
emitting a sibling reference (e.g. `beforeId` / `afterId`) alongside the numeric
`index` in the recorder
([webContainerRuntimeSupport.ts:434-491](src/contexts/webContainerRuntimeSupport.ts:434))
and preferring it on apply, so positioning survives any future seed rewrite.
Optional; not required if §1 lands.

### 4. Add a recovery path that actually recovers

Today a failed batch loops forever (see "Why it loops"). Change the applier
([usePreviewPlaybackRegistration.ts:201-268](src/components/preview/usePreviewPlaybackRegistration.ts:201))
so that on `{ ok: false }` it:

- re-seeds from the nearest `PreviewInitialDocument` at/just before
  `currentTime` and replays batches forward, **or**
- if reseed/forward-replay still fails, hands off to the full-content snapshot
  for the current time (not just the last refresh boundary) so the frame
  reflects the playhead instead of freezing,

and ensures the `needsSeed` condition can re-trigger after a failure (it cannot
today because `lastAppliedPatchBatchIndex` never moves backward). Failures
should also be rate-limited / logged once per desync, not once per tick.

### 5. Treat the cross-realm `morphdom` apply as a known hazard

`replace_subtree` fires when a childList mutation exceeds 20 nodes
([webContainerRuntimeSupport.ts:414-423](src/contexts/webContainerRuntimeSupport.ts:414))
and calls [`morphdom`](src/components/preview/previewIframeUtils.ts:381), which is
imported into the **parent** realm but operates on **iframe** nodes. This is not
the primary failure (first batches fail before any large list), but it is a
latent cross-realm bug. Verify morphdom uses the iframe's `ownerDocument` for
any node creation, or route subtree replacement through the same
realm-safe `importNode` path used elsewhere
([previewIframeUtils.ts:96-142](src/components/preview/previewIframeUtils.ts:96)).

### 6. Close the test gap

Update [`previewPatchReplay.test.ts`](src/components/preview/previewPatchReplay.test.ts)
so the round-trip matches production:

- Apply the **same** seed transform the bridge applies before replaying
  (`createValidatedInitialDocument` → the new structure-preserving transform).
- Make `SEED_HTML` realistic for node.js lessons: include a `<base>`-less head,
  a module `<script src>` in `<body>`, and an empty `<div id="root">`; record a
  first "render into #root" mutation, then deep updates — i.e. exercise scripts
  and base injection.
- Assert the final replayed DOM equals the live DOM **after** the transform, and
  add a regression assertion that script neutralization/base injection does not
  shift recorded indices.

## Implementation order

1. §1 structure-preserving seed transform (fixes the regression).
2. §6 test update reproducing the failure first, then proving §1.
3. §2 strict resolution + §4 recovery (defense in depth; stops silent corruption
   and infinite-loop logging).
4. §3 and §5 hardening (optional, follow-up).

## Acceptance criteria

1. Playing back a node.js recording shows the runtime DOM evolving in the
   persistent iframe with no `Preview patch replay failed` logs.
2. Seeking applies patch batches forward from the nearest seed without flashing.
3. A forced desync recovers in place (reseed or full-content fallback) instead
   of looping.
4. `previewPatchReplay.test.ts` exercises the production seed transform with
   scripts + `<base>` and passes.
5. Legacy recordings without patch batches still replay through the existing
   full-content path (no change to `createReplayableRuntimePreviewFromHtml` for
   the snapshot use sites).

## Key files

- [src/components/preview/previewIframeUtils.ts](src/components/preview/previewIframeUtils.ts) — seed transform, `findNodeByPreviewRef`, op apply, morphdom.
- [src/components/preview/usePreviewMessageBridge.ts](src/components/preview/usePreviewMessageBridge.ts) — seed/batch validation + transform routing.
- [src/components/preview/usePreviewPlaybackRegistration.ts](src/components/preview/usePreviewPlaybackRegistration.ts) — applier, seeding, recovery, snapshot fallback.
- [src/contexts/webContainerRuntimeSupport.ts](src/contexts/webContainerRuntimeSupport.ts) — recorder (seed + ref/index generation).
- [src/components/preview/previewPatchReplay.test.ts](src/components/preview/previewPatchReplay.test.ts) — round-trip test to harden.
