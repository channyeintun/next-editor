# Plan: Google Slides import for presentations (Option A — published-deck SVG import)

Based on [google-slide-research.md](google-slide-research.md). Option A is chosen:
the user publishes a deck via **File → Share → Publish to web**, we fetch the
`https://docs.google.com/presentation/d/e/…/pub` HTML client-side (CORS verified),
extract one inline SVG per slide plus typed build-step animation data, and render
those slides **inside the existing Reveal.js shell** as a new slide content type.
No Google auth, no server changes.

> **Superseded 2026-07-04 (see Phase 6):** decision #1 below ("Reveal.js stays")
> was corrected — the actual ask was to replace Reveal.js entirely, not just
> add Google slides alongside it. Phases 1–5 (the parser, slide model, and
> google-svg rendering/animator) are unaffected; Phase 6 replaces the Reveal.js
> shell itself with a custom renderer for every slide type.

## Architecture decisions (binding for all phases)

1. ~~**Reveal.js stays.**~~ **Superseded — see Phase 6.** A Google slide is a
   new `contentType: "google-svg"` slide, originally rendered as inline SVG
   inside a Reveal slide; Existing html/markdown slides were originally left
   untouched on Reveal.js too.
2. **SVG lives in `Slide.content`** (like html slides). This keeps recordings
   (`meta.slides` in the recording codec) self-contained with zero codec changes.
   localStorage persistence gets fflate compression to handle the size (§Phase 2).
3. **Step (build-animation) state rides the existing `indexv` channel.** For
   `google-svg` slides there are no vertical sub-slides, so `previewState.indexv`
   is reinterpreted as "number of steps revealed" (0..N). `slide_change` events
   already carry `indexv`, and replay already reconstructs it
   (`src/core/src/machine/replayState/slide.ts`) — **no recording-engine or
   machine changes are needed or allowed.**
4. **Slide `id` = Google page id** (e.g. `g10498a2ca97_0_6`) so re-import can diff
   update/add/remove.
5. Do not add new dependencies. fflate is already a dependency. Package manager is
   bun; never run npm/yarn/pnpm.
6. Follow repo conventions: no `useCallback`/`useMemo` (React Compiler),
   `@xstate/store-react` for stores, plain functions.
7. Never mention the reverse-engineered reference product by name anywhere
   (code, comments, docs, commit messages). Say "reference implementation" if
   needed at all.

### Verification commands (used by every phase)

```
bun run typecheck        # tsc -b tsconfig.json
npx vp test run          # vitest, non-watch (never bare vitest, never `vp test` without `run`)
bun run lint
```

---

## Phase 1 — Parser core (`src/googleSlides/`)

**Goal:** a pure, fixture-tested module that turns published-deck HTML into typed
slide data. No UI, no store, no DOM APIs (string/JSON only).

**New files**

- `src/googleSlides/types.ts`
- `src/googleSlides/parse.ts`
- `src/googleSlides/normalizeSvg.ts`
- `src/googleSlides/fetchPublishedDeck.ts`
- `src/googleSlides/index.ts` (re-exports)
- `src/googleSlides/parse.test.ts`
- `src/googleSlides/__fixtures__/published-deck.html` (small synthetic fixture)

**Types (exact contract — Phases 2–4 depend on these names)**

```ts
export interface DeckStepTrackOpacity {
  kind: "opacity";
  from: number;
  to: number;
}
export interface DeckStepTrackScale {
  kind: "scale";
  from: number;
  to: number;
}
export interface DeckStepTrackTranslate {
  kind: "translate";
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}
export type DeckStepTrack = DeckStepTrackOpacity | DeckStepTrackScale | DeckStepTrackTranslate;
export interface DeckStepEntry {
  elementId: string;
  durationMs: number;
  delayMs: number;
  tracks: DeckStepTrack[];
}
export type DeckStep = DeckStepEntry[]; // one step = entries animated together
export interface ParsedDeckSlide {
  pageId: string;
  title: string;
  svg: string;
  steps: DeckStep[];
}
export interface ParsedDeck {
  sourceUrl: string; // normalized (query stripped)
  width: number;
  height: number; // from docData[0], aspect only
  slides: ParsedDeckSlide[];
}
export class GoogleSlidesParseError extends Error {}
```

