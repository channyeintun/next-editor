# Studio M0 Runbook — Vertical-Slice Lesson Renders

Implements **M0** of [agent-lesson-production.md](./agent-lesson-production.md) §12: a
deterministic in-app Performer renders one hard-coded ~22-second Go lesson from a
checked-in compiled plan and pre-generated narration, records it through the real
recorder, and gates the artifact with mechanical QA plus a two-render repeatability
comparison.

## Running a render

```text
bun run dev
open http://localhost:5173/studio            # dev-only route; absent from prod builds
```

- Click **Start render** (a click satisfies the browser's audio autoplay policy), or
  open `/studio?autostart=1` in a browser/profile that allows audio autoplay
  (Chrome: `--autoplay-policy=no-user-gesture-required` for unattended runs).
- Click **Render again** after the first run finishes: the panel then shows the
  normalized **Repeatability** verdict between the two runs (also compared across a
  reload within one browsing session via `sessionStorage`).
- **Download bundle** saves `lesson-m0-go-hello.ne`, the narration `.m4a`,
  `build-manifest.json`, and `render-report.json`. A failed render only offers the
  report — failed builds never yield a lesson bundle.
- Automation can read `window.__NEXT_EDITOR_STUDIO__` (runs, reports, manifests,
  comparison, running flag) instead of scraping the DOM.
- Use a normal-width window (≥1280 px): the render console overlays the top-right
  and must not cover the file sidebar or runner dock the cursor tweens toward.

Query params: `plan` (slug from `src/studio/plans`), `runtime` (`fixture` | `live`),
`autostart=1`.

### Runtime modes

- `fixture` (default): the Go run replays the plan's pinned result through the same
  console formatting/store path as a live run, after a fixed planned latency. Works
  signed-out and offline; the manifest records `runtimeMode: "fixture"`.
- `live`: the real `/api/go-playground/run` proxy — requires `bun run dev:worker`,
  a signed-in session, and the Go-tools kill switch enabled. The pinned M0 program
  is deterministic, so live and fixture renders produce identical console lines.

## What exists (map)

| Piece                                                                       | Where                                                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Compiled-plan schema (Zod, versioned, timing/overlap/caption validation)    | `src/studio/plan.ts`                                                             |
| Seeded cadence + easing (typing chunks materialized into the plan)          | `src/studio/cadence.ts`                                                          |
| StudioDriver: open/type/cursor/run/wait/expect through real app seams       | `src/studio/driver.ts`                                                           |
| Monaco-free async/anchor primitives                                         | `src/studio/async.ts`                                                            |
| Deterministic Performer (recording-clock scheduling, receipts, fail-closed) | `src/studio/performer.ts`                                                        |
| End-to-end render orchestration (pin → record → perform → QA → bundle)      | `src/studio/runStudioRender.ts`                                                  |
| Artifact QA gates (decode, monotonicity, tracks, checkpoints)               | `src/studio/qa.ts`                                                               |
| Repeatability comparison (normalized, tolerance-based)                      | `src/studio/compare.ts`                                                          |
| Receipts / render report / build manifest types                             | `src/studio/report.ts`                                                           |
| Durable UI target registry (`data-studio-target`)                           | `src/studio/targets.ts`                                                          |
| M0 plan fixture                                                             | `src/studio/plans/m0GoHello.ts`                                                  |
| Narration asset + regeneration script                                       | `public/studio-fixtures/m0-go-hello.m4a`, `scripts/generate-studio-narration.sh` |
| Render console UI + `/studio` route                                         | `src/studio/StudioController.tsx`, `src/studio/StudioRoute.tsx`                  |

Key seams used (not bypassed): workspace store actions (`loadProject`,
`setActiveFilePath`), live Monaco `executeEdits` (flows through the workspace bridge
and exact-edit capture), the shared Go console append path
(`src/runtime/goPlayground/consoleStore.ts`, also used by the runner panel),
synthetic `pointermove` events into the recorder's own mouse-tracking capture, and
`START_RECORDING` with an external audio blob (the recording auto-finalizes when the
narration ends, which is why every plan action must finish before
`narration.expectedDurationMs`).

## M0 exit criteria → current state

- **Two consecutive renders pass semantic comparison** — the repeatability panel is
  the harness (action sequence, final workspace hash, captions, audio hash, console
  lines, timing within 300 ms/500 ms tolerances). Run it twice and keep the verdict.
- **Audio starts reliably** — the recorder waits for `AUDIO_PLAYBACK_READY`, pins the
  measured duration against the plan (±1.5 s), and surfaces the autoplay-policy
  failure as an actionable error instead of a silent hang.
- **Failures produce actionable receipts and clean up** — every action gets a receipt
  (planned/actual clock times, error); a failure aborts the shared signal, stops the
  recording immediately, and produces a report-only result.

## Known M0 limitations (intentional; M1+ work)

- No YAML `LessonScript`, narration markers, TTS provider adapter, or forced
  alignment — captions are hand-timed in the plan fixture, and regenerating the
  narration requires updating the plan's pinned duration/cue times (see the script
  header).
- Fixture renders don't visually press Run (and signed-out sessions show the
  sign-in button), so the cursor targets the runner dock, not the button.
- The upload-to-draft flow (M3) is not wired; bundles are download-only.
- One plan, one execution kind (`go-playground`).
