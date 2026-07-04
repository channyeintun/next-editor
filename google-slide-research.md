# Google Slides instead of Reveal.js — research findings

Date: 2026-07-04
Sources: reverse-engineering of a production e-learning platform's bundles in
`slide-research/` (`app.UK3DL7B2.js`, `ide.36BDFLCO.js`), plus live verification
against a real published Google Slides deck. Below, that platform is called
"the reference implementation".

## TL;DR

The reference implementation does **not** use the Google Slides API, OAuth, or an
iframe embed. The user publishes their deck via Google Slides' built-in
**File → Share → Publish to web**, and pastes/drops the resulting
`https://docs.google.com/presentation/d/e/…/pub` URL into the app. The client then
`fetch()`es that published HTML page **directly from the browser** (Google reflects
the `Origin` header, so CORS allows it — verified live), scrapes one **inline SVG
per slide** plus a JSON blob describing slide metadata and build/animation steps,
stores each SVG as an asset, and renders slides by injecting the SVG into the DOM.
A ~100-line custom animator replays Google's per-element build animations
(opacity / scale / translate) against SVG element ids.

This approach is very compatible with our recorder/replay architecture (inline SVG
DOM replays naturally under rrweb, unlike an iframe embed) and could either replace
Reveal.js or be layered inside it as a new slide content type.

---

## 1. How the reference integration works (from the bundles)

### 1.1 URL type

`GoogleSlidesUrl extends OPUrl` with a single accepted pattern
(app bundle @ ~1578739):

```
https://docs.google.com/presentation/d/e/*
```

That is the _published-to-web_ URL form (`/d/e/2PACX-…/pub`), not the normal
editor URL (`/d/<id>/edit`). Users must publish the deck first; the reference
implementation does not transform editor URLs.

### 1.2 Fetch + parse pipeline (`parse_google_slides`, ide bundle @ ~688553)

1. `url.split("?")[0]` — strip query params.
2. `await fetch(url)` — plain browser fetch of the published HTML page.
3. Extract three things from the HTML with string scanning / regex:
   - **`docData:`** — finds the literal `docData:` and bracket-matches the JSON
     array that follows. Structure used:
     - `docData[0] = [width, height]` (internal units; only used for aspect ratio)
     - `docData[1][i] = slide tuple` where:
       - `[0]` = page id (e.g. `"p"`, `"g102c4f1c756_0_526"`)
       - `[2]` = slide title
       - `[7][0]` = raw animation/build steps for the slide
   - **`setPageData('<id>'…)`** occurrences — ordered list of page ids
     (regex `/setPageData\('([^)']+)/g`).
   - **`SK_svgData = '<hex-escaped SVG>'`** occurrences — one per slide, in the
     same order as the page ids (regex `/SK_svgData \= \'([^\']+)\'/g`). Decoded
     with: replace `\xNN` escapes → `JSON.parse` of the quoted string →
     `slice(indexOf("<svg"))`.
4. Build one record per slide:
   `{ name: pageId + ".svg", title, width, height, steps, body: svgString }`.