**Functions**

- `isPublishedDeckUrl(url: string): boolean` — `^https://docs\.google\.com/presentation/d/e/[^/]+/`.
  An editor URL (`/presentation/d/<id>/edit`) must return false.
- `parsePublishedDeck(html: string, sourceUrl: string): ParsedDeck` — pure.
  Algorithm (see research §1.2, verified live):
  1. Find literal `docData:`; bracket-match the JSON array that follows
     (count `[` / `]` from the first `[`; do NOT regex this — the page is ~12 MB).
     `JSON.parse` it. `docData[0] = [width, height]`; `docData[1][i]` =
     `[pageId, _, title, ...]` with raw steps at index `[7][0]`.
  2. Page ids in order: regex `/setPageData\('([^')]+)/g`.
  3. SVGs: regex `/SK_svgData \= \'((?:[^'\\]|\\.)*)\'/g`, one per page id in the
     same order. Decode each capture: replace `\xNN` hex escapes with the char,
     then `JSON.parse('"' + captured.replace(/"/g, '\\"') + '"')`, then
     `slice(indexOf("<svg"))`. Map pageId → svg.
  4. Steps: for each slide's raw `[7][0]` (array of step groups, may be empty /
     missing — treat defensively), each group is `[entries]` where entry `o` is:
     skip when `o[1]` is one of the page ids (whole-slide transition entries);
     else
     `{ elementId: o[1], durationMs: Math.max(o[2], 1), delayMs: o[3], tracks }`
     with tracks from `o[0]`:
     `x[0]===0 → opacity {from: x[1], to: x[2]}`;
     `x[0]===2 → scale {from: x[2], to: x[3]}`;
     `x[0]===3 → translate {fromX: x[1], fromY: x[2], toX: x[3], toY: x[4]}`
     (percent units). Unknown `x[0]` values: ignore the track.
     Steps with zero surviving (non-page-id) entries are dropped.
     > **Correction 2026-07-04:** the above described `o[6] === 2` as an
     > additional per-entry skip at this same stage, conflated with the
     > page-id skip. In the reference, `o[6] === 2` is a separate, later
     > exclusion applied only when building an entry's tracks (it never
     > gets an opacity/scale/translate track), and it does **not** affect
     > whether the step itself survives — that decision uses only the
     > page-id filter above. A step where every surviving entry has
     > `o[6] === 2` is still kept, as an empty-array step.
  5. Any structural failure (no `docData`, JSON parse failure, zero slides,
     page-id/SVG count mismatch) → throw `GoogleSlidesParseError` with a message
     that tells the user to check the deck is published to the web.
- `normalizeSvg(svg: string): string` — string transforms:
  - strip `tabindex="…"` attributes;
  - rewrite `xlink:href` values: unwrap `https://www.google.com/url?q=<real>`
    redirect wrappers (decode the `q` param); leave `data:` URIs and everything
    else as-is (inline SVG can load cross-origin images);
  - defense-in-depth: remove `<script>…</script>` elements and ` on*="…"` event
    handler attributes.
- `fetchPublishedDeck(url: string): Promise<ParsedDeck>` — validates with
  `isPublishedDeckUrl` (throw `GoogleSlidesParseError` with a "publish to web"
  hint for editor URLs), strips `?query`/`#hash`, `fetch()`, non-OK response →
  error, then `parsePublishedDeck` + `normalizeSvg` each slide.

**Fixture:** hand-write a small (~10 KB) synthetic HTML that mimics the real page:
a `docData: [[365760,205740],[…]]` blob (one slide with a 2-step animation
targeting element ids, one slide without steps), two `setPageData('…')` calls,
two `SK_svgData = '…'` assignments whose payloads contain `\x3csvg…` hex-escaped
SVG with matching element ids. Build it by writing the _decoded_ SVG first, then
hex-escaping `<`, `>`, `&`, quotes the way the real page does.

