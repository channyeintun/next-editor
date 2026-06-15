# Stream-Compatible Recording — Progress

Tracks execution of [plan.md](plan.md). Each task: implement → update this file → lint/format/build → commit.

Last updated: 2026-06-15

## Status legend

- [ ] not started
- [~] in progress
- [x] done (committed)

## Phase 1 — Incremental encoder (no storage change)

- [x] **T1. Incremental frame encoder + session wiring**
  - New `src/core/src/utils/frameStreamEncoder.ts` (pure, reuses `frameDelta` helpers).
  - `RecordingSession`: `frames: DeltaFrame[]` + `encoder: FrameStreamEncoderState`.
  - `editorMachine.ts`: `initRecordingSession`, `captureInitialFrame`, `captureFrame`,
    `capturePreviewRefreshFrame`, `finalizeRecording` use the encoder; mouse-throttle reads
    `encoder.lastFullFrame`.
  - Keep `compressFrames` as canonical reference (still used by tests).
  - Validated: `vp check --fix` clean, `npm run build` green, full suite 65/65 pass.

## Phase 2 — SCR3 container + segmented IndexedDB

- [x] **T2. SCR3 streaming codec module** — `src/storage/streamingRecordingCodec.ts`
      (append-only segmented writer/reader, msgpack records, per-segment deflate at keyframe
      boundaries). Added `@msgpack/msgpack`. Verified round-trip on `public/introduction.ne`:
      semantically identical frames/cursor/preview/audio, prefix decode replays complete
      segments, and SCR3 is ~9% smaller than legacy SCRM (non-audio data ~24% smaller).
- [ ] **T3. Magic dispatch + worker/client streaming entry points** — `recordingCodec.ts`
      dispatch on `SCRM`/`SCR3`; worker + client streaming encode/decode.
- [ ] **T4. Segmented IndexedDB store** — `IndexedDBRecordingStore.ts` segment store, DB
      version bump, append + concat read, legacy blob read kept.
- [ ] **T5. JsonStorage append + export via SCR3** — `appendRecordingSegments`, finalize/export.
- [ ] **T6. Storage size validation** — one-off measurement script (no unit tests).

## Phase 3 — Live audio chunks + optional sink

- [ ] **T7. Audio live timeslice chunks** — `audioActor.ts` timeslice `start()`, route `CHUNK`.
- [ ] **T8. Optional live sink + config wiring** — `recordingStreamSink.ts` + opt-in config.

## Notes / decisions

- Phase 1 is shipped as a single commit because the `RecordingSession` type change requires
  all capture/finalize sites to update together for the build to stay green.
