# Progress — Stage 1: Slides Store Refactor

## Stage 1 Status: COMPLETE (c678b22)

---

# Progress — Stage 2: Runtime Console Store Refactor

## Stage 2 Status: COMPLETE (f592b71)

---

# Progress — Stage 3: Preview Imperative Handle Refactor

## Stage 3 Status: COMPLETE (7aa1723)

---

# Plan Status: COMPLETE

All three stages implemented. Done criteria met:

- `NextEditorDomainAdaptersContext.tsx` deleted
- Slides: external store (`slidesStore.ts` + `SlidesStoreContext.tsx`)
- Runtime console: external store (`runtimePanelStore.ts` + `RuntimePanelStoreContext.tsx`) with typed imperative handles for console append/open
- Preview: explicit typed imperative handle (`previewAdapterHandle.ts` + `PreviewAdapterHandleContext.tsx`)
- No reassignable service-locator closures remain

---

# Review follow-up (post-implementation)

Triggered by review: the first cut hand-rolled `useSyncExternalStore` instead of
using `@xstate/store-react` (already a dep, already the `workspaceStore.ts`
convention). Corrected:

- [x] Fix: `getSlideState` regression — restored unconditional getter +
      `Math.max(0, …)` clamp (was gating on `isOpen`, returning null) — commit
- [x] Migrate `slidesStore` → `@xstate/store-react` (`createStore` / `trigger` /
      `useSelector`); navigator stays a separate imperative ref. Also fixed
      `applySlideState` to compare against pre-update state — commit
- [x] Migrate `runtimePanelStore` → `@xstate/store-react`; per-field
      `useSelector` (fine-grained); console append/open stay imperative refs — commit
- [x] Preview stays an explicit imperative handle (genuinely imperative — not state)
- Decision: do NOT add Zustand — it would be a third state paradigm alongside
  XState + `@xstate/store`; the latter already covers this need.

Verified each step: typecheck + lint + 135/135 tests + production build.
Still needs a human to eyeball slide / preview / console record+replay.
