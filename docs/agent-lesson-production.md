# Agent Lesson Production — Deep Research

**Goal:** a harness that lets AI agents produce complete Next Editor lessons — script, narration, code performance, whiteboard, slides, preview, cursor — with no human in the recording chair. The end state is a content channel ("Fireship for Next Editor") where agents handle production and humans only steer taste and greenlight releases.

**Pipeline sketch this responds to:**

```
transcript (captions) → direct (record) → harness (sidebar, editor, whiteboard,
slides, preview, dock) → human-like actions (cursor, clicks, typing) → lessons
```

**TL;DR of the research:**

1. Next Editor is structurally better positioned for this than any pixel-video pipeline, because a lesson here is a **semantic event stream**, not an MP4. Agents can author it as a reviewable artifact, a deterministic engine can render it, and QA can be mechanical.
2. Roughly **80% of the substrate already exists** in the codebase: every track the harness needs (frames, cursor with target remapping, word-timed captions, external audio, whiteboard, slides, rrweb preview, workspace/runtime snapshots, chat) is already first-class in the `Recording` format, and playback already drives a live Monaco — i.e. the player is already an automation engine.
3. The single most important design decision: **no LLM in the render loop.** Agents write a `LessonScript` (a compact, diffable YAML/JSON artifact); a deterministic Performer executes it through the real recorder. This is the split that made Remotion-with-agents, VHS, and Manim work, applied to an interactive IDE.
4. Voice is a solved dependency: TTS with timing (ElevenLabs character-level, Cartesia word-level, Azure word-boundary) maps directly onto the existing `CaptionWord` type, and `audioSource: "external"` + sibling audio files means TTS output plugs into the format with zero format changes.
5. The moat versus the AI-video wave (NotebookLM, Demosmith, Arcade/Supademo/Storylane): those emit opaque video. Next Editor lessons stay **interactive, seekable, editable, verifiable, tiny, and re-renderable per scene**. The risk is not feasibility; it is editorial quality (slop). The plan below treats taste as a first-class engineering problem.

---

## 1. Why Next Editor can win this

A screen-recorded lesson is a rendering of decisions that were lost at capture time. Next Editor's `.ne` keeps the decisions:

| Property             | Pixel video (YouTube, Demosmith, NotebookLM) | `.ne` lesson                                                                                          |
| -------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Source of truth      | Final MP4                                    | Event log (frames, cursor, captions, preview…)                                                        |
| Agent authoring unit | Prompt → opaque render                       | `LessonScript` → deterministic render                                                                 |
| Fixing a mistake     | Reshoot / re-render whole video              | Patch script, re-render one scene                                                                     |
| QA                   | Human watches it                             | Decode + assert: code compiles at checkpoints, preview text matches, caption/action drift < threshold |
| Learner interaction  | Pause and squint                             | Pause, edit the actual code, run it                                                                   |
| Size                 | 100+ MB                                      | KBs–MBs                                                                                               |
| Localization         | Re-record or dub                             | Re-TTS the same script; captions regenerate exactly                                                   |
| Diff/review          | Impossible                                   | `git diff` on the script                                                                              |

