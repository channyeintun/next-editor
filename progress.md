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
- [x] **T3. Worker/client streaming entry points** — `recordingCodec.ts` adds
      `encodeRecordingToStream` / `encodeRecordingToBase64Stream`; worker + client expose the
      SCR3 encode entry points (heavy deflate stays off the main thread). (Magic dispatch was
      added here then removed in T9 — SCR3 is now the only decode path.)
- [x] **T4. Segmented IndexedDB store** — `IndexedDBRecordingStore.ts`: added
      `recording-segments` store (composite key `[recordingId, seq]`), bumped DB version to 2,
      `appendSegments` for incremental writes, `getEntry`/`getAllEntries` concat segments in seq
      order, `putMany` replaces segments, `delete`/`clear` cover all stores. (Legacy
      `recording-payload` fallback was added here then removed in T9.)
- [x] **T5. JsonStorage append + export via SCR3** — `appendRecordingSegments` for incremental
      persistence; `createStoredEntry`/`exportAsFile` use SCR3 (`encodeRecordingToStream` /
      `encodeRecordingToBase64Stream`).
- [x] **T6. Storage size validation** — `scripts/measure-recording-size.mjs` (+ `measure:recording`
      npm script): dependency-free walk of the SCR3 container reporting compressed bytes per
      segment kind, header/footer/segment-header overhead, and audio vs non-audio split. On the
      demo: 1.80 MB binary stream (vs ~2.08 MB SCRM baseline measured in T2), overhead ~7.8 KB.

## Direction change (2026-06-15) — no backward compatibility

User decided old recordings need not be retained; remove all legacy/back-compat code. plan.md
section 6 rewritten accordingly. This supersedes the legacy bits of T3/T4 (the SCRM decode
fallback, magic dispatch, and IndexedDB `recording-payload` blob fallback).

- [x] **T9. Remove legacy/back-compat code (SCR3-only)**
  - `recordingCodec.ts`: SCR3-only decode (dropped SCRM decode/dispatch); removed SCRM writer
    (`compressRecordingsToBinary`/`encodeRecordingsToBase64`) and superjson usage.
  - `recordingCodec.worker.ts` / `recordingCodecClient.ts`: dropped SCRM entry points.
  - `IndexedDBRecordingStore.ts`: removed `recording-payload` store + fallback + `getStoredPayload`;
    segment store is the only payload; old DB data discarded on upgrade (delete legacy store +
    clear dangling metadata).
  - `JsonStorage.ts` + context/provider: removed `exportAllAsFile` (SCRM multi-recording only).
  - Deleted `SuperJsonConfig.ts`; dropped `superjson` dependency.
  - Regenerated `public/introduction.ne` as an SCR3 file (verified it decodes via the SCR3-only
    path: 3228 frames, 3469 cursor events, 196 preview patch batches, audio intact).
  - Updated `recordingCodec.test.ts` to SCR3. Validated: `vp check` clean, build green, 65/65 tests.

## Phase 3 — Live audio chunks + optional sink

- [x] **T7. Audio live timeslice chunks** — `audioActor.ts`: `mediaRecorder.start(AUDIO_TIMESLICE_MS)`
      (1000ms) so `ondataavailable` fires periodically and the existing `CHUNK` emit forwards live
      audio data. The final assembled blob (`STOPPED`) and duration logic are unchanged; the
      `recording` state ignores `CHUNK` until the sink/store is wired in T8 (additive, no-op now).
- [ ] **T8. Optional live sink + config wiring** — `recordingStreamSink.ts` + opt-in config.

## Notes / decisions

- Phase 1 is shipped as a single commit because the `RecordingSession` type change requires
  all capture/finalize sites to update together for the build to stay green.
