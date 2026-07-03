# rrweb preview recording/replay — storage improvement findings

Review date: 2026-07-03. Scope: rrweb-based preview recording (`src/components/preview/rrwebPreview.ts`,
`usePreviewMessageBridge.ts`, `usePreviewController.ts`, `rrwebPreviewReplayer.ts`) and how the
`previewDoc`/`previewPatch` segments are persisted in the SCR3 container
(`src/storage/streamingRecordingCodec/*`, `src/storage/recordingStreamSink.ts`).

Evidence source: `public/lessons/issue-repro/recording-1783046610421.ne` (the current-format sample;
the older `introduction` lesson predates recent recorder changes and was excluded from evidence).

## Status

- Finding 1 (refresh-snapshot initial document): **done** — commit `055984a`.
- Finding 2 (`sampling` config): **done** — commit `0561268`, revised afterwards: `mousemove: false`
  was rejected (rrweb replay derives in-page hover/selection styling from pointer positions), final
  config is `sampling: { mousemove: 100, scroll: 150, media: 800 }`.
- Finding 3 (`maskAllInputs` comment): **done** — commit `0561268` (same file/commit as finding 2).
- Finding 4 (measure script binary SCR3): **done** — commit `035f453`.
- Deferred item (previewPatch added-node dedup): **done** — commit `4583815`. Stream-only
  `{ dedupTemplate, dedupIds }` marker for repeated rrweb added-node payloads
  (`previewPatchDedup.ts`, wired like `workspaceEventDedup` into both encoders and both decoders).
  Re-encoding the mutation-heavy feed lesson: 813 KB → 671 KB (−17.5%) with a byte-identical decode.
- Follow-up found while validating a fresh recording (2026-07-03): **frame `previewState.content`
  duplication** — the frame delta format re-emits the whole `previewState` (full static-preview
  HTML included) whenever any part of it changes, so preview scrolling re-embedded an identical
  ~60 KB content 337 times in a 30 s lesson (3.8 MB of a 3.98 MB file; each copy exceeds deflate's
  32 KB window). **done** — commit `024ee07`: per-segment `contentUnchanged` marker
  (`framePreviewContentDedup.ts`; carry never crosses a segment boundary, keeping keyframe-bounded
  frame segments range-loadable). Re-encoding that lesson: 3.98 MB → 624 KB (−84%), byte-identical.

## What the issue-repro recording shows

File total: 71,288 bytes. Segment breakdown (compressed):

| segment                 | compressed  | share   |
| ----------------------- | ----------- | ------- |
| frames                  | 19.9 KB     | 28%     |
| **previewDoc**          | **17.6 KB** | **25%** |
| workspace               | 8.6 KB      | 12%     |
| cursor                  | 6.8 KB      | 10%     |
| previewPatch            | 2.9 KB      | 4%      |
| preview (legacy events) | 1.6 KB      | 2%      |

Reconstructed timeline (from decoded preview/runtime/previewDoc/previewPatch records):

- t=0: runtime already `ready`; recording starts. Preview panel is in **API-client mode**
  (`api_client_mode` at t=9); the browser preview is not visible.
- t=8.5: the recording-start flow records the **cached page-load initial document** anyway:
  documentId `rrweb-mr4brg75-…`, FullSnapshot **103.4 KB uncompressed** (1,156 nodes, open-props CSS
  inlined — a different, earlier page state). The host's `RUNTIME_TAKE_SNAPSHOT` request is **never
  answered**, and **zero patch batches ever arrive from this documentId** — the document was not live
  during the recording.
- t=2255: user opens the browser preview (`preview_open`); t=2668: the freshly loaded page posts its
  own initial document (new documentId, **2.7 KB** — the actual demo page: h1/p/button, 33 nodes).
- t=4147–15425: interactions (hovers, 5 button clicks → 19 DOM mutations); one drift-triggered
  corrective FullSnapshot at t=6928 (3.1 KB — the checkpoint mechanism working as intended, cheap).

So **~17 KB of the 71 KB file (24%) is a stale snapshot of a page that was never shown during the
recording** and is superseded the moment the real page loads. That is the dominant storage waste in
the current format, and it also has a fidelity edge: replay may briefly show that stale page around
t≈2255–2668.

