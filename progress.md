# Progress — Stage 1: Slides Store Refactor

## Tasks

- [x] Task 1: Create `src/stores/slidesStore.ts` — external store with slides state + navigator handle
- [x] Task 2: Create `src/contexts/SlidesStoreContext.tsx` — provider + hook
- [x] Task 3: Create `src/hooks/useSlidesController.ts` — same shape as `useSlides`, backed by store
- [x] Task 4: Wire `SlidesStoreProvider` into `Editor.tsx` provider tree
- [x] Task 5: Rewrite `SlidesContext.tsx` to use `useSlidesController`, remove adapter registration
- [x] Task 6: Update `NextEditorProvider.tsx` to read/write slides store directly
- [x] Task 7: Update `SlidePanel.tsx` to use store navigator handle instead of adapter
- [x] Task 8: Remove `SlidesDomainAdapter` from `NextEditorDomainAdaptersContext.tsx`
- [x] Task 9: Final verification — typecheck, tests, cleanup

## Stage 1 Status: COMPLETE

Committed as c678b22.

---

# Progress — Stage 2: Runtime Console Store Refactor

## Tasks

- [ ] Task 1: Create `src/stores/runtimePanelStore.ts` — external store for runtime panel state + imperative handles
- [ ] Task 2: Create `src/contexts/RuntimePanelStoreContext.tsx` — provider + hook
- [ ] Task 3: Wire `RuntimePanelStoreProvider` into `Editor.tsx` provider tree
- [ ] Task 4: Update `NextEditorProvider.tsx` to read/write runtime store directly
- [ ] Task 5: Update `TerminalPanel.tsx` to use store instead of adapter registration
- [ ] Task 6: Remove `RuntimePanelDomainAdapter` from `NextEditorDomainAdaptersContext.tsx`
- [ ] Task 7: Verification — typecheck, lint, tests
