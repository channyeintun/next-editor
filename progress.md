# Captions Feature — Progress

## Phase 1: Model + Persistence ✅

- [x] Add caption types to `src/core/src/types.ts`
- [x] Add `captions` field to `Recording` interface
- [x] Add `captions` to `RecordingStreamMeta` in SCR3 format
- [x] Wire captions through SCR3 encode
- [x] Wire captions through SCR3 decode
- [x] Add round-trip test in `recordingCodec.test.ts`

## Phase 2: Parser ✅

- [x] Create `src/captions/parseCaptions.ts` (VTT + SRT)
- [x] Create `src/captions/parseCaptions.test.ts`

## Phase 3: Import Wiring

- [ ] Add `addCaptionTrack` / `removeCaptionTrack` events to `editorMachine`
- [ ] Surface actions through `useNextEditor` → actions context → provider
- [ ] Add "Import captions…" UI entry point

## Phase 4: Playback Overlay

- [ ] Create `src/components/CaptionsOverlay.tsx`
- [ ] Mount in `Editor.tsx` as sibling of `CameraOverlay`

## Phase 5: Controls (CC toggle + language menu + caption store)

- [ ] Create `src/stores/captionStore.ts`
- [ ] Create `src/contexts/CaptionStoreContext.tsx`
- [ ] Wire caption store provider
- [ ] Add CC button + language menu in `MediaControls.tsx`