Also measured: of the 58 rrweb events in the patch stream, 12 are `mousemove` batches and 22
`mouseInteraction`. The fake replay cursor itself is hidden (`rrwebPreviewReplayer.makeResponsive()`;
the app draws its own cursor overlay), but the positions still drive rrweb's in-page hover/selection
styling during replay — so they are throttled, not dropped (see finding 2).

## Findings, priority order

1. **[High] Stop recording stale cached initial documents; gate on a live-iframe response.**
   Record the fresh `TAKE_SNAPSHOT` response _as_ the initial document; if no response ever comes,
   record nothing — the live iframe posts its own initial document when it loads (proven by the
   t=2668 path). Fixes both the 24% waste in this file and the duplicate-snapshot cost when the
   iframe _is_ responsive (today: cached doc + fresh snapshot are both stored).
2. **[Medium] Add a `sampling` config to `rrweb.record()`** — throttle mousemove/scroll/media.
   Bounds pointer-heavy sessions cheaply while keeping hover/selection replay styling.
3. **[Hygiene] `maskAllInputs` comment contradicts the code** — comment says "do not capture input
   values that may be secret" but `maskAllInputs: false` captures them (deliberately, for demo
   fidelity). Fix the comment.
4. **[Tooling] Fix `scripts/measure-recording-size.mjs`** — it assumes base64 text but current `.ne`
   files are raw binary SCR3; it currently errors on every current recording, so the only
   storage-regression visibility tool is broken.

Findings 1–3 all touch `src/components/preview/rrwebPreview.ts` — execute sequentially. Per repo
convention, serialize all subagent commits (parallel commits collide with the pre-commit stash/pop).

Global constraints for every task:

- Package manager is **bun** — never npm/yarn/pnpm.
- Verify with `bun run typecheck` and `npx vp test run` (never bare `vitest`).
- React Compiler is enabled — do not add `useCallback`/`useMemo`; sync refs in layout effects.
- Commit on the **current branch**; no new branches; no `Co-Authored-By … anthropic.com` trailer.
- Do not use Claude Code's preview browser to verify; the user eyeballs UI manually.

---

## Finding 1 — Record the fresh snapshot as the initial document; drop the stale-cache path

**Problem.** At recording start, `usePreviewController.ts` (effect ~line 350) records
`lastPreviewInitialDocumentRef` (the snapshot the page posted at _load_ time — arbitrarily stale) and
separately asks the preview for a fresh corrective FullSnapshot, which lands in the patch stream.
Consequences, both measured:

- Unresponsive/hidden/rebooting iframe (issue-repro): the stale cache is recorded (103 KB
  uncompressed, 24% of the file compressed), the fresh snapshot never comes, and the recorded document
  was never live during the recording.
- Responsive iframe: _both_ snapshots are stored — the cached one is dead weight superseded within
  ~tens of ms.

**Design.**

1. Recorder wiring (`rrwebPreview.ts`): on `RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE`, set a
   `hostSnapshotRequested` flag before `takeFullSnapshot()`. In `emit()`, while the flag is set,
   divert the resulting Meta (type 4, hold it) and FullSnapshot (type 2) away from `pendingEvents`
   and post them as a `RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE` message (same payload shape, same
   `documentId`, plus `refresh: true`), then clear the flag. Drift checkpoints (`maybeCheckpoint`)
   must NOT set the flag — corrective snapshots stay in the patch stream.
2. Types + bridge: add optional `refresh?: boolean` to `PreviewInitialDocument`
   (`src/types/slides.ts` and the engine copy in `src/core/src/slides.ts` if present); validate it in
   `createValidatedInitialDocument`. On a refresh document: always update
   `lastPreviewInitialDocumentRef`; when recording and nothing recorded yet
   (`recordedPreviewInitialDocumentIdRef.current === null`), record it (stripping `refresh`) and set
   the recorded-id ref.
3. Controller (`usePreviewController.ts`): the recording-start effect no longer records the cache —
   it only posts the take-snapshot request. No fallback timer: if the iframe never answers, nothing
   is recorded and the (re)loading iframe's own initial document (new documentId, existing bridge
   path) seeds replay — strictly better than replaying a page the user wasn't looking at.
