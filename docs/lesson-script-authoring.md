# LessonScript Authoring Contract

The complete, self-contained specification for writing studio lesson scripts.
Written for **agents** (Claude Code, Codex, or any coding agent) as much as for
humans: following this document end-to-end produces a lesson that compiles,
renders unattended, and passes every mechanical gate — without reading the
studio's source code. The editorial rules live in
[studio-persona.md](./studio-persona.md); the operational runbook in
[studio-m0-runbook.md](./studio-m0-runbook.md).

## What you are producing

One LessonScript YAML. It fully determines a narrated, replayable coding
lesson: the starter workspace, the spoken narration, every
editor/slide/whiteboard/runtime action, and the assertions that gate the
build. The YAML is the _only_ artifact — it is parsed and validated in the
browser at render time. Two ways it reaches the studio:

- **Checked in** at `src/studio/scripts/<slug>.yaml` — auto-registers by
  filename (never touch `src/studio/plans/index.ts`).
- **Imported at runtime** — any user pastes the file into `/studio` on the
  website via **Import…**; it is validated and critiqued in the page.

## The mental model (read this before writing)

1. Narration is written per **scene**, with `[[mark:name]]` tokens embedded in
   the prose. Each mark is an **anchor**: the text splits at every mark into
   **dialogs**, each dialog is synthesized to audio separately (pocket-tts, in
   the render page), and actions fire at the mark they reference.
