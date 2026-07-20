# Studio Runbook — Deterministic Lesson Renders (M0–M4)

Implements **M0–M2** of [agent-lesson-production.md](./agent-lesson-production.md)
§12: a deterministic in-app Performer renders checked-in plans against pre-generated
narration, records through the real recorder, and gates the artifact with mechanical
QA plus a two-render repeatability comparison. M1 adds the authored `LessonScript`
path: YAML scripts with `[[mark:…]]` narration anchors compile through the Director
into the same plan format the M0 fixture hard-codes. M2 adds the slide and
whiteboard surfaces, a declared-idempotent silent retry for transient Go-run
failures, and the unattended render command below.

## Unattended renders (M2)

```text
bun run dev                       # in one terminal
bun scripts/studio-render.ts go-cube-tour            # two renders + comparison
bun scripts/studio-render.ts <slug> --runtime=live --runs=2 --out=studio-out
```

Drives `/studio` in headless system Chrome (playwright-core, no browser
download), saves per-run reports/manifests, the repeatability verdict, the
downloaded lesson bundle, and diagnostic screenshots under `studio-out/`, and
exits non-zero unless every render passed and the comparison is clean. The
`go-cube-tour` pilot exercises six surfaces (editor, cursor, workspace,
runtime, slides, whiteboard) and simulates a transient Playground failure, so
a passing run also demonstrates the retry path (`run` receipt: `attempts: 2`).

## Draft publishing (M3)

A passing render's **Create draft…** button opens the standard authenticated
upload flow (`UploadLessonModal`): media to the lesson's R2 prefix, a D1
**draft** row via `/api/lessons`, captions as sibling `.vtt` tracks. The
description pre-fills the AI-production disclosure plus build provenance (plan
slug, plan hash, runtime mode) for the reviewer. Publishing remains a separate
owner action in the lessons UI — the studio has no publish path. Requires
`bun run dev:worker` and a signed-in session.

Mistimed builds are rejected mechanically: a script's
`{ type: timing.p95Ms, max: N }` check compiles into the plan's timing gate,
and a render whose p95 |actual − planned| action start exceeds it fails QA
(no bundle, no draft), alongside the M0 gates for corrupted or semantically
wrong artifacts.

## Authoring workflow and editorial loop (M4)

The editorial contract lives in [studio-persona.md](./studio-persona.md)
(versioned; the advisory critic in `src/studio/script/critic.ts` shares its
version). The production loop:

```text
1. Pick one concept; write src/studio/scripts/<slug>.yaml (scenes, [[mark]]s,
   per-scene sources — the critic flags unsourced scenes).
2. bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml
   → compiled plan + critique JSON; fix compile errors, weigh critic notes
   (the critic proposes; it cannot block or approve).
3. Register the slug in src/studio/plans/index.ts.
4. bun scripts/studio-render.ts <slug>       # two renders + repeatability
5. Watch the rendered lesson end-to-end (/studio playback or the bundle).
6. Create draft… → review in the lessons UI → publish (human, separate).
```

### Pilots (all passed 2× unattended renders, repeatability PASS)

| Pilot          | Role                                                  | Surfaces                           |
| -------------- | ----------------------------------------------------- | ---------------------------------- |
| `go-cube`      | minimal regression (mirrors the M0 hard-coded lesson) | editor, cursor, workspace, runtime |
| `go-cube-tour` | representative multi-surface                          | + slides, whiteboard, retry path   |
| `go-swap`      | net-new short explainer                               | editor, cursor, workspace, runtime |

### Metrics to record per build (§11)

Track in the pilot log (spreadsheet or issue): authoring/critic tokens, TTS
seconds synthesized (cache hits are free), render wall time (`wallDurationMs`
in the report), retries, artifact bytes, human review minutes, script
revisions, and brief→draft lead time. Report p50/p95 across pilots before
scaling. The remaining M4 exit criterion is human: watch all three pilots,
rate them, log correction time, and decide scale / revise / stop.

## Authoring a lesson (M1 path)

```text
src/studio/scripts/<slug>.yaml        # LessonScript: scenes, narration + [[mark:x]], actions
bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml
```

The Director validates the script (`src/studio/script/schema.ts`), strips markers
into a token map, applies the versioned pronunciation lexicon to the **speech**
text only, synthesizes narration once into the content-addressed cache
(`public/studio-fixtures/cache/<requestHash>.{m4a,json}` — cache hits skip
synthesis and reproduce identical media hashes), estimates token alignment,
derives captions and the attention-cursor choreography, and writes the compiled
plan to `src/studio/plans/compiled/<slug>.json`. Register new slugs in
`src/studio/plans/index.ts`, then render at `/studio?plan=<slug>`.

Anchors are narration-relative only (`{mark, offsetMs}`, `{scene: start}`,
`{afterAction}`); absolute times are forbidden in scripts. Impossible overlaps,
unknown marks, and actions past the narration end fail at compile time with the
offset to fix — never mid-render. Narration synthesis runs on macOS
(`say`/`afconvert`); commit the cache so other machines build from it.

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