4. Update the stale comments describing the old flow (top of `rrwebPreview.ts` near
   `RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE`, and the controller effect).

Replay compatibility: `usePreviewPlaybackRegistration.ts` uses `initialDocuments[0].time` as
`baseTime`; a fresh document arrives a few tens of ms after start (`computeRrwebOffsetMs` clamps
at 0). Old recordings replay unchanged. `buildRrwebReplayEvents` untouched.

Tests: extend `rrwebPreview.test.ts` (recorder script) and the bridge/controller tests covering
`TAKE_SNAPSHOT` (added in commit ee7002b). Assert: (a) after a host snapshot request the recorder
posts an initial-document message with `refresh: true` and does NOT emit that snapshot into a patch
batch; (b) with no response, nothing is recorded at start and a later initial document (new
documentId) is recorded; (c) a refresh document is recorded once, without the `refresh` field.

_Sized for the main agent (multi-file, recording-pipeline semantics), not a small-model task._

---

## Finding 2 — `sampling` config for `rrweb.record()` (small-model task)

In `startRecording()` in `rrwebPreview.ts`, `window.rrweb.record({...})` had no `sampling` option:
mousemove batched at rrweb's default 50 ms threshold, every scroll at the default 100 ms throttle,
media at 500 ms.

Final config (after user feedback):

```js
sampling: { mousemove: 100, scroll: 150, media: 800 },
```

`mousemove: false` was tried first and **rejected**: although rrweb's fake replay cursor is hidden
(the host draws its own cursor overlay), the replayer derives in-page **hover and similar styling**
from pointer positions, and that fidelity matters for replay. A mild 100 ms throttle keeps the
styling while trimming data. Mouse _interaction_ recording (clicks/focus) untouched;
`sampling.input` untouched (typing fidelity is wanted).

---

## Finding 3 — Fix the `maskAllInputs` comment (small-model task, same file as finding 2)

In `startRecording()`: the comment `// Replay is visual-only; do not capture input values that may be
secret.` sits above `maskAllInputs: false`, which _does_ capture values. Capture is deliberate (the
preview replays the author's own demo content; typed text must be visible). Replace the comment with
one stating that intent. One line; no behavior change.

---

## Finding 4 — Make `scripts/measure-recording-size.mjs` read current `.ne` files (small-model task)

`main()` reads the file as UTF-8 and base64-decodes it; current `.ne` files are raw binary SCR3
(bytes `SCR3` at offset 0), so the tool errors (`Not an SCR3 stream (magic "H$w")`). Fix: read a
Buffer; if the first 4 bytes are `SCR3`, measure directly; otherwise fall back to base64 (legacy
exports). Update the header usage comment and the default path (`public/introduction.ne` is gone —
use `public/lessons/issue-repro/recording-1783046610421.ne`). Verify it prints a per-kind breakdown
(expect previewDoc ≈ 17.6 KB, previewPatch ≈ 2.9 KB for the issue-repro file).

---

## Considered and rejected / deferred

- **Dedup of re-added identical DOM subtrees in `previewPatch`**: initially deferred, since
  **implemented** (see Status above; commit `4583815`). Motivated by virtualized-feed churn (81%
  duplicate add-node bytes in the feed-style lesson); harmless on quiet recordings — no repeats
  means no markers.
- **Dropping legacy `preview_interaction` events when rrweb is active**: they are consumed by replay
  (`replayState/preview.ts` `currentInteraction` drives the panel overlay) and cost ~2% here. Not
  dead weight; leave alone.
- **Zero-basing rrweb event timestamps**: measured 1.1% post-deflate savings on issue-repro. Not
  worth format churn (replay already rebases per segment in `buildRrwebReplayEvents`).
- **Larger flush batches / whole-stream recompression**: ≤6% on measured files.
- **Replacing corrective FullSnapshot checkpoints with synthetic removes**: checkpoint fired exactly
  once in issue-repro at 3.1 KB — drift-gated as designed; synthetic removes need parent ids the
  mirror can't provide for detached nodes. Leave as is.
- **Per-batch envelope slimming** (`documentId`/`route`/`source` per animation-frame batch):
  msgpack+deflate over 32-record groups already collapses these.