2. The scheduler places dialogs **around the actions**: narration waits until
   an anchored typing action finishes before the next dialog starts. You do
   not compute timings — you place marks where things should happen and let
   the compiler schedule. It fails (before any render) on impossibilities and
   warns when your actions force more than ~2.5s of silence ("add narration
   here or shorten the action").
3. The whole performance is recorded live in the editor, then mechanically
   verified: the run output must appear in the recorded console, edited files
   must contain what you asserted, action start times must hit their plan
   times within the timing gate. A render that fails any gate produces no
   lesson.

## Workflow

**Users (production website)** need no tooling at all: open `/studio`, pick a
lesson from the dropdown (or **Import…** a YAML file — validated and
critiqued in the page), press **Start render**, watch, and **Create draft…**
(sign-in required for drafts; publishing stays a separate human action).

Users can also **clone their own voice** (pocket-tts voice cloning): the
voice row offers **Record** (microphone, 2–20s) or **Clone…** (an audio
file); the sample is stored only in the browser (IndexedDB), and selecting
the cloned voice narrates the next render with it. Scripts keep pinning
built-in profiles in `build.voiceProfile` — cloning is a render-time choice,
and a draft rendered with a cloned voice says so in its description.

**Agents working in this repo**:

```text
1. Write    src/studio/scripts/<slug>.yaml     # auto-registers by filename
2. Validate bun scripts/studio-director.ts     # optional preflight, all scripts
                                               # (or pass one path)
   → fix schema/marker errors; weigh critic notes (advisory);
     writes <slug>.critique.json next to the YAML
3. Render   bun run dev   (separate terminal, keep running)
            open /studio?plan=<slug> in a real Chrome, press Start render,
            watch the performance, confirm "Checks (N/N ok)" + receipts
   → agents with browser access drive the user's Chrome and watch live;
     do not verify with the headless harness
     (bun scripts/studio-render.ts exists for CI/repeatability audits only)
4. A human watches the lesson (/studio?plan=<slug>) and decides on a draft.
```

Step 2 is convenience — the same validation runs in the page — but it catches
errors without a browser. Renders need Chrome and network for the one-time
TTS bundle download; if your environment cannot run a browser, stop after
step 2 and report that the render is pending.

## Schema reference

Top level:

```yaml
schemaVersion: 1 # literal
lesson:
  slug: kebab-case # unique; becomes the filename and render id
  title: "…"
  locale: en-US
  workspace: # the PINNED starter state (exact file contents)
    lessonType: go # one of the six languages, see the matrix below
    name: Go Lesson
    entryFilePath: main.go
    files:
      main.go: | # exact content, tabs for Go indentation
        package main
        …
  slides: [] # optional, see Slides
  whiteboardAssets: [] # optional, see Whiteboard
build:
  voiceProfile: pocket-alba-v1 # see src/studio/tts/profiles.ts for ids
  seed: 11 # any int ≥ 0; drives typing cadence + narration noise
runtime:
  kind: go-playground # must match lessonType (matrix below)
  defaultMode: fixture # fixture = offline deterministic; live = real service
  fixture:
    latencyMs: 1200
    transientErrorKinds: [] # e.g. [unavailable] to exercise the retry path
    result:
      status: success
      exitCode: 0
      output: "line one\nline two\n"
scenes: […] # see Scenes
checks:
  - { type: timing.p95Ms, max: 300 } # recommended on every script
```

### Lesson types and runtime kinds

Lesson types are the six **languages** the platform teaches — not the starter
templates (react, vue, svelte, … are just seeded workspace conveniences for
users; the WebContainer runs any pinned JS/TS workspace). `runtime.kind` is
fixed by the lesson type — the schema rejects mismatches:

| `lessonType`                         | `runtime.kind`      | can `runtime.run`? |
| ------------------------------------ | ------------------- | ------------------ |
| `go`                                 | `go-playground`     | yes                |
| `kotlin`                             | `kotlin-playground` | yes                |
| `rust`                               | `rust-playground`   | yes                |
| `javascript`, `typescript`, `python` | `none`              | no                 |

A `javascript` (Node.js) or `typescript` lesson pins whatever WebContainer
workspace the lesson needs — a bare Node script, an Express server, a React or
Vue app — the runtime is not limited to the starters. `python` runs the
WebContainer's WASI script model. Go, Kotlin, and Rust are limited to their
playground services.

Kind `none` lessons omit the `runtime:` block entirely (or write
`runtime: { kind: none }`) and must not use `runtime.run` or `expect.output` —
they teach through editing, slides, whiteboard, and `expect.file` gates. Their
WebContainer execution path is not yet driven by the studio.

Per-kind fixture `result` shapes (all fields exact program truth):

- `go-playground` — `{ status: success | compile-error | runtime-error, output, exitCode, compileErrors? }`
- `kotlin-playground` — `{ status: success | compile-error | runtime-error, output, compileErrors?, warnings?, exception? }`
- `rust-playground` — `{ status: success | compile-error | runtime-error, stdout, stderr, compileErrors?, exitDetail? }`

Language formatting rules carry over from the real editors: Go files use tabs;
Kotlin and Rust use 4-space indentation. Rust workspaces must contain
**exactly one file, `main.rs`** (the Rust Playground executes a single crate
root); Go and Kotlin workspaces need at least one `.go` / `.kt` file.

### Scenes, narration, and marks

```yaml
scenes:
  - id: unique-scene-id
    narration: >
      Prose the voice speaks. [[mark:do-it]] More prose after the anchor.
    sources: # ≥1 per scene or the critic flags it
      - { title: "…", url: "https://…" }
    actions: […]
```

Marker rules:

- `[[mark:name]]` — kebab/alphanumeric names, **globally unique** across all
  scenes, removed before synthesis and captions.
- A mark anchors to the word that follows it. Place a mark exactly where the
  related action should begin. Marks at sentence boundaries sound best (each
  inter-mark span is synthesized as one utterance).
- Every mark referenced by an action must exist; unreferenced marks only
  produce a critic note.

Narration is also the caption text — write it clean (the persona guide's
sentence-length and banned-phrase rules apply; the critic enforces them as
advisory notes).

### Actions

Common fields: `id` (globally unique), `at` (anchor), optional `timeoutMs`
(default 10000; the command must acknowledge within it).

Anchors (`at`) — narration-relative only, never absolute times:

- `{ mark: name }` or `{ mark: name, offsetMs: -400 }` — at a mark, optionally
  shifted (negative = start before the words are spoken; small values only).
- `{ scene: start }` — at the scene's first spoken word.
- `{ afterAction: other-id }` — after that action completes (use for
  `expect.*` gates that follow `runtime.run`).

Action catalog:

| type                 | fields                                                  | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.openFile` | `path`                                                  | Path must exist in `workspace.files`. A cursor tween to the file row is derived automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `editor.type`        | `target: {file, after, occurrence}`, `text`, `cadence?` | **Insert-only.** `after` is an exact substring of the file's _current_ content; insertion happens at the end of its `occurrence`-th match (`after: ""` = start of file). The file must already be open (`workspace.openFile` first). Typed `text` is inserted verbatim — include leading `\n` and tabs. `cadence` picks how the code appears: `natural` (default — single keystrokes with word and thinking pauses, matched to a reference human typing recording), `fast-explainer` (brisker keystrokes), `line-by-line` (incremental reveal, one line at a time, no keystrokes), `block` (whole insertion at once after a beat). Prefer `line-by-line` or `block` for longer snippets the narration only summarizes; keystroke cadences suit short, narrated-along edits. |
| `runtime.run`        | —                                                       | Runs the workspace on the lesson's playground (every `.go` file / every `.kt` file / the single `main.rs`). Playground kinds only. Give it `timeoutMs: 15000` (Rust live compiles are slow — use `30000`). Retries transient service failures once, silently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `slide.show`         | `slideId`, `maximized` (default true)                   | `slideId` must be in `lesson.slides`. Showing a slide while another is open advances **in place** (like moving to the next slide) — do not `slide.close` between consecutive slides; close only when returning to the editor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `slide.close`        | —                                                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `whiteboard.apply`   | `open?`, `maximized?`, `upsertIds: []`                  | Ids from `lesson.whiteboardAssets`. Must open, change maximize, or upsert ≥1 asset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `expect.output`      | `contains`, `timeoutMs`                                 | QA gate, not lesson content: waits for a console line containing the string; any `[go-run error]` / `[kotlin-run error]` / `[rust-run error]` line fails it. Anchor with `afterAction: run`. Playground kinds only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `expect.file`        | `path`, `contains`                                      | Asserts the final workspace file contains the string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Critical `editor.type` discipline:

- Compute `after` against the file content **as it will be at that moment**
  (pinned content plus any earlier insertions in the same file).
- The anchor must match exactly — byte-for-byte, including `\n` and `\t`. In
  YAML, prefer double-quoted strings with escapes for anchors and typed text:
  `after: "\treturn value * value\n}\n"`.
- There is no delete/replace. Design lessons as additive edits.
- End insertions that sit in front of existing code with `\n` — the performer
  presses Enter first (the trailing newlines land before any body text), so
  the existing code moves to the next line the way a developer would move it
  rather than trailing the line being typed.
- Insertions take real time (`natural` types single keys at ~7 chars/sec plus
  word-start and thinking pauses;
  `line-by-line` reveals at reading pace). The scheduler makes narration wait
  for them, so long insertions stretch the lesson — keep keystroke-typed
  blocks short and narrate what they mean, or switch longer snippets to
  `line-by-line`/`block`.

### The fixture must be the truth

The fixture result's program output (`output` for Go/Kotlin, `stdout` for
Rust) must be **exactly** what the real program prints (every line,
`\n`-terminated). Two reasons: `expect.output` runs against it in
fixture mode, and a later `--runtime=live` render runs the real Playground —
if your pinned program and fixture disagree, live renders fail. Mentally
execute the final code (pinned files + your insertions) and transcribe its
output.

### Slides

Two kinds. Inline slides carry their content in the YAML:

```yaml
slides:
  - id: intro
    contentType: markdown # or html
    name: Optional label
    content: |
      # Title
      `code` and short lines render well.
```

Google slides pin one page of a **published** Google Slides deck
(File → Share → Publish to web — the link contains `/d/e/…/pub`). Use the
Next Editor lesson template's brand style for these decks. The Director
fetches the deck once at compile time in the render page and pins the page's
SVG into the plan; `bun scripts/studio-director.ts` verifies the page ids
early (best-effort — offline it warns and the render page re-checks):

```yaml
slides:
  - id: intro
    contentType: google
    name: Optional label
    deckUrl: "https://docs.google.com/presentation/d/e/…/pub"
    pageId: SLIDES_API123_0 # the deck page id; the director lists valid ids on mismatch
```

Editing the published deck between renders changes the pinned SVG — the
repeatability comparison fails loudly rather than shipping a half-updated
lesson. Keep lesson decks text-only where possible; Google-hosted images go
through the app's media ingestion path at fetch time.

Deck SVGs embed font data, and painting them briefly stalls the render's
main thread at each show/close — actions scheduled right next to a
`slide.show`/`slide.close` can start ~0.4s late. For deck-slide lessons a
`timing.p95Ms` of `500` (instead of the default `300`) is acceptable; keep
`300` for lessons without deck slides.

### Whiteboard assets

```yaml
whiteboardAssets:
  - { id: box, kind: rectangle, x: 320, y: 200, width: 420, height: 150, strokeColor: "#7dd3fc" }
  - {
      id: label,
      kind: text,
      x: 350,
      y: 250,
      width: 360,
      height: 40,
      text: "value × value × value",
      strokeColor: "#e2e8f0",
      fontSize: 24,
    }
```

Kinds: `rectangle`, `ellipse`, `text`. Coordinates are canvas pixels; keep
content roughly within (250,150)–(1100,650) so it is visible unzoomed.

## Editorial requirements (summary — full text in studio-persona.md)

- **One concept per lesson**, 20–100 seconds of narration.
- Sentences under ~20 words (hard ceiling 24). No filler: _simply, obviously,
  easy, delve, in this video, don't worry_ etc. are flagged.
- Every scene cites ≥1 source (official docs/spec/tour URLs preferred).
- Narrate _why_; the typed code shows _what_. No fake mistakes.
- The critic (`✎` lines from the director) is advisory — address the notes or
  consciously keep the text, but never ignore a `sources.missing`.

## Failure → fix table

| Symptom                                         | Fix                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Invalid lesson script: …`                      | Schema violation; the path in the message names the field.                                              |
| `Unknown marker "x" — known markers: …`         | An action references a mark not present in narration.                                                   |
| `Typing action "…" overlaps "…"` (compile)      | Two authored actions collide; move the later mark or add `offsetMs`.                                    |
| `⚠ …ms of silence inserted before dialog …`     | Your action outlasts the narration around it; add a sentence there or shorten the typed text.           |
| `Anchor occurrence N of "…" not found` (render) | The `after` string doesn't match the file at perform time — check tabs/newlines and earlier insertions. |
| `checkpoint.output.… never contains …`          | Fixture output and `expect.output` disagree, or the program doesn't print it.                           |
| `timing.p95 — … (max 300ms)` failure            | Usually a squeezed action; check the receipts in the render report for the late action.                 |
| Repeatability FAIL on `repeat.audio`            | Should not happen (synthesis is seeded); report it as a bug rather than working around it.              |

## A complete example

`src/studio/scripts/rust-borrow.yaml` is the canonical example: eight scenes,
published-deck slides, keystroke and line-by-line typing, run + gates, in the
conversational persona register. Start from a copy of it. Smaller historical
pilots (Go, incl. whiteboard + retry-fixture usage) live as test fixtures
under `src/studio/script/__fixtures__/`.