**Tests:** parse the fixture end-to-end (slide count, titles, viewBox retained,
step conversion exact including skip rules), `isPublishedDeckUrl` accept/reject
table, `normalizeSvg` cases (tabindex, redirect unwrap, script strip, `on*`
strip, data URI untouched), bracket-matcher robustness (nested arrays inside
docData), error paths (missing docData, count mismatch).

**Out of scope:** anything touching `src/components`, stores, or types outside
`src/googleSlides/`.

---

## Phase 2 — Slide model + compressed persistence

**Goal:** the `Slide` type carries Google slides; localStorage survives multi-MB
decks; nothing else in the app changes behavior.

**Files to modify**

- `src/types/slides.ts` — extend:
  ```ts
  export type SlideContentType = "html" | "markdown" | "google-svg";
  export interface Slide {
    id: string;
    content: string; // for google-svg: normalized SVG markup
    contentType: SlideContentType;
    name?: string;
    order: number;
    background?: string;
    title?: string; // google-svg: slide title from the deck
    steps?: DeckStep[]; // google-svg: build steps (from src/googleSlides)
    sourceUrl?: string; // google-svg: published deck URL (same on every deck slide)
  }
  ```
- `src/core/src/slides.ts` — the core package keeps its own `Slide`/
  `SlideContentType` copy (no `background` there). Mirror the `contentType`
  union and add the same optional fields. Core must not import from
  `src/googleSlides` if that creates a layering violation — check how core is
  consumed; if unsure, duplicate the small `DeckStep` structural type there with
  a comment pointing at the canonical one.
- `src/stores/slidesStore.ts`:
  - `isSlide` guard: accept `"google-svg"` and the new optional fields
    (validate `steps` only loosely — `Array.isArray` — the guard is a corruption
    filter, not a schema).
  - **Compression**: `saveSlidesToStorage` — when
    `JSON.stringify(slides).length > 200_000`, store
    `"NEZ1:" + base64(deflateSync(strToU8(json)))` (fflate, all synchronous).
    Otherwise store plain JSON as today. `loadSlidesFromStorage` — if the stored
    string starts with `"NEZ1:"`, base64-decode + `inflateSync` + `strFromU8`
    first; else parse as today. Quota errors: keep the existing try/catch,
    `console.warn` with the payload size.
- `src/hooks/useSlides.ts` — legacy duplicate of the store logic using the same
  localStorage key. First verify with grep that nothing imports it; if truly
  unused, **delete the file**; if used, apply the same guard + compression
  changes there.

**Tests:** new `src/stores/slidesStore.test.ts` — round-trip small (plain) and
large (compressed, assert the `NEZ1:` prefix) slide arrays; loading legacy plain
JSON still works; `isSlide` accepts a google-svg slide and still rejects garbage.
Confirm `src/storage/recordingCodec.test.ts` still passes (meta.slides typing).

**Out of scope:** components, parser module (only import its types).

---

## Phase 3 — Rendering + step animator (Reveal integration)

**Goal:** `google-svg` slides render full-bleed inside Reveal; ArrowRight/Left
step through build animations before changing slides; replay drives the same
thing through the existing navigator/indexv path.

**New files**

- `src/googleSlides/animator.ts` — step animator (research §1.5), API:
  ```ts
  export class DeckStepAnimator {
    constructor(svgRoot: SVGSVGElement, steps: DeckStep[]);
    /** stepsRevealed: 0..steps.length. Animates only a single forward
     *  increment; everything else snaps. */
    setRevealed(stepsRevealed: number, opts?: { playbackRate?: number }): void;
    dispose(): void; // cancel rAF
  }
  ```
  Implementation notes: precompute a global timeline (`T0`/`T1` per step, entry
  offsets = delay, step length = max over entries of delay+duration); `update(t)`
  applies every track's value at clamped progress (forward order when t grows,
  reverse when it shrinks) as inline `style.opacity` / `style.transform`;
  opacity linear, scale/translate `easeInOutCubic`; translate values are
  percentages (`translate(X%, Y%)`); missing elements: re-query lazily
  (`el ??= svg.querySelector('#'+id)`) and skip if absent. After construction,
  `update(0)` so fade-in targets start hidden. rAF-driven animation for the
  single-forward-step case, duration divided by `playbackRate ?? 1`.
