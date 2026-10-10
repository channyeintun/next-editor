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
exits non-zero unless every render passed and the comparison is clean. Each
render may take 420 s plus twice the script's estimated narration length (the
fixed 420 s alone for a slug with no checked-in script). The harness opens
`/studio?…&autostart=1` and checks that `navigator.webdriver` is true, since the
studio honours `autostart` only in an automation-controlled browser.
Verification of lessons happens in a real Chrome via the /studio flow; this
harness remains for CI and repeatability audits.

## Draft publishing (M3)

A passing render's **Create draft…** button opens the standard authenticated
upload flow (`UploadLessonModal`): media to the lesson's R2 prefix, a D1
**draft** row via `/api/lessons`, captions as sibling `.vtt` tracks. The
description becomes the lesson's public meta and JSON-LD text once published, so
it pre-fills only "<title> — a narrated coding lesson. The narration is
AI-generated." The build provenance (plan slug, plan hash, runtime mode,
narration provider, and the cloned, reference, or AthanLab voice) and the review
reminder are in the **Create draft…** button's tooltip. `build-manifest.json`
holds the full plan hash, seed, runtime contract, and artifact hashes; the
narration provider and voice name appear only in the tooltip. Publishing
remains a separate owner action in the lessons UI — the studio has no publish
path. Requires `bun run dev:worker` and a signed-in session.

Mistimed builds are rejected mechanically: a script's
`{ type: timing.p95Ms, max: N }` check compiles into the plan's timing gate,
and a render whose p95 |actual − planned| action start exceeds it fails QA
(no bundle, no draft), alongside the M0 gates for corrupted or semantically
wrong artifacts.

## Authoring workflow and editorial loop (M4)

The editorial contract lives in [studio-persona.md](./studio-persona.md)
(versioned; the advisory critic in `src/studio/script/critic.ts` cites it as
`PERSONA_GUIDE_VERSION` and versions its own output separately as
`CRITIC_VERSION`). The production loop:

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
in the report — measured from the **Start render** click since 2026-10-02, so
it includes narration synthesis and compilation; earlier pilot numbers cover
only the performance), retries, artifact bytes, human review minutes, script
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
validates every script. It keeps going past a bad script: each failure prints
as `✗ <file>: <message>`, the run ends with `N of M script(s) valid` (plus
`N script(s) failed`), and it exits 1 if any script failed. A `voxcpm2-modal`
voice profile gets a note that `/studio` renders it only for a signed-in
account with the Burmese VoxCPM2 feature enabled. AthanLab voices are chosen
in `/studio` at render time and are never pinned in a script.

Script objects are strict — an unknown or misspelled key is an error — and
`build.seed` must be 0–2147483647. An anchor names exactly one of `scene`,
`mark`, or `afterAction`, with `offsetMs` only on the first two. A
`whiteboard.apply` that neither opens/closes, changes maximize, clears, nor
upserts is rejected. All of these fail when the script is parsed, in the CLI
and in the page. The CLI does not compile or schedule: overlaps and an action
that starts after the narration ends surface in `/studio` only after synthesis,
or offline for checked-in scripts with
`npx vp test run src/studio/plans/index.test.ts`, which compiles every script
against estimated dialog lengths.

**Agents author lessons too**: the complete authoring contract is
[lesson-script-authoring.md](./lesson-script-authoring.md), and Claude Code
sessions in this repo have the `lesson-script` skill
(`.claude/skills/lesson-script/`) that wraps it — ask for a lesson on a
concept and the agent writes, compiles, and renders the script.