5. **Steps filter**: for each raw step group, drop entries whose target id `P[1]`
   is one of the page ids (those are whole-slide transition entries); keep the
   rest as `[entries]`. **This is the only filter that decides whether a step
   survives.** The `o[6] == 2` flag (§1.5) is a _separate_ exclusion applied
   later, at animation time, and never affects whether the step itself is
   kept — a step whose every surviving (non-page-id) entry has `o[6] == 2`
   still exists as a real, empty-effect step. (Confirmed 2026-07-04: an
   earlier restatement of this algorithm in `plan.md` conflated the two,
   causing our port to drop such steps and silently shift step numbering —
   fixed; see plan.md's Phase 1 correction note.)

### 1.3 Import / storage (`_import_from_google`, ide bundle @ ~688990)

- Each slide's SVG string → `new Blob([body], {type: "image/svg+xml"})` →
  vector-image asset (`OPVectorImage.create(blob)`) → stored **asset id**. The
  SVG body itself is deleted from the slide record after upload; slides carry
  only asset refs.
- Slide model (`SISlide` / widget `IDESlide`): `name`, `title`, `steps` (json),
  `asset` (vector image), `currentStep` (int, default −1), `width`, `height`.
- Deck model (`SISlides` / `IDESlides`): `items` (slide ids), `url` (source deck),
  `width`, `height`, `currentIndex`.
- **Re-import is a diff, keyed by `name` (page id)**: existing slides matching an
  incoming page id are updated in place (title/asset/steps), new ones are
  appended (`_pos = index * 1000` for ordering), slides no longer in the deck are
  deleted. Toasts: "Updated slides" / "Added N slides".

### 1.4 Rendering (`SlideImage` component, ide bundle @ ~678900)

On mount it fetches the asset's SVG **text** and injects it via `innerHTML`
(inline SVG in the DOM — _not_ an `<img>`; that matters, see §2.4). Before
injection, `normalizeSVG` does:

- strip `tabindex="…"` attributes;
- rewrite every `xlink:href`:
  - Google redirect wrappers `https://www.google.com/url?q=<real>` → unwrap to
    the real URL (these are hyperlinks the author put on shapes);
  - any other external URL (except the platform's own host and `data:` URIs) →
    `/slide-image/<encodeURIComponent(url)>` — a **server-side proxy route**
    for images referenced by the SVG.

### 1.5 Build-step animation (`Animator`, ide bundle @ ~676300)

Google's published page includes per-slide build/animation data
(`docData[1][i][7][0]`), and the reference implementation replays it natively:

- A **step** is an array of animation entries. Entry `o`:
  - `o[1]` = SVG element id, resolved lazily as `o.EL ||= svg.querySelector('#' + o[1])`
    — a miss is **retried on every apply**, not cached permanently, so an
    element that isn't in the DOM yet at construction time is picked up as
    soon as it appears. (This is an animation-time detail, unrelated to the
    parse-time page-id filter in §1.2.)
  - `o[2]` = duration ms (min 1), `o[3]` = delay ms
  - `o[6] == 2` → build no track for this entry at all (it never gets an
    opacity/scale/translate handler, contributes 0 to the step's duration);
    this is purely an animation-time no-op, **not** a parse-time exclusion —
    see the §1.2 correction note.
  - `o[0]` = property tracks `x`, applied by a plain `if / else if / else if`
    chain that assigns `style.transform` directly per branch — **tracks are
    never composed**, so if one entry somehow carries both a scale and a
    translate track, whichever is processed later in `x`'s order simply
    overwrites the earlier one on `style.transform` (confirmed 2026-07-04
    directly from the bundle; our first port combined them into one
    `"translate(...) scale(...)"` string, which was wrong — fixed):
    - `x[0] == 0` → opacity from `x[1]` to `x[2]` (linear progress)
    - `x[0] == 2` → `scale()` from `x[2]` to `x[3]` (easeInOutCubic)
    - `x[0] == 3` → `translate()` from `(x[1], x[2])` to `(x[3], x[4])` in
      percent (easeInOutCubic)
- Animations are applied as inline `style.opacity` / `style.transform` on the
  matched SVG elements. Steps map onto a global timeline (`T0`/`T1` per step);
  stepping forward animates, jumping (or backward) snaps via `update(t)` which
  replays/unwinds all tracks — fully **scrubbable**, and it divides duration by
  `timeline.playbackRate`, so it respects playback speed. The very first
  `currentStep` assignment after construction has no prior numeric state to
  compare against, so it always takes the snap branch rather than animating —
  our port replicates this with an explicit "first call always snaps" flag.
- Navigation semantics (`stepForward/stepBackward`): advance within a slide's
  steps first, then move to next/prev slide; `currentStep` is a persisted int,
  i.e. **slide + step state is part of the recording timeline** and replays
  deterministically.

### 1.6 UX flow

- Empty state: "You can import from Google Slides." Actions:
  - `import_from_google` — shown when the deck has no slides; prompts for a
    published-deck URL.
  - drag-and-drop import (`dnd: true`) — drop a published URL onto the editor.
  - `reimport_slides_from_google` — shown when a source url is stored; refetches
    and diffs (the update path).
- When populated, header shows "This … contains slides from
  <a href=deckUrl>Google Slides</a>."
- Right-arrow hotkey → `step_forward`.

---

## 2. Live verification (2026-07-04, real published deck, 26 slides)

Tested against `https://docs.google.com/presentation/d/e/2PACX-1vTWB8…/pub`.

### 2.1 CORS — the crucial enabler ✅

```
curl -H "Origin: https://example.com" …/pub
→ access-control-allow-origin: https://example.com
```

Google **reflects any Origin** on published-deck pages, so a plain client-side
`fetch()` works from any web app, no proxy and no auth. (Still worth a fallback
plan — this is undocumented behavior Google could change.)

### 2.2 Markers present ✅

The pub HTML (12.1 MB for 26 slides) contains exactly what the parser needs:
1 × `docData:`, 26 × `setPageData('…')`, 26 × `SK_svgData = '…'`.
`docData[0] = [365760, 205740]` → 16:9. Decoded SVGs have
`viewBox="0 0 960 540"` (pt) — reading the viewBox is simpler than decoding
Google's internal units.

### 2.3 SVG contents

- **All text is outlined as `<path>`** — pixel-perfect, no font loading issues,
  but not selectable; Google includes `a11y-*` elements for accessibility labels.
- Raster images appear as `<image xlink:href="https://docs.google.com/…">`
  (external URLs, not data URIs); hyperlinks are `www.google.com/url?q=…`
  wrappers. This is exactly what `normalizeSVG` handles.
- **Size**: ~460 KB average per slide uncompressed (12 MB total for this deck).
  Path-heavy SVG compresses very well (fflate, which we already ship, should get
  roughly 5–10×), but raw decks will not fit in localStorage (5 MB quota).

### 2.4 Why inline SVG injection (not `<img>`)

An SVG loaded as an image cannot fetch external resources, so slides with
pictures would break; inline SVG in the DOM can. Inline SVG also allows
`querySelector('#id')` for step animations — and is recorded/replayed by rrweb
as ordinary DOM.

---

## 3. Where we are today

> Historical note: this section originally described the Reveal.js-based
> renderer that existed when this research began. Reveal.js was removed
> entirely in `plan.md` Phase 6 (2026-07-04) in favor of a custom renderer;
> the description below reflects the current state.

- [CustomSlideRenderer.tsx](src/components/CustomSlideRenderer.tsx) renders
  the current slide directly (no engine, no h/v indices): `html` →
  `RawHtmlSlide` (innerHTML + script re-exec), `markdown` → `MarkdownSlide`
  (via `marked`), `google-svg` → [GoogleSvgSlide.tsx](src/components/GoogleSvgSlide.tsx).
  [SlidePreview.tsx](src/components/SlidePreview.tsx) owns all navigation
  (on-screen controls + keyboard), step-aware for `google-svg` slides.
- Slide model ([slides.ts](src/types/slides.ts), [slidesStore.ts](src/stores/slidesStore.ts)):
  `{ id, content, contentType: "html" | "markdown" | "google-svg", background?,
title?, steps?, sourceUrl?, order }`, persisted to **localStorage** with
  fflate compression above 200 KB, preview state in an `@xstate/store`.
- Backgrounds come from our texture feature (`getSlideBackgroundImage`);
  not applicable to `google-svg` slides (the SVG is the artwork).
- Replay writes straight through `slidesStore.trigger.setPreviewState(...)`;
  there is no separate imperative navigator to keep in sync (the Reveal-era
  "tier c" escape hatch was removed along with Reveal.js).
- The parser/animator/import pieces described in §1 above are implemented in
  [src/googleSlides/](src/googleSlides/); see `plan.md` Phases 1–4 for the
  port design and Phase 1's correction note + this doc's 2026-07-04 updates
  for two subtle fidelity bugs (step-count drift, transform overwrite
  semantics) found by diffing our port against the bundle directly.

---

## 4. Options compared

|                            | A. Published-deck SVG import (scrape)                              | B. Google Slides REST API                                                          | C. iframe embed (`/pub?…` or `/embed`)                                   |
| -------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Auth                       | none (deck must be "Published to web")                             | OAuth2 + API key, quotas                                                           | none                                                                     |
| Fidelity                   | pixel-perfect vector                                               | `getThumbnail` = raster PNG per page; JSON layout would mean rebuilding a renderer | perfect (it _is_ Google's player)                                        |
| Build animations           | yes — steps data included, replayable                              | no (thumbnails are static)                                                         | plays, but not programmatically controllable (no public postMessage API) |
| Offline / stored           | yes, SVGs stored as assets                                         | yes (PNGs)                                                                         | no — live Google page                                                    |
| rrweb record/replay        | ✅ plain DOM                                                       | ✅ plain DOM (imgs)                                                                | ❌ cross-origin iframe is a black box                                    |
| Deterministic step control | ✅ (`currentStep` int)                                             | n/a                                                                                | ❌                                                                       |
| Risk                       | undocumented page internals (`docData`, `SK_svgData`) could change | stable, documented                                                                 | stable                                                                   |
| Server needed              | optional image proxy only                                          | token handling                                                                     | none                                                                     |

**Decision: Option A** (chosen), exactly because of our recorder — slides become
inline SVG DOM that rrweb captures for free, and slide/step navigation is two
integers that fit our existing store/replay event model. Option B is the
documented fallback if Google ever breaks the pub-page format (losing vectors
and animations). Option C is a non-starter for recording/replay.

---

## 5. Sketch of an implementation plan (superseded by plan.md)

1. **Parser module** (pure, testable): fetch pub URL, extract `docData`
   (bracket matcher), page ids, SVG blocks; return
   `{ url, width, height, slides: [{ pageId, title, svg, steps }] }`. Port the
   steps filter. (Pseudocode basis: §1.2; a saved sample pub.html can be used as
   a test fixture.)
2. **Slide model extension**: new `contentType: "google-svg"` with `steps`,
   `title`, `sourceUrl` on the slide; deck-level `sourceUrl` for reimport.
   Keep `id = pageId` so reimport can diff like the reference implementation.
3. **Storage**: SVGs are too big for raw localStorage — compress (fflate).
4. **Renderer**: render a `google-svg` slide as an inline SVG (originally
   inside a Reveal.js shell alongside `html`/`markdown` slides, later
   replaced by a custom renderer for all slide types — see `plan.md` Phase 6);
   steps handled by our own animator (~100-line port: opacity/scale/translate
   - easeInOutCubic, scrubbable `update(t)`), which the reference
     implementation proves is sufficient.
5. **SVG normalization on import**: strip `tabindex`, unwrap
   `google.com/url?q=` hyperlinks, decide policy for external `<image>` hrefs
   (leave absolute — works because we inline the SVG — or proxy later if
   flakiness shows up).
6. **Recording/replay**: slide index + step index events through the existing
   slides store; inline SVG mutates via style attributes, which rrweb captures.
7. **UX**: import field/drop target for a published URL, "reimport" action when
   `sourceUrl` exists, and clear messaging that the deck must be
   File → Share → Publish to web.

## 6. Open questions / risks

- **Format stability**: `docData` / `SK_svgData` are internal to Google's pub
  page. Mitigation: keep the parser isolated + fixture-tested, fail with a clear
  error, keep Option B (thumbnails API) as fallback.
- **CORS reflection** is likewise unofficial; a tiny fetch-proxy endpoint would
  be the fix if it disappears.
- Speaker notes: not extracted by the reference implementation; unknown whether
  the pub HTML includes them (not investigated).
- Very large decks: 26 slides ≈ 12 MB raw SVG; need compression and possibly
  lazy per-slide loading.
- Slide _transitions_ (between slides) are not in the steps data the reference
  implementation uses (it filters out page-id entries); it appears to cut
  between slides.
