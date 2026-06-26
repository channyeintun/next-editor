# Plan: Replace the mutable-closure domain-adapter service locator with proper one-way data flow

## Problem

`src/contexts/NextEditorDomainAdaptersContext.tsx` exposes three "domain adapters"
(`slides`, `preview`, `runtimePanel`) whose methods are **reassignable closures**.
Feature panels register their getters/setters at mount (`setSnapshotGetter`,
`setSnapshotApplier`, …); the core recorder machine calls those methods through the
`UseNextEditorConfig` callbacks built in `NextEditorProvider`.

This is a **service locator**. It exists because of a layering inversion: the provider
that builds the machine config sits _above_ the panels that own the state
(`Editor.tsx`: `NextEditorProvider` → `SlidesProvider` → …), so the parent cannot
construct the callbacks directly and the descendants write them into a shared mutable
bag instead.

Symptoms:

- No reactivity — last `set*` writer silently wins.
- Missing registration is a silent no-op (`() => null`), so a wiring bug surfaces three
  layers away as "replay is empty," not as an error.
- Mount-vs-first-read ordering is implicit.

> Note: the previously-documented empty/desynced replay bugs were **logic** bugs
> (patch-replay batch miss, rrweb remove-mutation drop, timeline drift), **not** caused
> by this wiring. This refactor is a maintainability change, not a bug fix.

## The proper architecture (target)

Keep the _good_ seam, delete the _bad_ one.

- **Keep** `UseNextEditorConfig` — the core (`src/core`) takes injected callback ports.
  That is correct dependency injection and is well tested. Do not touch the core
  contract.
- **Delete** the service-locator hop by matching each interaction to the React
  primitive that fits its nature:

  - **(a) Pull-at-record / (b) declarative apply-at-replay** → **single source of truth**.
    Relocate the recordable state into a store **created above `NextEditorProvider`**.
    The provider implements the config callbacks by reading/writing that store
    _directly_ (synchronously). Panels subscribe to the same store and render from it.
    The getter/applier channels disappear — nobody reaches "down" anymore.

  - **(c) Genuinely imperative ops** (reveal.js `.slide()`, preview DOM patch replay,
    console append) → an **explicit typed ref handle** (`useImperativeHandle`-style),
    single owner, null-checked at the call site. Not a service locator.

Data flows one way: store → panels (render); panels → machine (events/intents);
machine → store (replay writes). No back-references.

## Provider tree change

```
SlidesStoreProvider                     ← NEW: single source of truth for slides
  NextEditorDomainAdaptersProvider      ← now only preview + runtimePanel
    NextEditorProvider                  ← reads/writes SlidesStore for slide callbacks
      SlidesProvider                    ← consumes SlidesStore (no adapter registration)
        PreviewPanelProvider
          <children>
```

## Staging (by risk)

| Stage | Domain              | Nature                                              | Risk                  |
| ----- | ------------------- | --------------------------------------------------- | --------------------- |
| 1     | **Slides**          | 2 plain state fields + 1 imperative tail (navigate) | low–med               |
| 2     | **Runtime console** | snapshot + console append                           | med                   |
| 3     | **Preview**         | mostly imperative DOM (rrweb)                       | high — stays tier (c) |

Implement Stage 1 first, fully type-checked and with existing tests green, then proceed.
I cannot verify replay visually (project constraint), so each stage ends with a request
for the user to eyeball recording/replay.

---

## Stage 1 — Slides (this change)

### New files

- `src/stores/slidesStore.ts` — `createSlidesStore()`: an external store holding
  `{ slides, previewState }` with `getState()`, `subscribe()`, `setSlides()`,
  `setPreviewState()`, localStorage load/persist, plus a single typed imperative handle
  `navigator: { current: SlideNavigator | null }` (tier c).
- `src/contexts/SlidesStoreContext.tsx` — provides one store instance; `useSlidesStore()`.
- `src/hooks/useSlidesController.ts` — the old `useSlides` orchestration, but state lives
  in the store (via `useSyncExternalStore`); returns the **same shape** `useSlides` did,
  so `SlidePanel` / `SlidesButton` / `SlidePreview` are unchanged.

### Edited files

- `src/components/Editor.tsx` — wrap with `SlidesStoreProvider` at the top.
- `src/contexts/SlidesContext.tsx` — use `useSlidesController`; **remove all adapter
  registration effects**.
- `src/contexts/NextEditorProvider.tsx` — implement `getSlideState` / `applySlideState`
  / `getSlides` / `applySlides` directly from the store; replay navigate via
  `store.navigator.current?.(...)`.
- `src/components/SlidePanel.tsx` — pass `store.setNavigator` (assigns the ref) instead
  of `slidesAdapter.setNavigator`.
- `src/contexts/NextEditorDomainAdaptersContext.tsx` — remove `SlidesDomainAdapter`,
  `createSlidesDomainAdapter`, and `slides` from `NextEditorDomainAdapters`.

### Kept for compatibility

- `src/hooks/useSlides.ts` stays (still re-exported from `src/core/src/index.ts`).
  It is no longer used internally; flag for later removal once confirmed unused
  externally.

### Behavior preservation

- Port the existing reducer (`handleSlideEvent` switch) and the `applySlideState`
  compare-then-navigate logic verbatim; only the state backend changes
  (React `useState` → external store). localStorage persistence stays on `setSlides`.

### Verification

- `bunx tsc --noEmit` (or project typecheck) clean.
- `npx vp test run` — existing machine tests green (they mock the config callbacks, so
  they are unaffected by the React-side change).
- Ask the user to record + replay a slide presentation to confirm no regression.

---

## Stage 2 — Runtime console (follow-up)

Same shape: a runtime store above the provider; provider implements
`getRuntimeSnapshot` / `applyRuntimeSnapshot`; console _append_ stays a tier-(c) handle.
Remove `RuntimePanelDomainAdapter`.

## Stage 3 — Preview (follow-up)

Preview is mostly imperative DOM replay (rrweb). Do **not** force it into a store.
Convert `PreviewDomainAdapter` into an explicit typed imperative handle
(`useImperativeHandle` + ref passed down). Declarative bits (size/open/mode) may move to
a store; the patch-replay applier stays imperative. Remove `PreviewDomainAdapter` once
the handle replaces it.

## Done criteria

`NextEditorDomainAdaptersContext.tsx` is deleted; all three domains use either a store
(declarative) or an explicit typed ref handle (imperative); no reassignable
service-locator closures remain.