Narration is produced **in the page** at render time by the in-page Director
(`src/studio/inPageDirector.ts`): the narration splits at every `[[mark:…]]`
into dialogs; each English dialog synthesizes with **pocket-tts (Kyutai)
exported to ONNX and run over onnxruntime-web** — KevinAHM's export, pinned to an
immutable revision, ported as a typed engine in `src/studio/tts/pocket/` with
one deliberate change: the flow-matching noise is **seeded once from the build
seed and reused for every dialog**. That keeps the voice's pitch and timbre
stable between independently generated spans while preserving byte-identical
rebuilds (upstream uses `Math.random()`). Synthesis goes through a per-dialog
content-addressed cache in the browser's Cache storage; the scheduler then
places dialogs **around the actions** (narration waits while typing finishes —
marker times are exact by construction) and stitches the segments into the
single WAV the recorder consumes. Before the stitch, every dialog is leveled
to one loudness (`src/studio/tts/loudness.ts`) so the voice keeps one volume:
each dialog gets a single static gain toward −18 LUFS (BS.1770), and when a
dialog cannot get there (its peaks would pass −1 dBFS, or it needs more than
the 12 dB gain limit), the whole narration comes down together (but no lower
than −24 LUFS) instead of that dialog alone. The cache
keeps the raw takes, so leveling never costs a new synthesis. Editing one
sentence re-synthesizes only that dialog. The ~125MB bundle (int8 ONNX +
voices) downloads once into the browser cache; the repo carries no narration
audio (the archived M0 fixture aside). Voices come precomputed in the bundle
(`alba` default; azelma, cosette, eponine, fantine, javert, jean, marius —
a new voice is a one-line profile in `src/studio/tts/profiles.ts`). Pocket's
text prep splits a dialog into sentences only at `.`, `!`, or `?` (plus closing
quotes or brackets) followed by whitespace, so `fmt.Println` and `3.14` stay
whole; a sentence over the token budget is cut at word boundaries, and token
slicing is left for a single over-long word. `POCKET_TEXT_PREP_VERSION` (2) and
`POCKET_ENGINE_VERSION` (2: a sentence that runs to the engine's frame cap keeps
all of its audio) are part of Pocket dialogs' cache keys only. Burmese (`my-MM`) narration goes
through the Worker instead, with one of two providers chosen in the render
console:

- **AthanLab** works for any signed-in user with their own AthanLab API key.
  The key is pasted once in the AthanLab panel, checked against AthanLab,
  stored AES-256-GCM-encrypted in D1, and never returned to the browser (the
  panel shows only its last four characters). Each uncached dialog is one
  AthanLab job (`POST /api/studio/tts/athanlab`), charged to the user's
  AthanLab balance; AthanLab keeps each job's text and audio for 30 days. The
  chosen AthanLab voice is pinned for the whole render. Before sending,
  `src/studio/tts/athanlab/textPrep.ts` (`ATHANLAB_TEXT_PREP_VERSION`, 1)
  removes quotation marks and brackets, turns `…` into a `၊` pause, and adds
  `။` to a dialog that has no final mark — so place `[[mark:…]]` at sentence
  ends for natural intonation. Each take is resampled to 48 kHz mono in the
  page. AthanLab is not seedable, so its dialogs use a fixed seed of 0 in
  their cache key (changing `build.seed` does not pay for every take again),
  and a repeat render replays each take from the dialog cache or from
  AthanLab's 24 h idempotent job. A dialog AthanLab is still generating when
  the Worker's time runs out keeps running; the page asks again and gets the
  same job, at no extra charge. Errors start with `AthanLab:`; a rejected
  (expired or revoked) key is never sent again until the user connects a new
  one.
- **VoxCPM2 on Modal** ([modal-voxcpm2-burmese.md](./modal-voxcpm2-burmese.md))
  is listed only for accounts with the private `studio.burmese-voxcpm2` D1
  flag; a failure there carries the service's reason
  (`Burmese narration service failed with HTTP 400: …`).

Every take is validated (PCM16 mono, the provider's sample rate, non-empty, not
silent) before it is cached, and a cache hit is re-validated: a bad entry is
evicted with a warning and synthesized again. Synthesis errors name the dialog
as `dialog N/M "<id>" ("first words…")`. When a Pocket sentence runs to the
500-frame (~40 s) cap without the model ending it, the Director warns that the
dialog "ran to the speech engine's length limit without the model ending the
sentence" — reword or split that sentence. The take is still cached, and the
warning repeats on every cache hit until the text changes. Only a take that
cannot reach even −24 LUFS (too peaky, or too quiet for the 12 dB gain limit)
or is too loud for that limit ends off the shared level; when it ends more
than 1 dB off, a warning says it "stays N dB quieter (or louder) than the rest
of the narration".

