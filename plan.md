# Slide texture backgrounds

Add `public/texture-1.jpeg` and `public/texture-2.jpeg` as selectable background
options for individual presentation slides (Reveal.js-based deck in
`SlidesManager.tsx` / `RevealSlideRenderer.tsx` / `SlidePreview.tsx`).

## Findings (context for implementers)

- `Slide` type (`src/types/slides.ts:3-8`) has no background field today.
- `RevealSlideRenderer.tsx` renders each slide via `@revealjs/react`'s
  `<Markdown>` (markdown slides) or `<Slide>` (html slides, wrapped as
  `RevealReactSlide`). Both components accept a `backgroundImage?: string`
  prop directly (confirmed via `@revealjs/react` dist types) — no need to
  hand-roll `data-background-image` attributes.
- `SlidesManager.tsx` is the only UI for creating/editing slides. It has an
  "Add Section" (new slide form) and a per-slide edit mode inside the list.
  Neither has any styling/background controls today.
- `slidesStore.ts` persists slides to `localStorage` via `isSlide` type guard
  - JSON — must stay backward compatible with slides saved before this change
    (missing `background` field should default to "none").

## Phase 1 — Data model + presets config

- `src/types/slides.ts`: add `background?: string` to `Slide` (stores a preset
  id, e.g. `"texture-1"`, `"texture-2"`, or `undefined`/`"none"` for no
  background).
- New `src/config/slideBackgrounds.ts`:
  - `SLIDE_BACKGROUND_PRESETS`: array of `{ id: string; label: string;
imagePath: string }`, entries for `texture-1` → `/texture-1.jpeg` and
    `texture-2` → `/texture-2.jpeg`.
  - `getSlideBackgroundImage(id?: string): string | undefined` helper that
    looks up a preset's `imagePath`, returning `undefined` for `"none"` /
    unknown ids.
- `src/stores/slidesStore.ts`: relax `isSlide` guard to accept an optional
  `background` string field so old localStorage data still loads.

## Phase 2 — Rendering in RevealSlideRenderer

- `src/components/RevealSlideRenderer.tsx`:
  - Extend the local `slides` prop array type with `background?: string`.
  - For each slide, resolve `backgroundImage` via
    `getSlideBackgroundImage(slide.background)` and pass it to `<Markdown>`
    (markdown slides) and `<RevealReactSlide>` (html slides).
  - No changes needed to `SlidePreview.tsx` beyond it already forwarding the
    full `Slide` objects through.

## Phase 3 — UI picker in SlidesManager

- `src/components/SlidesManager.tsx`:
  - Add a small background picker (swatch row: "None" + thumbnail swatches
    using `/texture-1.jpeg` and `/texture-2.jpeg` as `background-image` on
    small buttons) in:
    - The "Add Section" new-slide form (new state `background`, included when
      calling `addSlide`).
    - The per-slide edit mode (new state alongside `editContent`, included
      when calling `saveEdit`).
  - Show a subtle indicator of the current background on each slide's
    thumbnail in the list (e.g. the thumbnail's `background-image` set to the
    chosen texture when present, matching how the deck will actually render).

## Phase 4 — Verify

- Typecheck (`bunx tsc` per project convention) and run the existing test
  suite (`npx vp test run` per project convention — flaky-audio-test memory).
- No live preview/browser verification (project convention: don't use
  Claude's preview browser for this app — eyeball via tsc + tests, user
  verifies UI manually).
- Commit once all phases pass typecheck/tests.

## Follow-up — Custom texture upload

Added after Phase 4: a per-slide "upload your own image" swatch alongside the
two presets. `Slide.background` already stored a plain string, so a custom
upload is just a raw image data URL stored in that same field (no new type on
`Slide`) — `getSlideBackgroundImage()` now returns unknown ids as-is (treating
them as a direct image source) instead of `undefined`.

- `src/config/slideBackgrounds.ts`: `isCustomSlideBackground()`,
  `readCustomBackgroundImage()` (downscales to ≤1920px, re-encodes as JPEG
  ~0.8 quality client-side since the result lives inline in localStorage
  alongside the rest of the deck; rejects non-images and results still over
  ~1.5MB via `CustomBackgroundError`).
- `SlidesManager.tsx`'s `BackgroundPicker`: added an upload swatch (hidden
  file input, `accept="image/*"`) that shows the uploaded thumbnail once set,
  a spinner while processing, and a transient inline error on failure.
  Clicking "None" drops the custom image (not kept for restore, matching
  preset removal). Re-clicking an already-set custom swatch reopens the
  picker to replace it.
