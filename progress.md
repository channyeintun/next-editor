# Progress — Stage 1: Slides Store Refactor

## Tasks

- [x] Task 1–9: All complete

## Stage 1 Status: COMPLETE (c678b22)

---

# Progress — Stage 2: Runtime Console Store Refactor

## Tasks

- [x] Task 1–7: All complete

## Stage 2 Status: COMPLETE (f592b71)

---

# Progress — Stage 3: Preview Imperative Handle Refactor

## Tasks

- [ ] Task 1: Create `src/stores/previewAdapterHandle.ts` — typed imperative handle interface
- [ ] Task 2: Create `src/contexts/PreviewAdapterHandleContext.tsx` — provider + hook
- [ ] Task 3: Wire `PreviewAdapterHandleProvider` into `Editor.tsx` provider tree
- [ ] Task 4: Update `NextEditorProvider.tsx` to use preview handle instead of adapter
- [ ] Task 5: Update `usePreviewPlaybackRegistration.ts` to register on the handle
- [ ] Task 6: Update `PreviewPanelContext.tsx` to use handle for dock-width-delta
- [ ] Task 7: Remove `NextEditorDomainAdaptersContext.tsx` entirely
- [ ] Task 8: Clean up any remaining imports of the deleted file
- [ ] Task 9: Verification — typecheck, lint, tests