Anchors are narration-relative only (`{mark, offsetMs}`, `{scene: start,
offsetMs}`, `{afterAction}`); absolute times are forbidden in scripts. Unknown
marks fail in the CLI; overlaps and out-of-bounds times fail in-page at
compile, after synthesis and before any recording starts. The scheduler warns
when actions force more than ~2.5s of inserted silence — add narration there or
shorten the action. The pronunciation lexicon applies to the speech text of
English narration only; Burmese narration is sent as written (apart from
AthanLab's punctuation clean-up above). Word timings inside a dialog remain
estimated (bounded by that dialog's few seconds; Myanmar script is weighed by
syllables), while cue-level caption timing is exact.
Chapters start at their scene's first spoken word, except a chapter on the
first scene, which starts at 0:00.

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

- Click **Start render** (a click satisfies the browser's audio autoplay policy).
  `/studio?autostart=1` starts a render without the click only when
  `navigator.webdriver` is true — the headless `scripts/studio-render.ts`
  harness. In a normal browser the plan is preselected and waits for the click.
- Click **Render again** after the first run finishes: the panel then shows the
  normalized **Repeatability** verdict between the two runs (also compared across a
  reload within one browsing session via `sessionStorage`).
- **Download bundle** saves `lesson-<slug>.ne`, the narration audio,
  `build-manifest.json`, and `render-report.json`. A failed render only offers the
  report — failed builds never yield a lesson bundle. In the manifest
  (`manifestVersion` 2), `narrationMimeType` and `narrationAudioHash` describe the
  PCM16 WAV timing master, while `artifact.audioMimeType` is the type of the audio
  file the bundle ships (Ogg/Opus).
- Automation can read `window.__NEXT_EDITOR_STUDIO__` (runs, reports, manifests,
  comparison, running flag) instead of scraping the DOM.
- Use a normal-width window (≥1280 px) so the layout matches the recorded lesson.
  The render console overlays the top-right outside the recorded area; it may
  sit over the Run button, which the pointer's click still reaches (its hit-test
  only looks inside the recorded app).
- `/studio` never saves its workspace (Ctrl-S and the other saves do nothing
  there), so a render never overwrites the main project in
  `next-editor-workspace`.

Query params: `plan` (registered plan or `src/studio/scripts` slug), `runtime`
(`fixture` | `live`), `autostart=1` (honoured only in an automation-controlled
browser, as above).

### Runtime modes

- `fixture`: Playground kinds (Go, Kotlin, Rust, Zig, Haskell, Kite, asm)
  replay the script's pinned result through the same console formatting/store
  path as a live run, after a fixed planned latency. It works signed-out and
  offline; the manifest records `runtimeMode: "fixture"`.
- `live`: Go/Kotlin/Rust/Zig/Haskell call their Playground proxy, which needs
  no sign-in, while Kite and asm run their in-page compiler/assembler. JavaScript,
  TypeScript, and console-only Python run their pinned commands in the
  WebContainer and therefore require `live`; JS/TS additionally wait for the
  declared preview server and acknowledged iframe bridge.

## What exists (map)

| Piece                                                                       | Where                                                                 |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Compiled-plan schema (Zod, versioned, timing/overlap/caption validation)    | `src/studio/plan.ts`                                                  |
| Seeded cadence + easing (typing chunks materialized into the plan)          | `src/studio/cadence.ts`                                               |
| StudioDriver: open/type/cursor/run/wait/expect through real app seams       | `src/studio/driver.ts`                                                |
| Monaco-free async/anchor primitives                                         | `src/studio/async.ts`                                                 |
| Deterministic Performer (recording-clock scheduling, receipts, fail-closed) | `src/studio/performer.ts`                                             |
| End-to-end render orchestration (pin → record → perform → QA → bundle)      | `src/studio/runStudioRender.ts`                                       |
| Artifact QA gates (decode, monotonicity, tracks, checkpoints)               | `src/studio/qa.ts`                                                    |
| Repeatability comparison (normalized, tolerance-based)                      | `src/studio/compare.ts`                                               |
| Receipts / render report / build manifest types                             | `src/studio/report.ts`                                                |
| Durable UI target registry (`data-studio-target`)                           | `src/studio/targets.ts`                                               |
| Narration synthesis (pocket-tts in page; AthanLab or VoxCPM2 for Burmese)   | `src/studio/inPageDirector.ts`, `src/studio/tts/`                     |
| AthanLab key panel (connect, voice, balance) and its Worker routes          | `src/studio/AthanLabPanel.tsx`, `infra/worker/routes/athanlab.ts`     |
| Narrator voice library (upload, record, preview, delete, choose)            | `src/studio/NarratorVoicePanel.tsx`, `src/studio/tts/customVoices.ts` |
| Render console UI + `/studio` route                                         | `src/studio/StudioController.tsx`, `src/studio/StudioRoute.tsx`       |

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
matrix now covers every lesson language in the authoring contract. The
fixture-mode Run gesture remains console-driven rather than a literal button
click; receipts and artifact checkpoints are authoritative for that path.
