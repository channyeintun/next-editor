# Preview rrweb Migration — Progress

Tracks execution of `preview-plan.md` (adopt rrweb for runtime preview record/replay;
no legacy; engine stays an opaque transport).

## Verification policy

Each commit must be **green** on `bun run typecheck` and `bun run test` (vitest).
Full visual fidelity (rrweb Replayer layout, scroll, float/unfloat) needs **manual
browser verification** with the running app — flagged per task where it applies.

## Task list & status

| #   | Task                                                                                                         | Status | Verified by               |
| --- | ------------------------------------------------------------------------------------------------------------ | ------ | ------------------------- |
| 0   | Add rrweb dep; baseline; progress.md                                                                         | DONE   | install ok                |
| 1   | Foundation: vendored UMD bundle, rrweb event types (both slides copies), shared message/event module         | DONE   | typecheck+test            |
| 2   | Recording: replace injected custom recorder with rrweb `record`; update message bridge to carry rrweb events | TODO   | typecheck+test            |
| 3   | Replay: rrweb `Replayer` applier driven by the existing seek machine; mount into preview panel               | TODO   | typecheck+test (+browser) |
| 4   | Scroll/viewport: retire decoupled runtime scroll path; responsive replay iframe; float/unfloat fidelity      | TODO   | typecheck+test (+browser) |
| 5   | Delete custom path: recorder, apply engine, seed-patch transforms, op types, validators                      | TODO   | typecheck+test            |
| 6   | Tests: rrweb round-trip (virtual-list churn + scroll/float-unfloat)                                          | TODO   | test                      |

## Notes / decisions

- Two duplicated type copies: `src/types/slides.ts` (app) + `src/core/src/slides.ts` (engine).
  Engine only reads `.time` / array length, so payload fields can carry rrweb events
  without engine logic changes (not a "redesign").
- rrweb 2.0.1. UMD global `window.rrweb` (`rrweb.umd.min.cjs`, ~265KB) inlined into the
  WebContainer page via `?raw` import for recording. `Replayer` imported as ESM in host.
- Preview record envelope keeps `time`/`documentId`; `html`/`ops` replaced by `events`.

## Log

- T0: `bun add rrweb` → rrweb@2.0.1. Baseline: only package.json + bun.lock changed.
- T1: Added `PreviewRecordedEvent` + optional `events?` to `PreviewInitialDocument`/
  `PreviewDomPatchBatch` in both slides copies (additive; legacy `html`/`ops` kept).
  New `rrwebPreview.ts`: vendored UMD (`vendor/rrweb.umd.min.cjs` via `?raw`),
  `createRrwebPreviewRecorderScript`, `buildRrwebReplayEvents`, `hasRrwebPreviewEvents`.
  `?raw` bare-specifier rejected by rrweb `exports` → vendored copy instead.
  Green: typecheck ok; 5 new tests pass; full suite 76 pass / 2 pre-existing audio fails.