That last column is exactly why "agents write code, a framework renders video" worked for [Remotion](https://www.remotion.dev/docs/ai/generate) (agent skills shipped Jan 2026) and why [VHS](https://github.com/charmbracelet/vhs) tapes became the standard for scripted terminal demos. The lesson harness is **VHS for a whole IDE, plus narration** — and unlike either of those, the output stays interactive for the learner, which is Scrimba's core insight ("the player is the editor").

Nobody occupies this square yet. Scrimba records events but still needs a human performer. Demo-automation tools (Arcade, Supademo, Storylane, Demosmith) have agents + synthetic cursors + AI voiceover, but emit product-demo MP4s/click-throughs, not runnable coding lessons. NotebookLM makes narrated slide videos at consumer scale, but nothing executes. Coursera's Course Builder generates course _outlines and text_, not performances.

## 2. What already exists in the codebase

The audit surprised me. Mapping the sketch's stages onto the repo:

### 2.1 The recording format already has every track the harness needs

From `src/core/src/types.ts` (Recording v4, SCR3 container):

| Sketch stage          | Existing track / type                                                            | Notes for synthesis                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transcript (captions) | `captions: CaptionTrack[]` with `CaptionCue.words?: CaptionWord[]`               | **Word-level timing already modeled.** TTS alignment output drops straight in. Multi-language tracks + sibling `.vtt`/`.srt` supported.                                                                                                                                            |
| voice                 | `audioSource: "external"`, `audioFile`/`audioUrl`, `audioStartOffsetMs`          | TTS audio ships as a sibling file next to the `.ne`; `src/hooks/useUrlLoader.ts` already resolves it. No format change needed.                                                                                                                                                     |
| code editor           | `frames: DeltaFrame[]` (keyframe+delta)                                          | v4 encodes _ordinary local Monaco edits_ as exact edit batches with integrity hashes. A performer that types through the Monaco API gets the cheapest, most faithful encoding for free.                                                                                            |
| mouse cursor          | `cursorEvents: CursorRecordingEvent[]`                                           | Not raw pixels: `CursorTargetSnapshot` anchors samples to UI regions and playback **remaps onto the current layout** (`cursorCoordinates.ts`, `cursorReplay.ts`, tween support). A synthetic cursor authored as _targets_ is more robust than anything a screen recorder captures. |
| whiteboard            | `whiteboardEvents: WhiteboardEvent[]` (element upserts/removes + view)           | Agents author Excalidraw element JSON directly; mermaid→excalidraw converters exist as libraries if we want diagram-as-text authoring.                                                                                                                                             |
| slides                | `slides: Slide[]`, `slideEvents` (+ Google Slides integration, R2-hosted images) | The Go Tour lessons were already deck-driven.                                                                                                                                                                                                                                      |
| preview               | `previewInitialDocuments` + `previewPatchBatches` (rrweb), API-client events     | The one track that requires actually running the code.                                                                                                                                                                                                                             |
| file sidebar / dock   | `workspaceEvents` / `runtimeEvents` (timestamped snapshots)                      | Driven from `workspaceStore` and the runtime provider.                                                                                                                                                                                                                             |
| AI chat (bonus)       | `chatEvents: ChatRecordingEvent[]` (dmp deltas + checkpoints)                    | A lesson genre nobody else can make: replayable "watch the agent work" lessons, recorded semantically.                                                                                                                                                                             |

### 2.2 Playback is already an automation engine

Playback reconstructs frames and **applies diffs to a live Monaco** (`src/core/src/utils/editorDiff.ts`: `applyContentDiff` / `applyPositionDiff` / `applySelectionDiff`), restores workspace/runtime/whiteboard/slide state, and drives an rrweb `Replayer` for the preview. A Performer is conceptually "playback of a script that doesn't exist yet" — most of the muscles it needs are the ones playback already exercises daily.

### 2.3 An in-app agent already acts on the harness

`src/agent/` has an OpenRouter-SDK agent loop with tools that read and mutate the workspace and observe the runtime: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `ls`, `capturePreview`, `inspectPreview`, `runtimeDiagnostics`. That is the "hands" half of a performer, and — critically for QA — the **verification half of the pipeline**: an agent can already execute a beat's workspace and look at the preview to confirm the lesson's claims are true.

### 2.4 Distribution exists

`tube/` (`@next-editor/tube`) is the catalog app: `data/lessons.json` entries pointing at hosted `.ne` + thumbnail + author + tags. Publishing an agent-made lesson is "upload to R2, append a JSON entry."

### 2.5 What does _not_ exist (the actual project)

1. A **LessonScript** format (the agent-authorable artifact).
2. A **Director** (compiler: script + TTS → timed action plan + captions + audio).
3. A **Performer** (deterministic executor that plays the plan through the real surfaces while `START_RECORDING` capture runs).
4. A **cursor/typing humanizer** (synthesize `cursorEvents` and keystroke cadence).
5. A **QA harness** (decode + assert + judge) and a **render CLI** (headless farm entry point).
6. The **authoring agents** (curriculum → script → critique) and the persona/style guide.

Everything in that list composes with existing code rather than replacing it.

## 3. Prior art survey

**[Scrimba](https://survivejs.com/blog/scrimba-interview/)** — the format cousin. Records editor events instead of pixels; pausing drops you into the live editor ([overview](https://scrimbaguide.tech/docs/intro/), [reviews](https://www.coursefacts.com/guides/scrimba-review-2026)). Their 2025–26 AI work went into a _tutor that watches the learner_, not an _author that performs lessons_. The authoring side is still human. That's the open square.

**[VHS by charmbracelet](https://github.com/charmbracelet/vhs)** — recordings as code for terminals. A `.tape` DSL (`Type "npm i"`, `Sleep 2s`, `Enter`) renders deterministic GIFs/videos, used for docs and even golden-file integration tests ([background](https://blog.ouseful.info/2022/11/09/creating-terminal-based-screenshot-movies-with-vhs/)). Proves the authoring ergonomics: humans and LLMs both write tapes happily because the DSL is tiny and declarative. The LessonScript should feel like a VHS tape with narration and structure.

**[Remotion + agent skills](https://www.remotion.dev/docs/ai/coding-agents)** — the creative/render split at production quality. Remotion ships [LLM system prompts](https://www.remotion.dev/docs/ai/system-prompt) and [Agent Skills](https://www.remotion.dev/docs/ai/skills) so coding agents write compositions and the renderer stays deterministic; people already build [Fireship-style videos this way](http://blog.brightcoding.dev/2026/02/21/remotion-fireship-create-viral-videos-with-react-code). This is the strongest external validation of the architecture recommended below.

**[NotebookLM Video Overviews](https://blog.google/innovation-and-ai/products/notebooklm/generate-your-own-cinematic-video-overviews-in-notebooklm/)** — sources → narrated slide video with style presets and a steering prompt, generated in the background; now with short vertical and cinematic variants ([docs](https://support.google.com/notebooklm/answer/16454555?hl=en)). Consumer-scale proof that "give me sources, get a narrated lesson" is a real interaction. Output is non-interactive video — exactly the ceiling Next Editor breaks.

**Demo-automation industry** — [Arcade](https://www.arcade.software/post/best-interactive-demo-software-2026) (synthetic voiceover "Avery"), [Supademo](https://supademo.com/blog/interactive-product-demo-software), [Storylane](https://www.storylane.io/blog/supademo-alternatives) (AI voiceover + avatars), and most relevantly [Demosmith](https://demosmith.ai/blog/what-is-ai-demo-agent): an agent opens your product in a cloud browser, clicks/types/scrolls autonomously, and delivers an MP4 with voiceover, captions and zooms in ~10 minutes, 29 languages, from $40/mo. The segment is projected around [$2.1B by 2026 at ~25% CAGR](https://demosmith.ai/blog/best-ai-demo-video-generators-2026). Two lessons: (a) agent-performed screen content is commercially real _today_; (b) everyone converges on MP4, so the interactive-lesson square stays open.

**[Coursera Course Builder](https://blog.coursera.org/coursera-launches-course-builder/)** — AI-assisted authoring of outlines, descriptions, objectives, assessments at enterprise scale. Validates demand at the _curriculum_ level; produces no performances.

**Fireship anatomy** ([channel history](https://read.engineerscodex.com/p/how-fireship-became-youtubes-favorite), [format stats](https://grokipedia.com/page/fireship)) — the quality bar being invoked: ~200–250 words/min narration, 10–15 cuts/min, a hard "100 seconds" constraint, one concept per video, humor as pacing relief. Two implications for us: **the script is the product** (everything else is execution), and the short format is the right v1 target — less drift to QA, faster iteration, and pacing lints can literally encode "Fireship rules" (wpm bounds, beat density, max dead air).

Also adjacent: Manim/3Blue1Brown (programmatic explainer video; a favorite LLM target for the same reasons as Remotion) and asciinema for terminal casts. Same pattern everywhere: _declarative artifact in, deterministic render out._

## 4. Harness architecture

Three candidate designs, evaluated against the constraint that renders must be reproducible, cheap, and verifiable:

### Tier A — Computer-use puppeteering (agent moves a real mouse over the real UI)

An LLM with computer-use drives the app pixel-by-pixel while recording runs. Most "human," and the only tier that needs zero new authoring format. Rejected as the core: model-in-the-loop latency destroys timing precision (narration sync at ±word level is impossible when every click costs an inference), renders are non-reproducible and expensive per minute, and flakiness compounds with lesson length. Demosmith works this way because their output tolerates loose timing; a narrated lesson does not.

### Tier B — Scripted Performer inside the app (recommended core)

A deterministic executor runs _inside the editor page_ and performs a compiled plan against the real surfaces while the ordinary recorder captures:

- **Editor:** type via the Monaco API (`getEditorInstance()` → `executeEdits`, `setSelection`, reveal calls) at a humanized cadence, so v4 capture records exact local edit batches. Playback-side helpers in `editorDiff.ts` show the idiom.
- **Workspace/dock/sidebar:** dispatch the same store events the UI dispatches (`workspaceStore`, runtime provider) — file create/switch/rename, panel focus, terminal commands.
- **Preview:** actually run the project (WebContainer today; the Cloudflare remote runtime later). rrweb capture works unchanged.
- **Whiteboard/slides:** apply element upserts / slide changes through the existing panel APIs; capture records them as it does for humans.
- **Cursor:** synthesized alongside each action (see §7) and fed through the existing capture path (the machine already ingests `onMouseMove(pos: MouseCursorPosition)` samples; the performer feeds it synthetic positions with `target` snapshots).
- **Clock:** the Director owns the timeline; the performer schedules actions against the recording clock, and TTS audio is attached as **external audio** at export (`audioSource: "external"` + sibling file), so audio/action alignment is exact by construction rather than by capture luck.

Runs headless (Playwright driving a `/studio/perform?script=…` route on a render machine) or visibly in the app — the latter is also a delightful demo ("watch the studio record itself") and a debugging tool. A 10-minute lesson takes ~10 minutes to render but renders parallelize per scene and per lesson across headless instances.

**Why B first:** zero format drift (the real recorder writes the bytes), the preview problem is solved for free, and every existing invariant (SCR3 encoding, offsets, checkpoint behavior) is exercised rather than reimplemented.

### Tier C — Track compiler (offline synthesis, later optimization)

Compile the script _directly_ to a `Recording` — frames via the dmp codec, cursor keyframes, captions, whiteboard events — without running a browser. Faster than realtime (seconds per lesson), perfectly deterministic, ideal for mass localization re-renders. Two catches: the preview track still requires a real execution pass (hybrid: synthesize editor tracks offline, capture preview by executing checkpoints in a headless runtime), and it must never drift from "what the recorder would have written" — mitigated with golden tests that render the same script via Tier B and Tier C and diff the decoded recordings. Build only after B stabilizes the semantics.

**Golden rule across tiers: no LLM in the render loop.** Agents author and critique scripts; rendering is `f(script, seed) → .ne`. Same input, same lesson. All creativity is checked in as a diffable artifact.

```mermaid
flowchart LR
  subgraph Creative loop (LLMs)
    Plan[Curriculum planner] --> Script[Scriptwriter]
    Script --> Gate[Beat gate: code must run]
    Gate --> Script
    Critic[Critic / judge] --> Script
  end
  subgraph Render loop (deterministic)
    Director[Director: TTS + align + schedule]
    Performer[Performer: drives editor surfaces, recorder captures]
    QA[QA: decode + assert]
  end
  Gate --> Director --> Performer --> QA --> Critic
  QA --> Publish[tube: R2 + lessons.json]
```

## 5. The LessonScript IR

The agent-authorable artifact. Design constraints: small enough for an LLM to hold and revise whole; declarative about _intent_ (targets, anchors) not pixels; every timing expressed relative to narration so TTS re-runs (or another language) reflow automatically.

```yaml
lesson:
  slug: go-generics-in-100s
  title: "Go Generics in 100 Seconds"
  language: en
  voice: { provider: elevenlabs, id: "<pinned-channel-voice>", speed: 1.06 }
  persona: fireship-ne-v1 # style guide the scriptwriter obeyed; kept for provenance
  workspace: starters/go-basic # initial files
  seed: 42 # cadence/cursor jitter reproducibility

scenes:
  - id: hook
    narration: >
      Generics. The feature Go refused to ship for a decade,
      then shipped so well you barely notice it.
    actions:
      - slide.show: { deck: intro, index: 0, at: start }
      - cursor.idle: { region: editor }

  - id: the-problem
    narration: >
      Say you want Min for ints... and floats. Before 1.18 you wrote it twice.
      Watch.
    actions:
      - file.open: { path: main.go, at: start }
      - edit.type: # typed at humanized cadence
          target: { after: "package main\n" }
          text: |
            func MinInt(a, b int) int { ... }
          at: word("twice") # anchor: starts when this word is spoken
      - editor.select: { match: "MinInt", at: word("Watch") }

  - id: run-it
    narration: The compiler monomorphizes this — zero runtime cost. Run it.
    actions:
      - runtime.exec: { cmd: "go run .", at: word("Run") }
      - expect.preview: { contains: "3 1.5", within: 8s } # QA gate, not just choreography
      - whiteboard.upsert: { elements_ref: diagrams/mono.excalidraw, at: word("monomorphizes") }

checks: # lesson-level gates evaluated after render
  - typecheck_clean_at: [the-problem, run-it]
  - captions_drift_ms_max: 300
  - narration_wpm: { min: 165, max: 245 }
```

Mapping to existing types is direct: narration + TTS alignment → `CaptionTrack`/`CaptionWord`; `edit.type` → Monaco edits → v4 exact edit batches; `cursor.*` and per-action cursor synthesis → `cursorEvents` with `CursorTargetSnapshot`; `whiteboard.upsert` → `WhiteboardEvent`; `slide.show` → `slideEvents`; `runtime.exec` → runtime events + rrweb preview capture; `expect.*` → QA assertions recorded in a render report (not in the `.ne`).

Two anchor primitives cover nearly everything: `at: word("...")` / `at: cue_end` (narration-relative) and `after: <action> +ms` (action-relative). The Director resolves them against TTS timestamps into an absolute schedule.

## 6. Voice pipeline

**Provider reality check (verify pricing at build time):**

| Provider         | Timing granularity                                                                                                                                                                                          | Notes                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| ElevenLabs       | **Character-level** via `…/with-timestamps` (`alignment.characters` + start/end arrays) — fold to words trivially ([docs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)) | Best-known quality/voice cloning; mid-priced                |
| Cartesia (Sonic) | **Word-level** (`add_timestamps`, plus phoneme timestamps) over WebSocket ([docs](https://docs.cartesia.ai/api-reference/tts/websocket))                                                                    | Very low latency (irrelevant for us) but clean word timings |
| Azure Speech     | Word-boundary events                                                                                                                                                                                        | Cheapest at volume; enterprise voices                       |
| OpenAI TTS       | No timestamps                                                                                                                                                                                               | Would need forced alignment (WhisperX-style) as a post-pass |

Design points:

- **Captions become ground truth, not transcription.** Because the script is the source, `CaptionCue`/`CaptionWord` are emitted from TTS alignment — zero ASR error. This inverts the usual captioning pipeline and is only possible script-first.
- **Audio as sibling external file.** Attach via `audioSource: "external"` + `audioFile`, `audioStartOffsetMs: 0` by construction. No change to `useUrlLoader` resolution. Inline fragments remain possible but buy nothing here.
- **Pronunciation lexicon for code.** TTS mangles `useEffect`, `:=`, `impl`. Maintain a lexicon (per language) of token → spoken form, applied by the Director before synthesis; the caption text keeps the _written_ form. Narration style rule: read intent, not syntax (Fireship reads almost no code aloud).
- **One pinned voice = the channel brand.** Voice ID is part of the persona config. Disclose AI narration in lesson metadata — cheap honesty that preempts backlash.
- **Localization is a re-render, not a re-shoot.** Translate narration (LLM), re-TTS, Director reflows all `word()` anchors automatically, Tier C re-render skips even the browser. Marginal cost ≈ TTS + translation tokens. 29-language Demosmith shows the demand; we'd match it with _interactive_ lessons.

## 7. Human-likeness layer

The point is didactic legibility, not deception — motion tells the learner where to look.

- **Cursor:** synthesize per-action trajectories — eased point-to-point curves with slight overshoot-and-settle, duration from distance (Fitts-style), micro-jitter from the seeded RNG, hover pauses on the target before clicks. Author as **targets** (`CursorTargetSnapshot` region + offset), never pixels, so playback remaps to any layout — a robustness pixel video can't have. The existing tween machinery (`CursorTweenSnapshot`, `cursorReplay.ts`) already smooths sample streams.
- **Typing:** cadence model per beat — bursts of 8–14 chars/s, longer pauses at line starts and before "hard" tokens, brief pause after completing a statement (matches where a human narrator breathes). Deliberate typos + corrections: **off by default** (clarity beats theater; Fireship doesn't fake mistakes), available as a script flag for "debugging journey" lessons where the mistake _is_ the lesson.
- **Attention choreography:** the Director enforces "point before you speak" — cursor/selection reaches the referenced code slightly _before_ the word anchor fires (≈200–400 ms lead), mirroring how humans gesture.
- **Pacing lints (the Fireship encoding):** wpm within band, ≥ N visual beats/min, no dead air > 2.5 s, scene length caps, one-concept-per-lesson check (judge-enforced). These run as script-time lints (cheap, pre-render) plus render-time verification.

## 8. The agent pipeline (creative loop)

| Role                   | Model class           | Input → output                                                                                     |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| Curriculum planner     | frontier              | topic/docs → syllabus, lesson list, per-lesson objective                                           |
| Scriptwriter           | frontier              | objective + persona style guide + starter workspace → `LessonScript`                               |
| Beat gate (not an LLM) | —                     | executes each scene's workspace state: typecheck/run/tests must pass before the script is accepted |
| Director               | deterministic         | script → TTS → aligned schedule                                                                    |
| Performer              | deterministic         | schedule → `.ne` (+ audio, captions)                                                               |
| Critic                 | frontier (multimodal) | decoded transcript + keyframe screenshots + render report → structured notes or approval           |
| Human editor           | Chan                  | greenlight, taste corrections → persona guide updates                                              |

Notes:

- **The beat gate is the anti-hallucination device.** A script isn't "reviewed for correctness" — its code is _executed_ at every checkpoint before rendering is allowed. The in-app agent tools (`bash`, `capturePreview`, `runtimeDiagnostics`) or a headless runtime do this today.
- **The persona doc is the taste asset.** A versioned style guide (voice, humor density, sentence rhythm, code-reading rules, banned clichés) that the scriptwriter obeys and the critic scores against. Editing this doc is how the human steers the whole channel — one file, channel-wide effect.
- **Benchmark corpus exists:** the ~41 handmade Go Tour lessons (plus the two production lessons) are ground truth. Decode them, extract pacing stats (wpm, action density, scene lengths, sync offsets), and use them for (a) calibrating the humanizer, (b) regression-testing the pipeline by _re-producing_ a few of them and comparing side by side. This is a rare asset — most teams bootstrapping AI content have no gold standard.
- **Authoring runs outside the app** (Claude Code / SDK sessions against the repo, producing script PRs), while the in-app OpenRouter agent remains the interactive assistant. Scripts-as-PRs means the whole channel is reviewable in git — the "lessons as code" promise made literal.
- **Revision loop is scene-scoped:** critic flags scene 3 → scriptwriter patches scene 3 → re-render scene 3's time slice and splice tracks (all tracks are time-clustered already). Never reshoot the lesson.

## 9. Verification (the actual moat)

Cheap, mechanical QA is what MP4 pipelines cannot have and what keeps an autonomous channel from shipping slop:

1. **Decode-level:** `.ne` round-trips; track durations agree; captions monotonic; audio offset 0 ± ε.
2. **Semantic gates:** at every `expect`/checkpoint — reconstruct workspace, run typecheck/tests/`go vet`-equivalents in the runtime, assert preview content (rrweb tree text, console error scan via existing runtime diagnostics).
3. **Sync gates:** measured caption↔action drift (the Director's plan vs. captured timestamps) under 300 ms; pacing lints re-verified on the rendered artifact.
4. **Determinism:** golden scripts rendered twice → decoded recordings equal modulo wall-clock metadata; Tier B vs Tier C parity (once C exists).
5. **Judge pass:** multimodal critic watches transcript + sampled keyframes against the persona rubric (clarity, pacing, correctness of claims, joke density within bounds).
6. **Human gate:** a person plays the lesson before `lessons.json` merge. Keep this until judge-vs-human agreement is measured and boring.

## 10. Cost sketch (order-of-magnitude, verify at build time)

Per ~100-second lesson: script authoring + revisions ≈ $0.5–3 of frontier tokens; TTS ≈ 400 words ≈ $0.05–0.50 (Azure cents, ElevenLabs tens of cents); render compute ≈ negligible locally / cents on a cloud browser; critic pass ≈ $0.2–1. **Under ~$5 per short lesson; localization ≈ TTS-only marginal cost.** A 41-lesson course re-render (new voice, new language, format tweak) is dollars, not weeks. The binding constraint is editorial quality and review bandwidth, never compute — which is the right problem to have.

## 11. Risks and mitigations

| Risk                                                 | Mitigation                                                                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Slop** — technically-correct, soulless lessons     | Persona doc as versioned taste asset; judge rubric; human greenlight; small curated catalog over volume; benchmark against the handmade Go lessons                                                              |
| TTS mangles code speech                              | Pronunciation lexicon + "narrate intent not syntax" rule; caption text stays written-form                                                                                                                       |
| Uncanny fake-human theater                           | Motion serves attention, not deception; no fake typos by default; disclose AI narration                                                                                                                         |
| Tier C drifts from real recorder output              | Don't build C until B is stable; golden B-vs-C parity tests                                                                                                                                                     |
| Runtime nondeterminism (WebContainer boots, network) | Pin starter deps; forbid network in lessons (or record/replay it); per-scene retry with identical clock; the CF remote runtime plan (docs/remote-runtime-*.md) eventually gives server-side, farm-able runtimes |
| Timing brittleness on re-TTS                         | All timings are narration-relative anchors; absolute times exist only in compiled schedules                                                                                                                     |
| Format evolution breaks old scripts                  | Scripts declare a schema version; Director owns migrations; scripts live in git                                                                                                                                 |
| Voice/likeness legal issues                          | Licensed/designed voice, not a clone of a real creator; per-lesson AI disclosure                                                                                                                                |

## 12. Roadmap

- **M0 — Script + Performer skeleton (1–2 wks):** LessonScript schema (zod), Director without TTS (fixed timings), Performer driving editor + workspace only, triggered from a dev-only route; record via existing `START_RECORDING` flow; play the result. _Proves: scripts render to real lessons._
- **M1 — Voice (1 wk):** ElevenLabs/Cartesia integration, word-anchor resolution, `CaptionTrack` emission, external sibling audio export. _Proves: transcript-first alignment._
- **M2 — Full surface + humanizer (2 wks):** cursor synthesis with targets, whiteboard/slide/runtime actions, typing cadence, headless render CLI (Playwright → `/studio/perform`), render report.
- **M3 — QA harness (1–2 wks):** decode assertions, semantic/sync gates, golden determinism tests; decode-and-stat the Go lessons benchmark.
- **M4 — Authoring agents (2–3 wks):** persona doc v1, scriptwriter + beat gate + critic as Claude Code/SDK workflows producing script PRs; produce 3 pilot lessons end-to-end (suggest: re-produce 2 Go Tour lessons for A/B against the handmade ones + 1 new "X in 100 seconds").
- **M5 — Channel operations (ongoing):** scene-scoped re-render, localization batches, tube auto-publish (R2 + `lessons.json` PR), Tier C compiler if render throughput ever matters, interactive challenge checkpoints (Scrimba-style "now you fix it" pauses — a format extension the player would need to learn, and a genuinely new pedagogic capability once scripts can emit hidden tests).

## 13. Open questions

1. **Voice identity:** design one channel voice (which provider/voice), or per-course voices?
2. **Where the Performer lives:** dev-only route in the main app vs. a separate `studio/` package importing the core — affects bundle hygiene.
3. **Disclosure posture:** "AI-produced, human-edited" label on tube lessons from day one?
4. **Pilot picks:** which 2 Go Tour lessons make the best A/B benchmark, and what's the first net-new "100 seconds" topic?
5. **Interactive checkpoints:** worth pulling forward (it's the most defensible learner-facing feature), or strictly after the channel ships?

## Sources

Scrimba: [interview](https://survivejs.com/blog/scrimba-interview/), [guide](https://scrimbaguide.tech/docs/intro/), [2026 review](https://www.coursefacts.com/guides/scrimba-review-2026) · VHS: [repo](https://github.com/charmbracelet/vhs), [walkthrough](https://blog.ouseful.info/2022/11/09/creating-terminal-based-screenshot-movies-with-vhs/) · Remotion: [LLM generation](https://www.remotion.dev/docs/ai/generate), [coding agents](https://www.remotion.dev/docs/ai/coding-agents), [agent skills](https://www.remotion.dev/docs/ai/skills), [Fireship-style with Remotion](http://blog.brightcoding.dev/2026/02/21/remotion-fireship-create-viral-videos-with-react-code) · NotebookLM: [cinematic overviews](https://blog.google/innovation-and-ai/products/notebooklm/generate-your-own-cinematic-video-overviews-in-notebooklm/), [help doc](https://support.google.com/notebooklm/answer/16454555?hl=en) · Demo automation: [Demosmith AI demo agent](https://demosmith.ai/blog/what-is-ai-demo-agent), [market guide](https://demosmith.ai/blog/best-ai-demo-video-generators-2026), [Arcade](https://www.arcade.software/post/best-interactive-demo-software-2026), [Supademo](https://supademo.com/blog/interactive-product-demo-software), [Storylane](https://www.storylane.io/blog/supademo-alternatives) · Coursera: [Course Builder](https://blog.coursera.org/coursera-launches-course-builder/) · Fireship: [analysis](https://read.engineerscodex.com/p/how-fireship-became-youtubes-favorite), [format stats](https://grokipedia.com/page/fireship) · TTS: [ElevenLabs with-timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps), [Cartesia WebSocket](https://docs.cartesia.ai/api-reference/tts/websocket)
