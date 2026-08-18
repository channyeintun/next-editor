# Studio Runbook — Deterministic Lesson Renders (M0–M4)

Implements **M0–M4** of [agent-lesson-production.md](./agent-lesson-production.md)
§12: a deterministic in-app Performer renders checked-in plans, records through
the real recorder, and gates the artifact with mechanical QA plus a two-render
repeatability comparison. M1 adds the authored `LessonScript`
path: YAML scripts with `[[mark:…]]` narration anchors compile **in the render
page** into the same plan format the M0 fixture hard-codes. M2 adds the slide and
whiteboard surfaces, a declared-idempotent silent retry for transient Go-run
failures, and the unattended render command below. M3 adds draft handoff; M4
adds the editorial/critic loop and in-page pocket-tts synthesis.

## Unattended renders (M2)

```text
bun run dev                       # in one terminal
bun scripts/studio-render.ts rust-borrow             # two renders + comparison (CI only)
bun scripts/studio-render.ts <slug> --runtime=live --runs=2 --out=studio-out
```

Drives `/studio` in headless system Chrome (playwright-core, no browser
download), saves per-run reports/manifests, the repeatability verdict, the
downloaded lesson bundle, and diagnostic screenshots under `studio-out/`, and
exits non-zero unless every render passed and the comparison is clean. Verification of lessons happens in a real Chrome via the /studio flow; this
harness remains for CI and repeatability audits.

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
   per-scene sources — the critic flags unsourced scenes). The file
   auto-registers by filename; never edit src/studio/plans/index.ts.
2. bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml
   → optional preflight: validates schema/markers/dialogs, runs the advisory
   critic, and writes <slug>.critique.json next to the YAML. It emits NO
   compiled plan — compilation happens in the render page. Fix every error;
   weigh critic notes (the critic proposes; it cannot block or approve).
3. Verify in a real Chrome: bun run dev, open /studio?plan=<slug>, press
   Start render, watch the performance, confirm "Checks (N/N ok)". The
   headless bun scripts/studio-render.ts is a CI/repeatability audit, not the
   authoring verify step.
