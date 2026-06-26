# Progress — Stage 1: Slides Store Refactor

## Tasks

- [ ] Task 1: Create `src/stores/slidesStore.ts` — external store with slides state + navigator handle
- [ ] Task 2: Create `src/contexts/SlidesStoreContext.tsx` — provider + hook
- [ ] Task 3: Create `src/hooks/useSlidesController.ts` — same shape as `useSlides`, backed by store
- [ ] Task 4: Wire `SlidesStoreProvider` into `Editor.tsx` provider tree
- [ ] Task 5: Rewrite `SlidesContext.tsx` to use `useSlidesController`, remove adapter registration
- [ ] Task 6: Update `NextEditorProvider.tsx` to read/write slides store directly
- [ ] Task 7: Update `SlidePanel.tsx` to use store navigator handle instead of adapter
- [ ] Task 8: Remove `SlidesDomainAdapter` from `NextEditorDomainAdaptersContext.tsx`
- [ ] Task 9: Final verification — typecheck, tests, cleanup