- `src/components/GoogleSvgSlide.tsx` — props
  `{ content: string; steps?: DeckStep[]; stepsRevealed: number }`. Injects
  `content` via `innerHTML` into a wrapper div (`useEffect` keyed on content),
  grabs the `<svg>` child, forces it to scale: remove fixed `width`/`height`
  attributes, set style width/height 100%, keep the viewBox
  (`preserveAspectRatio="xMidYMid meet"`); wrapper fills the slide area.
  Creates one `DeckStepAnimator` per injected SVG (dispose on cleanup) and
  calls `setRevealed(stepsRevealed)` when the prop changes.

**Files to modify**

- `src/components/RevealSlideRenderer.tsx`:
  - Change the `slides` prop to reuse the shared `Slide` type (it already
    mirrors a subset) so `steps`/`title` flow through.
  - Render branch: `contentType === "google-svg"` →
    `<RevealReactSlide key={id}><GoogleSvgSlide content=… steps=…
stepsRevealed={isCurrentSlide ? currentVerticalIndex : 0} /></RevealReactSlide>`
    (no background image — the SVG is the artwork).
  - Sync effect + navigator: when the target slide is google-svg, only
    `deck.slide(h, 0)` (vertical is always 0); `stepsRevealed` flows via React
    props from `currentVerticalIndex`, not through Reveal.
- `src/components/SlidePreview.tsx` — make arrow navigation step-aware:
  - `goToNextSlide`: if the current slide is google-svg with steps and
    `verticalIndex < steps.length` → `onSlideChange(sameIndex, verticalIndex+1)`
    and emit `slide_change` (same slideId, new indexv); else advance slide as
    today with indexv 0.
  - `goToPrevSlide`: mirror — if `verticalIndex > 0` → `verticalIndex - 1`;
    else go to the previous slide, and when that slide is google-svg with
    steps, land fully revealed (`indexv = steps.length`).
- Replay path: confirm `SlideReplayApplication.slideState.indexv` (applied in
  `NextEditorProvider` / `useSlidesController`) reaches `SlidePreview`'s
  `verticalIndex` prop so replayed step changes re-render `stepsRevealed`.
  Adjust only component-level wiring if it doesn't; **do not** touch
  `src/core/src/machine/**`.

**Interaction rules (UX spec, condensed):**

- ArrowRight reveals the next build step (animated); once all steps are shown it
  advances to the next slide. ArrowLeft hides the last revealed step; at step 0
  it goes to the previous slide fully revealed. Matches presenter muscle memory
  from Google Slides itself.
- Jumping (replay seek, direct navigation) snaps — only a single forward
  increment animates. The animator API encodes this.