4. Watch the rendered lesson end-to-end (/studio playback).
5. Create draft… → review in the lessons UI → publish (human, separate).
```

> **Historical (M0/M1).** The original M0 flow hard-coded a compiled
> `StudioPlan` and registered it by editing `src/studio/plans/index.ts`, and an
> early Director build emitted `src/studio/plans/scripts/<slug>.json`. Neither
> applies now: checked-in `src/studio/scripts/*.yaml` auto-register via
> `import.meta.glob`, and the script is compiled **in the render page**
> (`src/studio/inPageDirector.ts`) at render time. There is no emitted plan JSON
> and no registry edit; the Director CLI only writes the `.critique.json`
> sidecar.

### Pilots (historical — all passed 2× unattended renders, repeatability PASS)

The Go pilot scripts now live as test fixtures under
`src/studio/script/__fixtures__/`; the shipped lesson is `rust-borrow`.

### Metrics to record per build (§11)

Track in the pilot log (spreadsheet or issue): authoring/critic tokens, TTS
seconds synthesized (cache hits are free), render wall time (`wallDurationMs`
in the report), retries, artifact bytes, human review minutes, script
revisions, and brief→draft lead time. Report p50/p95 across pilots before
scaling. The remaining M4 exit criterion is human: watch all three pilots,
rate them, log correction time, and decide scale / revise / stop.

## Authoring a lesson

```text
src/studio/scripts/<slug>.yaml        # LessonScript: scenes, narration + [[mark:x]], actions
bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml
```

The Director CLI validates the script (`src/studio/script/schema.ts`), checks
marker resolution and dialog segmentation, runs the advisory critic, and writes
`<slug>.critique.json` next to the YAML. It emits **no** compiled plan — the
in-page Director (`src/studio/inPageDirector.ts`) compiles the script at render
time. Checked-in `src/studio/scripts/*.yaml` **auto-register by filename**
(`import.meta.glob` in `src/studio/plans/index.ts`) — no code edit, no registry
entry; render at `/studio?plan=<slug>`. Running the Director with no arguments
validates every script.

**Agents author lessons too**: the complete authoring contract is
[lesson-script-authoring.md](./lesson-script-authoring.md), and Claude Code
sessions in this repo have the `lesson-script` skill
(`.claude/skills/lesson-script/`) that wraps it — ask for a lesson on a
concept and the agent writes, compiles, and renders the script.

Narration is produced **in the page** at render time by the in-page Director
(`src/studio/inPageDirector.ts`): the narration splits at every `[[mark:…]]`
into dialogs; each dialog synthesizes with **pocket-tts (Kyutai) exported to
ONNX and run over onnxruntime-web** — KevinAHM's export, pinned to an
immutable revision, ported as a typed engine in `src/studio/tts/pocket/` with
one deliberate change: the flow-matching noise is **seeded once from the build
seed and reused for every dialog**. That keeps the voice's pitch and timbre
stable between independently generated spans while preserving byte-identical
rebuilds (upstream uses `Math.random()`). Synthesis goes through a per-dialog
content-addressed cache in the browser's Cache storage; the scheduler then
places dialogs **around the actions** (narration waits while typing finishes —
marker times are exact by construction) and stitches the segments into the
single WAV the recorder consumes. Editing one sentence re-synthesizes only
that dialog. The ~125MB bundle (int8 ONNX + voices) downloads once into the
browser cache; the repo carries no narration audio (the archived M0 fixture
aside). Voices come precomputed in the bundle
(`alba` default; azelma, cosette, eponine, fantine, javert, jean, marius —
a new voice is a one-line profile in `src/studio/tts/profiles.ts`).

Anchors are narration-relative only (`{mark, offsetMs}`, `{scene: start}`,
`{afterAction}`); absolute times are forbidden in scripts. Unknown marks fail
in the CLI; overlaps and out-of-bounds times fail in-page at compile, before
any recording starts. The scheduler warns when actions force more than ~2.5s
of inserted silence — add narration there or shorten the action. The lexicon
applies to speech text only; word timings inside a dialog remain estimated
(bounded by that dialog's few seconds), while cue-level caption timing is
exact.

## Running a render

`/studio` ships on the production website — no tooling needed: pick a lesson
from the dropdown (or **Import…** a LessonScript YAML, validated and
critiqued in the page), press **Start render**, watch, download the bundle or
**Create draft…** (sign-in required). Locally the same route runs under the
dev server:

```text
bun run dev
open http://localhost:5173/studio
```

- Click **Start render** (a click satisfies the browser's audio autoplay policy), or
  open `/studio?autostart=1` in a browser/profile that allows audio autoplay
  (Chrome: `--autoplay-policy=no-user-gesture-required` for unattended runs).
- Click **Render again** after the first run finishes: the panel then shows the
  normalized **Repeatability** verdict between the two runs (also compared across a
  reload within one browsing session via `sessionStorage`).
- **Download bundle** saves `lesson-<slug>.ne`, the narration audio,
  `build-manifest.json`, and `render-report.json`. A failed render only offers the
  report — failed builds never yield a lesson bundle.
- Automation can read `window.__NEXT_EDITOR_STUDIO__` (runs, reports, manifests,
  comparison, running flag) instead of scraping the DOM.
- Use a normal-width window (≥1280 px): the render console overlays the top-right
  and must not cover the file sidebar or runner dock the cursor tweens toward.

Query params: `plan` (registered plan or `src/studio/scripts` slug), `runtime`
(`fixture` | `live`), `autostart=1`.

### Runtime modes

- `fixture`: Go, Kotlin, and Rust replay the script's pinned result through the
  same console formatting/store path as a live run, after a fixed planned
  latency. It works signed-out and offline; the manifest records
  `runtimeMode: "fixture"`.
- `live`: Go/Kotlin/Rust call their authenticated Playground proxy. JavaScript,
  TypeScript, and console-only Python run their pinned commands in the
  WebContainer and therefore require `live`; JS/TS additionally wait for the
  declared preview server and acknowledged iframe bridge.

## What exists (map)

| Piece                                                                       | Where                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Compiled-plan schema (Zod, versioned, timing/overlap/caption validation)    | `src/studio/plan.ts`                                            |
| Seeded cadence + easing (typing chunks materialized into the plan)          | `src/studio/cadence.ts`                                         |
| StudioDriver: open/type/cursor/run/wait/expect through real app seams       | `src/studio/driver.ts`                                          |
| Monaco-free async/anchor primitives                                         | `src/studio/async.ts`                                           |
| Deterministic Performer (recording-clock scheduling, receipts, fail-closed) | `src/studio/performer.ts`                                       |
| End-to-end render orchestration (pin → record → perform → QA → bundle)      | `src/studio/runStudioRender.ts`                                 |
| Artifact QA gates (decode, monotonicity, tracks, checkpoints)               | `src/studio/qa.ts`                                              |
| Repeatability comparison (normalized, tolerance-based)                      | `src/studio/compare.ts`                                         |
| Receipts / render report / build manifest types                             | `src/studio/report.ts`                                          |
| Durable UI target registry (`data-studio-target`)                           | `src/studio/targets.ts`                                         |
| In-page narration synthesis (pocket-tts, the only TTS)                      | `src/studio/inPageDirector.ts`, `src/studio/tts/`               |
| Render console UI + `/studio` route                                         | `src/studio/StudioController.tsx`, `src/studio/StudioRoute.tsx` |

Key seams used (not bypassed): workspace store actions (`loadProject`,
`setActiveFilePath`), live Monaco `executeEdits` (flows through the workspace bridge
and exact-edit capture), the shared playground console append path
(`src/runtime/playgroundConsoleStore.ts`, also used by every runner panel),
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

## Historical M0 limitations (superseded)

The first hard-coded M0 fixture had no LessonScript/markers/TTS path, offered
downloads only, and supported one `go-playground` plan. M1–M4 superseded those
constraints: YAML scripts compile in-page, pocket-tts produces aligned
narration/captions, passing runs can enter the draft flow, and the runtime
matrix now covers all six documented lesson languages. The fixture-mode Run
gesture remains console-driven rather than a literal button click; receipts and
artifact checkpoints are authoritative for that path.
