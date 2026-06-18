# Preview rrweb Migration — Progress

Tracks execution of `preview-plan.md` (adopt rrweb for runtime preview record/replay;
no legacy; engine stays an opaque transport).

## Verification policy

Each commit must be **green** on `bun run typecheck` and `bun run test` (vitest).
Full visual fidelity (rrweb Replayer layout, scroll, float/unfloat) needs **manual
browser verification** with the running app — flagged per task where it applies.

## Task list & status

| #   | Task                                                                                                         | Status | Verified by               |
| --- | ------------------------------------------------------------------------------------------------------------ | ------ | ------------------------- |
| 0   | Add rrweb dep; baseline; progress.md                                                                         | DONE   | install ok                |
| 1   | Foundation: vendored UMD bundle, rrweb event types (both slides copies), shared message/event module         | DONE   | typecheck+test            |
| 2   | Recording: replace injected custom recorder with rrweb `record`; update message bridge to carry rrweb events | DONE   | typecheck+test (+browser) |
| 3   | Replay: rrweb `Replayer` applier driven by the existing seek machine; mount into preview panel               | DONE   | typecheck+test (+browser) |
| 4   | Scroll/viewport: retire decoupled runtime scroll path; responsive replay iframe; float/unfloat fidelity      | DONE   | typecheck+test (+browser) |
| 5   | Delete custom path: recorder, apply engine, seed-patch transforms, op types, validators                      | DONE   | typecheck+test            |
| 6   | Tests: rrweb round-trip (virtual-list churn + scroll/float-unfloat)                                          | DONE   | test                      |

## Notes / decisions

- Two duplicated type copies: `src/types/slides.ts` (app) + `src/core/src/slides.ts` (engine).
  Engine only reads `.time` / array length, so payload fields can carry rrweb events
  without engine logic changes (not a "redesign").
- rrweb 2.0.1. UMD global `window.rrweb` (`rrweb.umd.min.cjs`, ~265KB) inlined into the
  WebContainer page via `?raw` import for recording. `Replayer` imported as ESM in host.
- Preview record envelope keeps `time`/`documentId`; `html`/`ops` replaced by `events`.

## Log

- T0: `bun add rrweb` → rrweb@2.0.1. Baseline: only package.json + bun.lock changed.
- T1: Added `PreviewRecordedEvent` + optional `events?` to `PreviewInitialDocument`/
  `PreviewDomPatchBatch` in both slides copies (additive; legacy `html`/`ops` kept).
  New `rrwebPreview.ts`: vendored UMD (`vendor/rrweb.umd.min.cjs` via `?raw`),
  `createRrwebPreviewRecorderScript`, `buildRrwebReplayEvents`, `hasRrwebPreviewEvents`.
  `?raw` bare-specifier rejected by rrweb `exports` → vendored copy instead.
  Green: typecheck ok; 5 new tests pass; full suite 76 pass / 2 pre-existing audio fails.
- T2: Loosened envelope `version` to `number` (rrweb format = 2). Recorder wiring now
  defers `record()` to DOMContentLoaded + `slimDOMOptions {script,comment}`.
  `webContainerRuntimeSupport.injectRuntimeSnapshotScript` injects rrweb as its own
  `<script data-next-editor-rrweb-record>` and dropped the custom DOM differ from the
  snapshot script; `stripRuntimeSnapshotScript` strips both tags. Bridge validators
  rewritten to accept rrweb-event records (legacy op validators removed).
  Notes: (a) `createRuntimePatchRecorderScript` kept exported (legacy test only);
  (b) placeholder legacy fields (`ops:[]`, `baseRevision/revision:0`) on rrweb batches
  until Task 5 deletes them; (c) snapshot poster still emits full outerHTML (now
  includes the 265KB tag, host strips scripts) — revisit perf in Task 4.
  Browser-verify pending: actual rrweb recording into the segments.
  Green: typecheck ok; full suite 76 pass / 2 pre-existing audio fails.