- During playback (`isPlaying`) user navigation stays disabled (existing
  behavior, don't touch).

**Tests:** `src/googleSlides/animator.test.ts` under the existing vitest DOM
environment (check how existing tests get a DOM — e.g. editorMachine tests; if
there is no DOM env available, factor the timeline math into pure functions and
test those): step timeline computation, opacity/scale/translate values at
t=0 / mid / end, reveal-then-unwind returns initial state, missing element
skipped without throwing.

**Out of scope:** SlidesManager/import UI, stores, parser internals.

---

## Phase 4 — Import UX (SlidesManager)

**Goal:** users can import, update, and remove a Google Slides deck.

**UX spec (condensed):**

- New "Import from Google Slides" section in
  [SlidesManager.tsx](src/components/SlidesManager.tsx), above the create-slide
  section, styled like the existing bordered cards.
- One URL text input (placeholder
  `https://docs.google.com/presentation/d/e/…/pub`) + button ("Import slides").
  States: idle → loading (spinner in button, input disabled) → success (input
  cleared; list shows the slides) → error (inline red text under the input;
  surface `GoogleSlidesParseError.message`; distinct copy for
  not-a-published-URL vs fetch failure).
- Helper line under the input: "In Google Slides: File → Share → Publish to
  web, then paste the link here."
- If any slide has `sourceUrl`: show a compact banner above the list
  ("N slides from Google Slides" + link to the source deck) with two actions:
  **Update** (re-fetch + diff) and **Remove deck** (removes only google-svg
  slides). Hide the URL input while a deck exists (one deck at a time —
  deliberate simplification).
- Google slides in the list: type badge "SLIDES", preview text =
  `title || "Slide N"`, Edit action hidden (content not hand-editable),
  background picker not applicable, move/delete still available.

**Implementation**

- `src/googleSlides/importDeck.ts` (new, non-UI helper):
  `applyDeckToSlides(existing: Slide[], deck: ParsedDeck): Slide[]` — pure diff:
  google-svg slides keyed by `id === pageId` are updated in place (content,
  title, steps, sourceUrl), new pages appended in deck order after the last
  google-svg slide (or at the end), google-svg slides whose pageId disappeared
  are removed, html/markdown slides untouched, then `order` renumbered.
- SlidesManager wires `fetchPublishedDeck` + `applyDeckToSlides` through the
  existing `onSlidesChange` prop. Loading/error is local `useState`. No new
  store events.
- `getPreviewText`: google-svg → `slide.title || "Slide " + (index + 1)`.
- Keep the header as-is; do not redesign unrelated UI.

**Tests:** `src/googleSlides/importDeck.test.ts` (pure diff logic:
add/update/remove/mixed decks, order renumbering). Component test only if the
repo already has a `*.test.tsx` pattern; otherwise typecheck + manual QA.

**Out of scope:** renderer, animator, persistence.

---

## Phase 5 — Integration verification (coordinator, not a subagent)

1. `bun run typecheck`, `npx vp test run`, `bun run lint` — all green.
2. Review every phase's diff for contract drift (type names, indexv semantics,
   no new dependencies, and the reference product's name appearing nowhere).
3. End-to-end parser check against a real deck (node-side, no browser): a
   scratch `bun` script importing `fetchPublishedDeck`, fetching a real
   published deck URL, asserting slide count > 0, every slide starts with
   `<svg`, and steps arrays are well-formed.
4. Recording/replay sanity: existing `replayState.test.ts` and
   `recordingCodec.test.ts` pass, and `src/core/src/machine/**` has no diff
   beyond the slides type file.
5. UI is eyeballed by the user (project convention: no automated browser
   verification for this app).

## Sequencing & parallelism

- **Phase 1 ∥ Phase 2** — disjoint files (Phase 2 imports only the `DeckStep`
  type name from `src/googleSlides/types.ts`, which lands together with
  Phase 1; the coordinator resolves any mismatch at typecheck time).
- **Phase 3** after 1+2. **Phase 4** after 1+2+3.
- Subagents do **not** commit; the coordinator verifies (Phase 5) and the user
  decides about committing.

## Risks / notes

- Google's pub-page internals (`docData`, `SK_svgData`) are undocumented; the
  parser is isolated in `src/googleSlides/` and fixture-tested so breakage is
  detectable and repairable in one place. Fallback documented in research §4.
- Decks embed multi-MB SVG into recordings (`meta.slides`); the recording
  container is already fflate-compressed, and localStorage gets its own
  compression in Phase 2. If real-world decks still blow the 5 MB quota, a
  follow-up can move slide bodies to IndexedDB (out of scope now).
- Percent translations in step animations assume the element's own box as the
  reference — matches the reference implementation; verify visually with an
  animated deck.

---

## Phase 6 — Remove Reveal.js entirely

**Why:** the original ask was to _replace_ Reveal.js, not run Google slides
alongside it. `Reveal.js` was also found to never set an explicit `height` on
a slide's `<section>` (only `width: 100%`); this is _why_ google-svg slides
initially rendered nothing when wrapped in a `position: absolute; inset: 0`
div (it took the SVG out of flow, so the section collapsed to zero height —
fixed for the layered approach, but moot once Reveal.js is gone).

**Scope:** every slide type (`html`, `markdown`, `google-svg`) moves to one
custom renderer with no Reveal.js dependency. `reveal.js` and `@revealjs/react`
are removed from package.json; `marked` (already present transitively via
`@revealjs/react`, v14) is added as a direct dependency for markdown-to-HTML.

**Files removed:** `src/components/RevealSlideRenderer.tsx`.

**Files added:**

- `src/components/CustomSlideRenderer.tsx` — renders exactly the current slide
  (`slides[currentSlideIndex]`), filling its container, no transition/animation
  on slide change (removed per user feedback — an earlier direction-aware
  fade+translate mount transition made the rounded modal corners look jagged
  during the animation, a known browser artifact from promoting an animated
  descendant to its own compositing layer; simplest fix was to drop the
  transition entirely rather than compensate for it). Per contentType:
  `html` → `RawHtmlSlide` (moved in, unchanged: innerHTML + script re-exec),
  `markdown` → new `MarkdownSlide` (via `marked`), `google-svg` → the existing
  `GoogleSvgSlide` (`stepsRevealed = currentVerticalIndex`). No `key` on the
  slide wrapper, so a build-step reveal on a google-svg slide updates in place
  without remounting the animator.

**Files changed:**

- `src/components/SlidePreview.tsx` — now owns all navigation UI: on-screen
  prev/next controls and a slide counter/progress indicator, wired to the
  existing step-aware `goToNextSlide`/`goToPrevSlide` (unifying click and
  keyboard behavior — previously Reveal's own on-screen controls bypassed
  step-awareness entirely). Drops `setSlideNavigator` and the
  `handleSlideChangeFromReveal` bridge (no longer meaningful once there's no
  separate engine-internal index to reconcile). The `IFRAME_INTERACTION`
  message listener and `currentInteraction` state are untouched — unrelated to
  Reveal.js (generic iframe-interaction capture used elsewhere too).
- `src/contexts/SlidesStoreContext.tsx`, `src/contexts/NextEditorProvider.tsx`,
  `src/components/SlidePanel.tsx` — remove the imperative `navigator`
  (tier c) escape hatch entirely. It existed only to force Reveal's own
  internal slide index to stay in sync during replay; `applySlideState`
  already writes through `slidesStore.trigger.setPreviewState(...)`
  (verified), which alone is sufficient once the renderer is 100% prop-driven
  with no separate internal state to desync.
- `src/components/SlidesManager.tsx` — subtitle no longer says "Reveal.js
  powered".
- `index.css` — new slide-transition keyframes, following the existing
  `fade-in`/`fade-up` pattern (no animation library added, consistent with
  this repo already having removed `motion` from `LandingPage.tsx` in favor of
  a hand-rolled `useInView` hook).

**Verified before removal, not assumed:**

- No test file imported `RevealSlideRenderer` directly (grepped).
- `currentInteraction` forwarded to the old renderer only fed a documented
  no-op effect ("no visual rings or highlights are shown on the slides
  themselves") — dropping it from the new renderer's props is not a
  regression; the state itself keeps flowing through the store/replay engine
  exactly as before, just unconsumed by the renderer (as it always was).
- `data-cursor-replay-target="slide-preview"` / `"slide-content"` attributes
  (used by `src/core/src/utils/cursorCoordinates.ts` to scale replayed cursor
  positions) are preserved on the same elements in the new `SlidePreview.tsx`.

**Out of scope / deferred:** vertical slide _stacks_ for html/markdown content
(Reveal's `<Stack>`) were never actually used in this codebase — `Slide` is a
flat array, one slide per array entry, so nothing is lost by not replicating
Reveal's stack concept.
