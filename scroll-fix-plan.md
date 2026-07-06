# Scroll-fix plan — preview replay cursor/scroll desync

## Symptom

During rrweb preview replay the scroll position is inconsistent vs. the recording:
sometimes correct, sometimes a visible gap opens between where the content is
scrolled and where the replayed cursor points. The pointer lands on the wrong
element/row. Intermittent — worse during fast/continuous scrolling.

## Root cause (confirmed by reading the code, not guessed)

Two independent pipelines feed the replayed preview at very different time
resolutions:

1. **Cursor overlay** — `mouseTrackingActor.ts` +
   `captureActions.ts:373-381`. Native mousemoves are timestamped and stored
   immediately (host doc), or relayed per-animation-frame (~16ms) via postMessage
   for the cross-origin preview iframe (`iframeInteractionCapture.ts:259-307`).
   On replay the position is **continuously interpolated/tweened** between samples
   (`cursorReplay.ts:149-205`). This pipeline is correct and scroll-independent —
   it draws a screen-space pointer and does not depend on the DOM underneath.

2. **Scroll of the previewed content** — captured by rrweb's own recorder inside
   the preview iframe, configured with `sampling: { scroll: 150 }`
   (`src/components/preview/rrwebPreview.ts:310`). rrweb throttles scroll events to
   **at most one per 150ms** (`node_modules/rrweb/dist/rrweb.js:12339`
   `initScrollObserver` → `throttle`, leading+trailing). Each stored scroll event
   is a discrete `{id, x, y}` snapshot; on replay it is applied as an **instant
   jump** — `Replayer.pause()` takes the synchronous path so `applyScroll` calls
   `scrollTo({ ..., behavior: "auto" })` (`rrweb.js:16821`, `17299-17328`). Not a
   CSS smooth-scroll animation lag.

Net effect: during real scrolling the content position advances in **150ms steps**
while the cursor overlay advances ~10× more often AND is interpolated. At any
instant inside one of those 150ms scroll "holds," the overlay pointer has already
moved to the true mouse position, but the DOM under it is still frozen at the last
scroll checkpoint → the cursor points at the wrong content. Self-corrects every
~150ms, which is exactly the "sometimes okay, sometimes a gap" behavior.

The `scroll: 150` value was chosen for recording size (see the `rrweb-storage-review`
memory), never weighed against this playback artifact.

## The fix

Tighten the rrweb scroll sampling throttle. Scroll events are tiny (`{id, x, y}`,
a handful of bytes each) compared with mutation/snapshot payloads, so this is far
cheaper than the mousemove/mutation size tradeoffs already reviewed and rejected.

### Change

`src/components/preview/rrwebPreview.ts:310`

```diff
- sampling: { mousemove: 100, scroll: 150, media: 800 },
+ sampling: { mousemove: 100, scroll: 33, media: 800 },
```

- Target ~33ms (≈ one animation frame, ~30Hz). This aligns scroll cadence with the
  ~16–33ms cursor cadence so the residual gap is sub-frame and imperceptible.
- Consider extracting the value to a named constant next to
  `RRWEB_CHECKPOINT_THROTTLE_MS` (rrwebPreview.ts:64), e.g.
  `RRWEB_SCROLL_SAMPLING_MS = 33`, for a single documented knob. Optional.

### Why not touch the cursor pipeline

The cursor overlay is already high-resolution and interpolated; it is behaving
correctly. Slowing it to match scroll would degrade cursor smoothness and still
leave the DOM stepping. The scroll stream is the low-resolution side — fix there.

## Scope / non-goals

- Do NOT change `mousemove` or `media` sampling (unrelated; mousemove kept for
  rrweb in-page hover/selection fidelity per rrweb-storage-review memory).
- Do NOT change the cursor capture/replay pipeline.
- Format version (`PREVIEW_RRWEB_FORMAT_VERSION = 2`, rrwebPreview.ts:31) does NOT
  change — this only affects the density of scroll events in new recordings, not
  their shape. Existing `.ne` files replay unchanged (they keep their sparser
  scroll samples; only newly recorded lessons get the tighter cadence).

## Verification

1. `bunx tsc --noEmit` (or the project typecheck) + lint clean.
2. Record a fresh lesson that scrolls the preview continuously while the mouse
   moves over it; replay and confirm the cursor stays glued to the right content
   during the scroll (no 150ms stutter/gap).
3. Recording-size sanity check — the concern the original value guarded against:
   `node scripts/measure-recording-size.mjs <fresh.ne>` and compare the preview
   patch-batch bytes against a `scroll: 150` recording of a comparable session.
   Expect a small, non-material increase in scroll-event bytes (they are `{id,x,y}`
   and deflate well; the 32KB-window deflate caps repetition cost). If it turns out
   material on a scroll-heavy recording, fall back to `scroll: 50` as a compromise.

## Files

- Edit: `src/components/preview/rrwebPreview.ts:310` (and optionally :64 for the
  constant).
- No other source changes expected.