- T3: New `rrwebPreviewReplayer.ts` (`RrwebPreviewReplayer` wraps rrweb `Replayer`,
  driven by `pause(currentTime - baseTime)`; fills panel; `computeRrwebOffsetMs`
  pure helper). `usePreviewPlaybackRegistration` applier branches to rrweb when
  `hasRrwebPreviewEvents`, rebuilds Replayer on recordingId change, tears down on
  reset/unmount. Controller exposes `replayContainerRef` + `isRrwebReplayActive`;
  `RuntimePreviewRenderer` mounts the replay container (vs live iframe) during rrweb
  playback, keeping `data-cursor-replay-target`. Clock alignment: envelope `.time`
  is rebased to recording-relative in `recordingSession.append*`, so
  `offset = currentTime - initialDocuments[0].time`.
  Browser-verify pending: Replayer DOM/scroll/seek fidelity (jsdom can't render it).
  Green: typecheck ok; 33 preview tests; full suite 79 pass / 2 pre-existing audio fails.
- T5: Deleted the whole custom path. `previewIframeUtils.ts` rewritten to keepers only
  (`patchIframeContentFromHtml` + helpers, `createReplayableRuntimePreview*`,
  `getElementByXPath`, `RUNTIME_SNAPSHOT_MESSAGE_TYPE`). Removed the legacy applier +
  drift/resync refs + `getLatestInitialDocument` from `usePreviewPlaybackRegistration`
  (applier is now rrweb-only; non-rrweb runtime returns -1). Deleted
  `createRuntimePatchRecorderScript` + unused consts from webContainerRuntimeSupport.
  Deleted op types (`PreviewDomPatchOp`/`PreviewNodeRef`/`SerializedPreviewNode` + all
  op interfaces) and legacy fields (`html`/`ops`/`baseRevision`/`revision`) from BOTH
  slides copies; updated `core/src/index.ts` re-exports and bridge constructors.
  Deleted `previewPatchReplay.test.ts`. Verified zero dangling refs.
  Green: typecheck ok; full suite 71 pass / 2 pre-existing audio fails (no preview regress).
- T6: New `rrwebRoundTrip.test.ts` — records a **virtual-list scroll churn** (drop top
  row, append rows with translateY, grow spacer) via real `rrweb.record`, reassembles
  with `buildRrwebReplayEvents`, replays, and asserts the replayed iframe has the exact
  6 final rows + spacer (no drift, NOT empty) — the precise failure the legacy path had.
  Note: the test drives `Replayer` directly with `UNSAFE_replayCanvas:true` to bypass
  rrweb 2.x's sandboxed-rebuild guard, which jsdom can't satisfy (unstable sandboxed
  contentDocument identity). Production keeps the safe default sandboxed iframe — that
  path only works in a real browser, hence the remaining browser-verify items below.
  Green: typecheck ok; full suite 72 pass / 2 pre-existing audio fails.

## Post-implementation browser fixes (round 1)

User browser-tested and found two issues; both rooted in the replay container being
gated on `isPlaying`:

1. **Stale elements accumulate** (old rows kept while new rows appended).
2. **Seek shows a blank white preview** — only worked when playing from the start.

Root cause: `isRrwebReplayActive` derived from `isPlaybackPreviewActive`, which
requires `isPlaying`. Pausing to seek flipped `isPlaying` false → the replay
container unmounted (orphaning the rrweb Replayer's iframe → blank) and/or the live
iframe showed; resuming rebuilt churned state. A characterization test
(`rrwebSeekDriving.test.ts`) proved rrweb's per-tick `pause(offset)` itself applies
removes correctly **forward and backward** on a _stable_ Replayer — so the bug was
the mount churn, not the driving.

Fix:

- New `isRuntimeRecordingPlayback` flag (node.js + `usesPlaybackModel` + recording +
  !recording), independent of `isPlaying` (true while playing/paused/seeking/ended).
  `isRrwebReplayActive` now uses it, so the container stays mounted across pause/seek.
- `isLiveRuntimePreviewActive` now also requires `!isRuntimeRecordingPlayback`, so the
  live iframe never shows during playback and the patch applier keeps driving while
  paused/seeking.
- `usePreviewPlaybackRegistration`: rebuild the Replayer when the container element
  changes (remount), and `container.replaceChildren()` before rebuild so a rebuild can
  never stack two iframes (defends against stale accumulation).
- New `rrwebSeekDriving.test.ts` (forward + backward removes on one Replayer).

Green: typecheck; lint 0/0; full suite 73 pass / 2 pre-existing audio fails.
Needs re-verification in the browser.

## Status: all 6 tasks DONE (unit/typecheck green)

### Still requires real-browser verification (jsdom can't render rrweb Replayer)

- Live rrweb recording into a running WebContainer node.js preview produces seed +
  incremental segments.
- Replay renders into the panel, seeks/scrubs correctly, and the virtual list is
  populated (not empty) at every offset.
- Float/unfloat during playback keeps the preview correct (panel size replays via
  `previewEvents`; rrweb iframe fills the panel).
- The rrweb default sandboxed iframe becomes visible (`display:inherit` on the Meta
  event) and reads same-origin in the host. Decoupled runtime scroll path is **retired by construction** — during rrweb
  replay `RuntimePreviewRenderer` mounts the replay container (not the iframe), so
  `iframeRef` is null and the snapshot applier's scroll/`scrollTo` + content blocks
  return early; only panel size/mode (float/unfloat) still applies, which is what we
  want. Responsive replay iframe done in T3 (`makeResponsive` 100%/100%). Scroll now
  lives in the rrweb stream, coupled to DOM. Snapshot poster now strips `<script>`
  from the posted outerHTML (kills the 265KB postMessage bloat from T2). Verified the
  vendored bundle has zero literal `</script>` (safe to inline). New
  `webContainerRuntimeSupport.test.ts` (3 tests: injection present, exactly 2 closing
  tags, no injection for non-runtime).
  Decision/deviation: kept `forceIframeRepaint` (plan suggested dropping it). It only
  touches the live cross-origin `:PORT` iframe (its real purpose) and is inert during
  rrweb replay (iframeRef null); removing it risks regressing live float repaint.
  Green: typecheck ok; full suite 82 pass / 2 pre-existing audio fails.
