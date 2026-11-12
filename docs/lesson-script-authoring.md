# LessonScript Authoring Contract

The complete, self-contained specification for writing studio lesson scripts.
Written for **agents** (Claude Code, Codex, or any coding agent) as much as for
humans: following this document end-to-end produces a lesson that compiles,
renders unattended, and passes every mechanical gate — without reading the
studio's source code. The editorial rules live in
[studio-persona.md](./studio-persona.md); the operational runbook in
[studio-m0-runbook.md](./studio-m0-runbook.md).

## Contents

- [What you are producing](#what-you-are-producing)
- [The mental model](#the-mental-model-read-this-before-writing)
- [Teaching design](#teaching-design-decide-this-before-the-yaml)
- [Workflow](#workflow)
- [Schema reference](#schema-reference)
- [Editorial requirements](#editorial-requirements-summary--full-text-in-studio-personamd)
- [Failure → fix table](#failure--fix-table)
- [A complete example](#a-complete-example)

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
   **dialogs**, each dialog is synthesized to audio separately (pocket-tts in
   the render page for English; for Burmese, AthanLab with your own API key,
   or VoxCPM2 on Modal when that private feature is enabled), and actions
   fire at the mark they reference. Before the dialogs are stitched, every one
   is leveled to the same loudness (−18 LUFS, or lower for the whole narration
   when one dialog is too peaky or too quiet to get there), so the voice keeps
   one volume.
2. The scheduler places dialogs **around the actions**: narration waits until
   an anchored typing action finishes before the next dialog starts. You do
   not compute timings — you place marks where things should happen and let
   the compiler schedule. The compiler runs in the render page once the
   narration is synthesized, before recording starts: it fails on
   impossibilities (overlapping actions, an action that starts after the
   narration ends) and warns when your actions force more than ~2.5s of silence ("add narration
   here or shorten the action"). Import… and the Director CLI validate the
   script but do not compile or schedule it.
3. Studio automatically adds a **two-second quiet recording handle** before
   the first dialog and after the later of the final dialog or action. This
   gives recording and optional screen capture time to settle and keeps the
   voice from starting or ending abruptly. Do not create filler scenes or
   timing offsets to imitate this buffer.
4. The whole performance is recorded live in the editor, then mechanically
   verified: the run output must appear in the recorded console, edited files
   must contain what you asserted, action start times must hit their plan
   times within the timing gate. A render that fails any gate produces no
   lesson.

## Teaching design (decide this before the YAML)

A lesson is not a video. The learner watches it inside a real editor: at any
moment they can pause, change the code and run it, then carry on, and their
edits are kept as a version they can come back to. Design for that learner —
one who can touch what you show.

- **Write down what the learner can do afterwards, in one sentence, first.**
  "After this you can make a button change what the page shows." Whatever does
  not serve that sentence belongs to another lesson.
- **Open with the need, not the definition.** Show the question the idea
  answers — a button that does nothing yet, output that is not what you would
  expect — and then the idea. Starter code that is unfinished is not a fake
  mistake; a bug planted to be "discovered" is.
- **Give each idea the surface that shows it best**, one surface at a time:

  | The idea is…                                         | Show it on                                    |
  | ---------------------------------------------------- | --------------------------------------------- |
  | a few steps or terms the narration walks through     | a slide, with a `slide.point` at each as said |
  | how things relate: a flow, a cycle, before and after | the whiteboard, drawn as it is said           |
  | what the code is                                     | the editor: type it, or `editor.select` it    |
  | what the code does                                   | a run and the console, or the preview         |

  A slide or a board covers the editor, so close it before the words go back
  to the code.

- **Type only the lines the idea hinges on**, and pin the rest in the
  workspace files. Every typed character costs narration time and the
  learner's attention; spend both on the part being taught.
- **Before the run that matters, ask what it will do.** "What do you think this
  prints?", then run it and point at the line that answers. A learner who has
  guessed remembers the answer. Once or twice in a lesson, not at every run.
- **Hand the code over.** Name one small, specific change the learner can make
  by themselves — "pause here, change the one to a five, and run it" — at a
  moment when the code is on screen and complete enough to run. Choose a change
  whose result they can see, and make it yourself first so you know it works.
  This is the thing a video cannot do; a lesson that never invites it has used
  the editor as a screen.
- **Close with the idea in one sentence**, in the words you opened with, so the
  last thing the learner hears is the thing to keep.

## Workflow

**Users (production website)** need no tooling at all: open `/studio`, pick a
lesson from the dropdown (or **Import…** a YAML file — validated and
critiqued in the page), press **Start render**, watch, and **Create draft…**
(sign-in required for drafts; publishing stays a separate human action).
Narration synthesis can take many minutes on a first render; when it is done,
the render waits for the studio tab to be in front (status
`waiting-for-visible-tab`) before it starts recording, because Chrome pauses
the preview and the recorder in a background tab.

Users can also provide a narrator reference: the voice row offers **Record**
(microphone) or an audio-file picker. The prepared sample is stored in the
browser (IndexedDB). English Pocket-TTS cloning accepts 2–20s and stays
entirely local.

Burmese narration (`locale: my` or `my-MM`) has two providers, chosen in the
render console's narration select:

- **မြန်မာ · AthanLab (your API key)** is open to any signed-in user, and its
  panel takes the place of the voice row. Paste your own AthanLab API key
  once: Next Editor checks it, stores it encrypted on its server, uses it only
  for your own narration jobs, and never shows it again (the panel shows only
  its last four characters). Get a key at
  https://athanlab.com/dashboard/api (developer access is invite-only and needs
  AthanLab's Max plan). Create a separate key for Next Editor with only the
  `speech:write`, `speech:read`, and `voices:read` permissions (`usage:read`
  is optional and shows your balance), a monthly character budget, and a short
  expiry. Then pick one of your AthanLab voices — **Listen** plays a free
  sample — and every dialog keeps that one speaker. Each uncached dialog is
  one AthanLab job, charged to your AthanLab balance at AthanLab's rates, and
  AthanLab keeps each job's text and audio for 30 days. Finished dialogs are
  cached in this browser, so rendering the same text again is not charged
  again. If AthanLab rejects the saved key (it expired or was revoked),
  Studio stops sending it and asks you to connect a new one; **Disconnect**
  deletes it from Next Editor, and you should also revoke it in your AthanLab
  dashboard.
- **မြန်မာ · VoxCPM2 (Modal)** is listed only for accounts with the private
  VoxCPM2 feature. Its renders require a selected 5–20s reference and send it
  through the authenticated Worker to the private Modal deployment as part of
  every uncached dialog's narration job; Modal stores each job's input and
  keeps its audio for up to 7 days. Reusing that reference keeps one speaker
  across the render.

Scripts keep pinning built-in profiles in `build.voiceProfile` — the
narration provider, voice, and reference are render-time choices. **Start
render** stays disabled, with the reason shown, until the script's locale
matches the chosen provider's language, and a Burmese provider works with
LessonScript sources only. The selected voice name appears in the build
provenance on the **Create draft…** button's tooltip, not in the public draft
description.

The render console also offers an opt-in **Screen recording** toggle
(desktop browsers only). When enabled, pressing **Start render** first prompts
for a screen or tab to share, then captures the whole performance to a
standalone video that downloads to the local machine when the render finishes.
The narration is included **only** when you share a browser **tab** with "share
tab audio" enabled — Studio plays the narration into the tab, which the browser
can capture only as tab audio. Sharing a screen or window, or leaving tab audio
off, records a **silent** video (saved with a `-silent` suffix). This is purely
a render-time capture choice: the video never enters the `.ne` bundle, the
recording, QA gates, or any upload path (it is a sibling artifact for reviewing
or sharing the run), so scripts need no field for it. Dismissing the share
picker simply renders without the video.

**Agents working in this repo**:

```text
1. Write    src/studio/scripts/<slug>.yaml     # auto-registers by filename
2. Validate bun scripts/studio-director.ts     # optional preflight, all scripts
                                               # (or pass one path)
   → fix schema/marker errors; weigh critic notes (advisory);
     writes <slug>.critique.json next to the YAML
   Check    bun scripts/studio-compile-check.ts src/studio/scripts/<slug>.yaml
   → timeline at real narration rates, dialog limits, whiteboard ink/sizes
   Replay   bun scripts/studio-verify-lesson.ts src/studio/scripts/<slug>.yaml
   → WebContainer (Vite) lessons only: every action against real Vite + Chrome
3. Render   bun run dev   (separate terminal, keep running)
            open /studio?plan=<slug> in a real Chrome, press Start render,
            watch the performance, confirm "Checks (N/N ok)" + receipts
   → agents with browser access drive the user's Chrome and watch live;
     do not verify with the headless harness
     (bun scripts/studio-render.ts exists for CI/repeatability audits only)
   → for a JS/TS preview fixture, repeat from a clean page and require both
     renders to pass normalized repeatability before claiming support
4. A human watches the full replay (/studio?plan=<slug>) and decides on a draft.
```

Step 2 is convenience — the Director's validation runs in the page too — but
it catches errors before a render. Renders need Chrome and network for the
one-time TTS bundle download and, for JS/TS, the pinned dependency install. If
your environment cannot run a browser, stop after step 2 and report that the
two Chrome renders and human replay review are pending.

`studio-compile-check` compiles each script it is given at narration rates
estimated by characters: 55, 70 and 95 ms per character by default
(`--rates=`), around the ~14 characters a second VoxCPM2 speaks Burmese. The
registry test (`npx vp test run src/studio/plans/index.test.ts`) estimates by
whitespace tokens, which badly underestimates Burmese, so a timeline that only
breaks with real audio fails here first, before any synthesis is paid for. It
exits 1 on an error: a compile failure at any rate, a Burmese dialog over the
2,000 characters VoxCPM2 speaks per request, pale whiteboard ink, or a label
under 28px. Warnings are advisory — fix each one or keep it on purpose: a long
dialog, a Burmese dialog that stops mid-clause instead of at `။` or `၊`,
code-like characters in narration, a box outside the visible area, a board
whose shapes share one colour, a slide that stays up more than 8 seconds with
no `slide.point` on it, a `slide.point` on a markdown slide, a preview whose
elements the lesson checks but never points at (see The pointer), or a
`preview.open` with less than 5 seconds before the next narrated action (see
Opening the preview).

`studio-verify-lesson` is for WebContainer (Vite) lessons. It replays every
action in plan order through the Performer's own dispatch, against the pinned
workspace running its own Vite and the studio's real preview bridge in
headless Chrome. `editor.type` lands chunk by chunk at the studio's cadence,
so half-typed JSX in a live module shows up the way a learner would see it —
as a Vite overlay or a console error — and `preview.*`, `expect.preview` and
`expect.file` run as they do in a render. Any console error, uncaught error,
overlay or failed action fails the lesson (exit 1). Pass several YAMLs to check
a whole course; `--only-scene=<id>` fast-forwards to one scene, `--bail` stops
at the first failure, `--headed` shows the browser, and
`--screenshot-dir=<dir>` saves the final preview and every failed expectation.
It needs system Chrome and node, plus network the first time it meets a
dependency set (installed once into `node_modules/.cache/studio-verify-lesson/`).
Pointer, slides, whiteboard and console runs are not checked, except that
typing or highlighting code, a maximized slide and an opening whiteboard clear
focus in the preview, as the studio does (see Preview focus). A pass is a
preflight, not a render: step 3 is still the gate.

## Schema reference

Top level:

```yaml
schemaVersion: 1 # literal
lesson:
  slug: kebab-case # unique; becomes the filename and render id
  title: "…"
  locale: en-US
  workspace: # the PINNED starter state (exact file contents)
    lessonType: go # one of the languages in the matrix below
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
  seed: 11 # integer 0–2147483647; drives typing cadence + narration noise
runtime:
  kind: go-playground # must match lessonType (matrix below)
  defaultMode: fixture # fixture = offline deterministic; live = real service
  dockStartsCollapsed: false # optional; see the runner dock, below
  fixture:
    latencyMs: 1200
    transientErrorKinds: [] # e.g. [unavailable] to exercise the retry path
    result: # every runtime.run replays it; or `results`, one per run (below)
      status: success
      exitCode: 0
      output: "line one\nline two\n"
scenes: […] # see Scenes
checks:
  - { type: timing.p95Ms, max: 300 } # required on every script
```

Every object in a script is **strict**: an unknown or misspelled key
(`cadance: block`, `offsetMS: 400`) is a validation error, not a silently
ignored field. `build.seed` is an integer from 0 to 2147483647 (the
synthesizers take a signed 32-bit seed); both rules are checked when the
script is parsed, so Import… and the Director CLI report them before any
synthesis.

`timing.p95Ms` is the only check a script declares, and it is mandatory. The
artifact gates (`recording.decodes`, `runtime.noErrors`, track/caption/preview
checks, …) run on every render and are not configurable — there is nothing to
opt into or out of.

### Lesson types and runtime kinds

Lesson types are the **languages** the platform teaches — not the starter
templates (react, vue, svelte, … are just seeded workspace conveniences for
users; the WebContainer runs any pinned JS/TS workspace). The `runtime` block
is **required for every script**, and its kind is fixed by the lesson type —
the schema rejects an omitted block or a mismatch:

| `lessonType`               | required `runtime.kind` | execution actions                                                      |
| -------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `go`                       | `go-playground`         | `runtime.run`, `expect.output`                                         |
| `kotlin`                   | `kotlin-playground`     | `runtime.run`, `expect.output`                                         |
| `rust`                     | `rust-playground`       | `runtime.run`, `expect.output`                                         |
| `zig`                      | `zig-playground`        | `runtime.run`, `expect.output`                                         |
| `haskell`                  | `haskell-playground`    | `runtime.run`, `expect.output`                                         |
| `kite`                     | `kite-playground`       | `runtime.run`, `expect.output`                                         |
| `asm`                      | `asm-playground`        | `runtime.run`, `expect.output`                                         |
| `javascript`, `typescript` | `webcontainer`          | `runtime.start`, `runtime.waitForReady`, `preview.*`, `expect.preview` |
| `python`                   | `webcontainer`          | `runtime.start`, `expect.output` (WASI `python3`; console, no preview) |

A `javascript` (Node.js) or `typescript` lesson pins whatever WebContainer
workspace it needs — a bare server, an Express app, React, Vue, Vite, or
another deterministic workspace. It pins exact dependency versions in
`package.json` and declares this versioned runtime (commands are exact strings
and never inherited from ambient editor settings):

```yaml
runtime:
  kind: webcontainer
  adapterVersion: 1
  defaultMode: live
  initCommand: pnpm install
  runCommand: pnpm dev
  expectedPort: 5173 # optional only when the server port truly is not fixed
  environment: {} # non-secret, pinned values only
```

Install with pnpm (`initCommand: pnpm install`, `runCommand: pnpm dev`) and leave out the
lockfile. An `npm ci` install was slow enough to miss `runtime.start`'s acknowledgement window,
and the WebContainer's built-in pnpm is older than current pnpm, so a `pnpm-lock.yaml` written by a
newer pnpm fails with `ERR_PNPM_LOCKFILE_BREAKING_CHANGE`. Pin exact versions in `package.json`
(`"vite": "5.4.21"`, not `"^5.4.21"`) so the install stays repeatable.

`runtime.start`'s `timeoutMs` covers the whole cold start: booting the WebContainer, the
install and spawning the dev server. Size it from the slowest cold start the dependency set has
shown, not from a copied value. A first lesson in a fresh studio tab boots and installs from
nothing, and the deadline stops the render even while the install is still making progress. A
Vite-only workspace starts in well under 45 s; Vitest 5 + Vite 7 (33 packages) took up to 166 s
on a cold browser (56 s boot, 110 s install), so its lessons give `runtime.start` 300000.

`lockfilePath` is optional; when a lesson declares one, it must name a file in
`lesson.workspace.files`. The preflight
replaces the editor's ambient run configuration with these commands, disables
run-on-startup/run-on-save, runs the nonempty init command, waits for the
declared server, and fails closed on dependency, process, port, or iframe
readiness errors. `runtime.run` is never a WebContainer command (that is the
Playground path). A JavaScript/TypeScript lesson asserts browser-visible
behavior with `expect.preview`, never `expect.output`.

A `python` lesson also runs in the WebContainer, but on the built-in WASI
`python3`: a one-shot `python3 main.py` that prints to the console. WASI Python
cannot bind a socket, so a Python lesson has **no dev server and no preview** —
it omits `lockfilePath` (nothing is installed), runs via `runtime.start`, and
asserts its console output with `expect.output` (never `runtime.waitForReady`,
`preview.*`, or `expect.preview`):

```yaml
runtime:
  kind: webcontainer
  adapterVersion: 1
  defaultMode: live
  initCommand: "" # WASI python3 is built in — nothing to install
  runCommand: python3 main.py
  environment: {}
```

Go, Kotlin, Rust, Zig and Haskell remain limited to their Playground services.
Two lesson types need **no service at all**, for two different reasons. `kitec` is a Rust
program — normally a native binary you install — and Rust builds for WebAssembly
too, so Run and Format instantiate a Wasm build of that same compiler in the
page: no proxy, no rate limit, and no lesson that stops working
because a public playground is down. (Note for narration: the compiler is not
"made of" WebAssembly — Wasm is what Kite _compiles to_, and separately what
this page's build of the compiler runs as.) Its fixture `transientErrorKinds` therefore admits only
`unavailable` — a lesson cannot be throttled by something it never calls. A
Kite module is a _directory_, so sibling `.kite` files belong to the same
program and a run compiles `main.kite`.

An `asm` lesson needs no service for a plainer reason: the assembler and the
x86-64 machine are first-party TypeScript in `src/core/x86`, so Run assembles
NASM-syntax source and executes it in the page. Its fixture
`transientErrorKinds` therefore also admits only `unavailable`. There is no
linker, so a run assembles `main.asm` alone and a workspace holds exactly that
one file; structure a longer program with labels and `call`. The subset is the
assembly a person writes while learning — moves, arithmetic, the flags and the
jumps that read them, the stack, and the `read`/`write`/`brk`/`getpid`/`exit`
system calls — so a lesson that reaches for `open` or an SSE instruction gets a
clear error rather than an execution. Two things follow for authoring:

- **The console carries the register file.** After a run the runner appends the
  registers the program changed, four to a line
  (`[asm-run] rax=0x3c  rdi=0x1`), because an assembly lesson is usually about
  them. A fixture that pins `registers` replays those lines; one that omits the
  field replays none. Pin them when the narration points at a register.
- **The exit status is always printed** (`[asm-run] Program exited with status
  0`), because a program that exits non-zero has said something.

A fixture holds **exactly one** of `result` or `results`:

- `result` — one result that **every** `runtime.run` replays. Use it when the
  lesson runs once, or runs the same program again.
- `results` — a map from each `runtime.run` action's **id** to that run's
  result, for a lesson that runs, changes the code, and runs again. Every
  `runtime.run` in the script needs an entry, and every key must be the id of a
  `runtime.run`; anything else is a validation error naming the id. Each entry
  has the same per-kind shape as `result`, works for every Playground kind, and
  is held to the same runner contract.

```yaml
runtime:
  kind: go-playground
  defaultMode: fixture
  fixture:
    latencyMs: 600
    results:
      run-1: # the pinned program
        { status: success, exitCode: 0, output: "Menu:\ntea 1500\n" }
      run-2: # after the editor.type that adds the coffee line
        { status: success, exitCode: 0, output: "Menu:\ntea 1500\ncoffee 2000\n" }
      run-3: # after the insertion that calls an undefined function
        status: compile-error
        output: ""
        compileErrors: "./main.go:8:2: undefined: printTotal\n"
```

A run pinned to a failure (`compile-error`, `vet-error`, `runtime-error`, an
asm `assemble-error`) is a run the lesson shows on purpose: the render accepts
it when the run ends with exactly that status, and `runtime.noErrors` skips
exactly that run's pinned error lines (any other error line still fails it). A
live run must end with the pinned status too — a clean run where the lesson
pins a compile error fails the render, as does the reverse.

Per-kind fixture result shapes (`result`, or each `results` entry; all fields exact program truth):

- `go-playground` — `{ status: success | compile-error | vet-error | runtime-error, output, exitCode?, compileErrors?, vetErrors? }`
- `kotlin-playground` — `{ status: success | compile-error | runtime-error, output, compileErrors?, warnings?, exception? }`
- `rust-playground` — `{ status: success | compile-error | runtime-error, stdout, stderr, compileErrors?, exitDetail? }`
- `zig-playground` — `{ status: success | compile-error | runtime-error, output, compileErrors?, exitDetail? }`
  (one `output` field, not two: zig-play.dev merges the program's stdout and
  stderr into a single stream, and `std.debug.print` — the first thing every
  Zig program uses — writes to stderr)
- `haskell-playground` — `{ status: success | compile-error | runtime-error, stdout, stderr, compileErrors?, warnings?, exitDetail? }`
  (three channels, not two: GHC reports its compiler diagnostics separately
  from the program's own stdout and stderr, so a module that compiled with
  warnings and then printed something has all three at once — which is why
  `warnings` on a **successful** run is its own field rather than something
  folded into `stderr`)
- `kite-playground` — `{ status: success | compile-error | runtime-error, stdout, stderr, compileErrors?, exitDetail? }`
- `asm-playground` — `{ status: success | assemble-error | runtime-error, stdout, stderr, exitCode?, assembleErrors?, exitDetail?, instructions?, registers?, flags? }`
  (`assemble-error`, not `compile-error` — nothing is compiled; `registers` is a
  list of `{ name, value }` with `value` a **decimal string**, because a 64-bit
  value does not survive JSON as a number)

Language formatting rules carry over from the real editors: Go files use tabs;
Kotlin, Rust, and Zig use 4-space indentation, Haskell 2-space. Rust
workspaces must contain **exactly one file, `main.rs`** (the Rust Playground
executes a single crate root), Zig workspaces **exactly one file, `main.zig`**
(there is no `build.zig` and no way to import a sibling file — structure a
longer program with structs and functions), Haskell workspaces **exactly one
file, `Main.hs`** (the playground compiles a single module named `Main`; there
is no cabal file and no package manager), and `asm` workspaces **exactly one
file, `main.asm`** (there is no linker); Go and Kotlin workspaces need at least
one `.go` / `.kt` file. Assembly uses NASM syntax, four-space indentation, and
`;` for comments.

Zig scripts must target **Zig 0.16** specifically, which is the version the
playground is pinned to. Zig breaks APIs between minor releases, so code copied
from an older tutorial usually does not compile: in 0.16 `std.ArrayList` is
unmanaged (`.empty`, with the allocator passed to `append`/`deinit` rather than
`init`), the general-purpose allocator is `std.heap.DebugAllocator(.{})`, and
`std.fs.File` has moved to `std.Io.File`.

Haskell scripts target **GHC 9.12.4**, the version the playground is pinned to,
and can import only the boot packages that ship with that compiler — in
practice `base`, `containers`, and `text`. There is no package manager, so a
lesson that reaches for a Hackage library simply does not build; write it
against the boot packages instead. The program's stdin is empty, so
`getContents` returns `""` and a lesson has to supply its own data as literals.
There is also **no formatter**: play.haskell.org exposes no format endpoint, so
a Haskell lesson has no Format button and no Format action — the two-space
indentation you type is the indentation the viewer sees, so keep it consistent
by hand.

### Scenes, narration, and marks

```yaml
scenes:
  - id: unique-scene-id
    chapter: Borrowing a value # optional: titles the chapter this scene starts
    narration: >
      Prose the voice speaks. [[mark:do-it]] More prose after the anchor.
    sources: # ≥1 per scene or the critic flags it
      - { title: "…", url: "https://…" }
    actions: […]
```

`chapter` (optional, ≤120 characters) starts a chapter at the scene's first
spoken word — except on the lesson's first scene, whose chapter starts at 0:00
so the opening seconds already belong to it. Viewers see the chapters as notches
on the progress bar and in the player's chapter list, and can link to them; a
scene without one continues the chapter before it. Title the few scenes where
the lesson turns to a new idea, not every one.

Marker rules:

- `[[mark:name]]` — kebab/alphanumeric names, **globally unique** across all
  scenes, removed before synthesis and captions.
- A mark anchors to the word that follows it. Place a mark exactly where the
  related action should begin. Marks at sentence boundaries sound best (each
  inter-mark span is synthesized as one utterance).
- For Burmese narration with AthanLab, place each `[[mark:…]]` at the end of a
  sentence (after `။`, `!`, or `?`) for the most natural AthanLab intonation.
  Each dialog is its own AthanLab job, and Studio adds `။` to a dialog that
  does not already end in `။`, `!`, `?`, `.`, or `၊` — so a mark in the middle
  of a sentence makes the voice finish the first part like a whole sentence.
  When a mark has to sit inside a sentence, put it right after a `၊` pause.
  Studio also removes quotation marks and brackets from the text it sends and
  turns `…` into a `၊` pause; the captions keep your text as written.
- Every mark referenced by an action must exist. A mark no action references
  is fine: it still splits the dialog there and buys a breath. The critic's
  `marker.unused` note fires only for a mark that splits nothing (at the start
  or end of its scene, or at the same word as another split).

Narration is also the caption text — write it clean (the persona guide's
banned-phrase and conversational-register rules apply; the critic flags them
as advisory notes).

### Actions

Common fields: `id` (globally unique), `at` (anchor), optional `timeoutMs`
(default 10000; the command must acknowledge within it).

Anchors (`at`) — narration-relative only, never absolute times. An anchor names
**exactly one** of `scene`, `mark`, or `afterAction`; `offsetMs` is allowed only
on `scene` and `mark` anchors:

- `{ mark: name }` or `{ mark: name, offsetMs: -400 }` — at a mark, optionally
  shifted (negative = start before the words are spoken; small values only).
- `{ scene: start }` (optionally with `offsetMs`) — at the scene's first spoken
  word.
- `{ afterAction: other-id }` — after that action completes (use for
  `expect.*` gates that follow `runtime.run` or Python's `runtime.start`).

`expect.preview` inspects once per attempt: a missing target fails that attempt
at once, so its `retry` is the only wait (`timeoutMs` only bounds the whole
loop). After an edit, the preview needs time to rebuild, so the first check
chained after the edit gets a retry window that covers the rebuild. A
`line-by-line` or keystroke edit can rebuild after every line, so that first
check must test something only the edit's **last** line produces. If it can
pass on an earlier line's run, every later check in the chain gets the same
wide window. AI course lesson 19 checked its label (line 1) first, then gave
the opt-out button (line 3) two tries 300 ms apart, and a studio workflow
missed it.

Action catalog:

| type                   | fields                                                                | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.openFile`   | `path`                                                                | Path must exist in `workspace.files`. The pointer clicks the file's row first, derived automatically (see The pointer).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `editor.type`          | `target: {file, after, occurrence}`, `text`, `cadence?`               | **Insert-only.** `after` is an exact substring of the file's _current_ content; insertion happens at the end of its `occurrence`-th match (`after: ""` = start of file). The file must already be open (`workspace.openFile` first). Typed `text` is inserted verbatim — include leading `\n` and tabs. `cadence` picks how the code appears: `natural` (default — single keystrokes with word and thinking pauses, matched to a reference human typing recording), `fast-explainer` (brisker keystrokes), `line-by-line` (incremental reveal, one line at a time, no keystrokes), `block` (whole insertion at once after a beat). Prefer `line-by-line` or `block` for longer snippets the narration only summarizes; keystroke cadences suit short, narrated-along edits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `editor.select`        | `target: {file, text, occurrence}`                                    | **Highlight, never edits.** Drag-selects the `occurrence`-th exact byte-for-byte match of `text` (same rule as `after`) to point at code the narration is explaining; the file must already be open (`workspace.openFile` first). It sets a real editor selection — so the range is highlighted — with the pointer pressing on the first character and dragging across it, reading as a mouse drag-select. The seed-derived drag time counts as busy time like typing, so narration waits for it; keep spans short and let the words explain. It only reads code that is already there — use `editor.type` to add code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `console.point`        | `target: {text, occurrence}`                                          | **Points at a line of output** while the narration reads it: the pointer moves to the `occurrence`-th console line containing `text` (one line, exact substring, matched as the console shows it — a tab is spaces to the next 8-column stop, so write the spaces, never `\t`) in the **latest run's** output and rests with its tip just past the line's last character, so the line stays readable. No click. Put one at the mark where the narration starts on each line you explain, after a run (`runtime.start` for Python) and while the dock is open. **Only the console's last 6 rows are on screen on every display**: a run's output plus its exit line, so point at the last 5 output lines at most (fewer if a line wraps). Playground lessons are checked against the console the fixture prints for the **most recent `runtime.run` before the point** in performance order (missing line, scrolled away, or a vet/compiler warning line matching first), before any narration is synthesized: a target no run prints fails when the script is parsed, and with `results` the compile step (`studio-compile-check`) checks each point against the run it really follows — a point after run 2 must match run 2's output. A point before any run is an error. Playground runtimes and console-only Python only. Its ~0.8 s travel counts as busy time like a select. |
| `runtime.run`          | —                                                                     | Runs the workspace on the lesson's playground (every `.go` file / every `.kt` file / the single `main.rs`). Playground kinds only. Give it `timeoutMs: 15000` (Rust live compiles are slow — use `30000`). Retries transient service failures once, silently. The pointer clicks the Run button first (while the dock is shut: the chevron, then Run once the dock has opened).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `runtime.start`        | `retry`                                                               | WebContainer only. Starts the exact configured init/run commands. JS/TS acknowledge after startup begins, then use `runtime.waitForReady`; console-only Python acknowledges only after its one-shot process exits cleanly. Dependency/process failures abort with runtime diagnostics. For JS/TS, other actions keep running while it installs; runtime-dependent actions (`runtime.waitForReady`, `preview.*`, `expect.preview`, `expect.output`, `console.point`, a pointer aimed into the preview, and anything anchored `afterAction` the start) wait for it to acknowledge. A Python start is the run itself, so everything after it waits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `runtime.waitForReady` | `retry`                                                               | WebContainer only. Waits for ready status, a server URL, and `expectedPort` when declared. This is signal-based; never replace it with authored sleeps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `runtime.collapseDock` | —                                                                     | Collapses the runner dock, giving the board back to the code once the output has been read. `runtime.run` re-opens it, because that is where the output is about to land, so a script that wants the dock shut _before_ the first run declares `dockStartsCollapsed: true` on its `runtime` block instead — pinned before the clock starts, so the dock is shut in frame one rather than visibly closing a few hundred milliseconds in. Use this action for the stretches after a run; an `editor.select` shuts it by itself (see The pointer). No-op if already collapsed. Any runtime kind except `none`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `preview.open`         | `mode: docked \| floating`, `retry`                                   | WebContainer only. Opens the panel, then pings the injected iframe bridge. It acknowledges only when that bridge is ready.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `preview.click`        | `target`, `retry`                                                     | Clicks one stable preview target; the pointer moves onto it and clicks first. Because clicks may have non-idempotent effects, `retry.maxAttempts` must be `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `preview.input`        | `target`, `value`, `retry`                                            | Sets the target's value and emits input/change events through the acknowledged bridge; the pointer clicks into it first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `preview.scroll`       | `target?`, `top`, `left?`, `retry`                                    | Scrolls the document or a stable target to exact coordinates; `left` defaults to `0`. A `top` past the end of the page scrolls to the end, so `5000` means "the footer" at any preview height; the QA gate accepts a recorded scroll that stopped at the page's end (the recording carries how far the page could scroll). A scroll must still move the page: one to the position it is already at fires no event, and one that falls short of the end does not match.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `preview.route`        | `route`, `retry`                                                      | Navigates to an absolute-path route such as `/done` and acknowledges the resulting location.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `preview.point`        | `target`                                                              | **Points at an element of the running app** while the narration talks about it: the pointer moves to the `data-testid` target and rests, no click. A line of something (a heading, a label, a button, a field) is pointed at from just under the middle of its words, so the words stay readable; a taller region (a card, a list, an image) in its middle. The element must be on screen: one that is hidden or scrolled out of the preview fails the render — put a `preview.scroll` before the point. After `preview.open` only. Its ~0.8 s travel counts as busy time like a select. See The pointer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expect.preview`       | `target?`, `textContains?`, `value?`, `route?`, `attribute?`, `retry` | Requires a target or route. Text/value/attribute checks require a target. A passing observation is stored in the artifact as a DOM/route checkpoint; a failure aborts and captures a diagnostic screenshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `slide.show`           | `slideId`, `maximized` (default true)                                 | `slideId` must be in `lesson.slides`. Showing a slide while another is open advances **in place** (like moving to the next slide) — do not `slide.close` between consecutive slides; close only when returning to the editor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `slide.close`          | —                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `slide.point`          | `target: {x, y}`                                                      | **Points at a spot on the slide that is showing**: `x` and `y` are fractions of the slide (0–1 from its left and top edge), so `{ x: 0.5, y: 0.5 }` is its centre. For a deck page laid out in points, divide by the page size (720 × 405 pt for the lesson template): a bullet whose text starts at (80, 190) pt and is 24 pt tall is pointed at from under its first words with `{ x: 0.2, y: 0.54 }`. The arrow's tip is its top-left corner, so aim just **below** the words, never on them. Needs a slide showing (after `slide.show`, before `slide.close`) and no whiteboard open over it. ~0.8 s busy time. See The pointer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `whiteboard.apply`     | `open?`, `maximized?`, `upsertIds: []`, `clear?`, `drawMs?`           | Ids from `lesson.whiteboardAssets`. Must open/close, clear, or upsert ≥1 asset (checked when the script is parsed). Never set `maximized: true`: lessons use the default board panel only (see Whiteboard assets). `drawMs` draws the upserts in instead of applying them at once, and `clear` wipes the board first (both under Whiteboard assets); `drawMs` must be under the action's `timeoutMs` and at most 6000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `whiteboard.point`     | `target: {assetId}`                                                   | **Points back at something already on the whiteboard**: the pointer moves to the asset and rests with its tip on the middle of the asset's bottom edge — under a label, on the lower border of a box — so nothing is covered. The asset must be on the open board at that moment (drawn by an earlier `whiteboard.apply` and not wiped by a `clear` since); otherwise the compile step fails. ~0.8 s busy time. See The pointer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `expect.output`        | `contains`, `timeoutMs`                                               | QA gate, not lesson content: waits for a console line containing the string; any `[go-run error]` / `[kotlin-run error]` / `[rust-run error]` / `[zig-run error]` / `[haskell-run error]` / `[asm-run error]` line fails it, except the pinned lines of a run the fixture pins to fail. Use with Playground runtimes after `runtime.run`, or with console-only Python after `runtime.start`; it is not a JavaScript/TypeScript preview assertion. In Playground lessons the string must be in the pinned console of the most recent `runtime.run` before it (checked like `console.point`, before any synthesis).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `expect.file`          | `path`, `contains`                                                    | Asserts the final workspace file contains the string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Every WebContainer/preview action requires an explicit bounded retry policy:
`retry: { maxAttempts: 2, delayMs: 250 }` is a reasonable readiness or
idempotent-command default. `maxAttempts` is 1–3 and `delayMs` is nonnegative.
Use exactly `maxAttempts: 1` for `preview.click`.

Preview targets have one supported shape:

```yaml
target: { by: testId, value: save-button }
```

The rendered app must own the matching `data-testid="save-button"`. CSS
selectors, text guesses, XPath, coordinates, and arbitrary iframe script are
not authoring surfaces. The Studio injects a versioned `postMessage` bridge
into WebContainer HTML and requires an acknowledgement for every command.

Critical `editor.type` discipline:

- Compute `after` against the file content **as it will be at that moment**
  (pinned content plus any earlier insertions in the same file).
- `occurrence` defaults to 1, so the first exact match wins; an anchor that
  repeats in the file is not an error. Add context to `after` or set
  `occurrence` to pick a later match.
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

`editor.select` discipline — pointing at code the narration explains:

- `text` follows the same exact-match rule as `after`: a byte-for-byte
  substring of the file **as it is at that moment** (tabs `\t`, newlines `\n`),
  with `occurrence` disambiguating repeats. Prefer double-quoted YAML strings.
- Include the newlines to sweep whole lines; name just the token the concept
  hinges on to point tighter (`(int, error)`, `&owner`, `?`).
- It never edits — there is no code change, only a highlight. Open the file
  first, and use it on code that already exists (pinned, or typed by an earlier
  `editor.type`).
- The drag counts as busy time like typing, so a long span can push narration.
  Keep selections short; pair every one with narration that names what is
  highlighted.
- It performs as a hand, not a flash — modelled on a real recording of a person
  selecting code. A button-held pointer sweeps from the first character to the
  last, and the highlight is whatever sits under it, so it **grows with the
  pointer** (it never snaps to full width): on one line it grows character by
  character, and across lines it grows **line by line** as the pointer crosses
  each line — never a per-character crawl down a block. If the range is
  off-screen the editor first scrolls it into view smoothly, so a select can
  point at code anywhere in the file. You author none of this — just the target.
- After the sweep the selection **rests**, highlighted, for as long as the
  narration keeps talking about it; the next `editor.select` or `editor.type`
  moves it. Time the `at` mark so the highlight lands just as the words name the
  code, then let it sit — don't chase every clause with a new select.

### The pointer

The pointer does two jobs, and it never moves for any other reason: it
**operates the app** the way a hand would, and it **shows the learner where to
look** while the narration explains something. The first you never author; the
second is four small actions you place at the words they belong to. Its motion
is modelled on recorded people — straight strokes that leave and land at rest,
timed by distance, a short rest before every press.

**Derived for you — operating the app**

- **Clicks.** Before `workspace.openFile` (the file's row — none when the file
  is already showing or the explorer starts shut), `runtime.run` (the Run
  button; while the dock is shut it clicks the dock's chevron, the dock opens,
  and then it presses Run — with less than ~1.1 s clear it clicks only the
  chevron and warns), `runtime.collapseDock`
  (the chevron — Playground runtimes only, and none when the dock is already
  shut; a WebContainer dock collapses without a click) and `preview.click` /
  `preview.input` (the element), the pointer moves onto the control, rests a
  beat and clicks 80 ms before the action fires.
- **The dock shuts before a select.** How much of the editor the open runner
  dock covers depends on the viewer's screen, so code that is clear of it on
  one display sits under it on a shorter one. The Director therefore shuts an
  open dock at the instant of every `editor.select` (the chevron click on a
  Playground runtime, no click on a WebContainer), and only `console.point`
  ever points inside the dock. You don't author this; author a
  `runtime.collapseDock` yourself only to shut the dock earlier, where the
  narration leaves the output. A `console.point` after the select needs a new
  run first.
- A click needs at least **550 ms** clear before its action: after the previous
  action's start (of any type) and after any typing, select drag, point or
  whiteboard drawing ends, whichever is later. With less, the Director skips
  the click and warns; the action itself still runs.
- A click on a preview element is skipped, never failed, when the element is
  not on screen yet (not mounted, hidden, or scrolled out of view) — the
  authored `preview.click` / `preview.input` stays the check that counts. Guard
  interactions that follow asynchronous UI with an `expect.preview` first.
- **Drags.** `editor.select` is its own gesture: press on the first character,
  sweep, release, rest (above).
- **The pen.** While a `whiteboard.apply` draws its assets in (`drawMs`), the
  pointer is the hand that draws them: it drags a shape out from its corner,
  traces a stroke, writes text along its line, and rests where the pen lifts
  (see Drawing a diagram in). You author only the apply.

**Authored by you — showing where to look**

A learner who hears "this value here" with nothing on screen moving has no clue
which value is meant. Whenever the narration refers to a particular thing on
screen, point at it, with the point at the mark where the words about it begin:

| the narration talks about…          | action             | target                                         |
| ----------------------------------- | ------------------ | ---------------------------------------------- |
| code in the editor                  | `editor.select`    | the exact text (it is highlighted, not edited) |
| a line the program printed          | `console.point`    | `{ text, occurrence }`                         |
| something in the running app        | `preview.point`    | `{ by: testId, value }`                        |
| a part of the slide on screen       | `slide.point`      | `{ x, y }` — fractions of the slide            |
| something already on the whiteboard | `whiteboard.point` | `{ assetId }`                                  |

```yaml
- id: point-total
  type: preview.point
  at: { mark: total }
  target: { by: testId, value: cart-total }
- id: point-second-bullet
  type: slide.point
  at: { mark: second-reason }
  target: { x: 0.2, y: 0.54 }
- id: point-heap
  type: whiteboard.point
  at: { mark: back-to-heap }
  target: { assetId: heap-box }
```

- A point is travel and a rest: no click, no highlight. The pointer stays on
  the thing until the next gesture, so it marks the subject for as long as the
  narration stays on it.
- **Point at the thing, once.** One point per thing explained, at the start of
  the words about it ("the first line shows…", "then…", "this button…"). Do not
  chase every clause, and never point at something just to keep the pointer
  moving — a point with no words about its target is noise.
- **Nothing is covered.** The arrow's tip is its top-left corner and its body
  hangs down and to the right. `console.point` rests just past the end of the
  line; `preview.point` and `whiteboard.point` rest just under the middle of
  the words or on the lower edge of the box; for `slide.point` you choose the
  spot, so choose one just **below** the words, not on them.
- **Where the thing must be.** A point at something the viewer cannot see
  fails: a `console.point` needs the latest run's line on screen with the dock
  open, a `preview.point` an element that is mounted and in view (scroll
  first), a `slide.point` a slide showing with no whiteboard over it, a
  `whiteboard.point` an asset on the open board. The compile step catches the
  last two and a point before any run or `preview.open`; the rest fail the
  render with a message that names the fix.
- **On the whiteboard, point back — not forward.** The pen already leads the
  eye to what is being drawn. Use `whiteboard.point` when the narration returns
  to something drawn earlier ("remember this box", "compare it with the one on
  the left"), and a `freedraw` stroke (`circle`, `underline`) when the emphasis
  should stay on the board after the pointer has moved on.
- The recorded pointer keeps to the thing itself, not a pixel spot: a console
  line, a point of the whiteboard's drawing, a fraction of the slide or the
  preview. A viewer whose console fits more rows, whose board is a different
  size, or who pans the board still sees it on the right thing.
- Each point's ~0.8 s travel counts as busy time, like a select: leave that
  much before the next action's mark.

**Hands off the mouse**

- The pointer hides while `editor.type` runs, when a slide or the whiteboard
  opens over what it rested on, when a slide or the board it rested on closes,
  and when the board changes without the pen (an apply with no `drawMs`, or a
  `clear`). It reappears exactly where its next gesture starts — it never
  travels in from a stale spot.
- **Between gestures.** Playback carries a resting pointer straight to its next
  gesture and lets it settle there briefly before it presses.

### The fixture must be the truth

The fixture result's program output (`output` for Go/Kotlin/Zig, `stdout` for
Rust, Haskell, Kite, and asm) must be **exactly** what the real program prints
(every line, `\n`-terminated). Two reasons: `expect.output` runs against it in
fixture mode, and a later `--runtime=live` render runs the real Playground —
if your pinned program and fixture disagree, live renders fail. Mentally
execute the final code (pinned files + your insertions) and transcribe its
output.

With `results`, each entry is the truth **at that run**: the pinned files plus
every insertion performed before that `runtime.run`, and nothing after it. A
compile or vet error is pinned with the runner's exact text — the Go
Playground reports `./<file>:<line>:<col>: <message>` per line — so get it from
the real toolchain, never from memory.

For WebContainer lessons, the pinned workspace is the truth instead of a
synthetic result. Pin `package.json` (exact versions), every source
file, the exact init/run commands, expected port, and non-secret environment.
The rendered application must expose stable `data-testid` targets for every
authored interaction or DOM assertion.

Preview plans receive additional blocking artifact gates. The encoded `.ne`
must contain a preview track, bounded and monotonic preview events, an rrweb
Meta + FullSnapshot seed, mutation patches when interactions occur, the
authored interaction sequence in order, and a recorded checkpoint for every
`expect.preview`. Preview console errors, uncaught exceptions, unhandled
rejections, runtime failures, missing targets, wrong routes/DOM, or absent
replay data fail the render. Repeatability compares normalized preview routes,
checkpoints, and authored interactions rather than timestamps.

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
SVG into the plan. Deck page ids resolve during that render build (a mismatch
lists the valid ids); the Director CLI also fetches each deck as a
best-effort early check (an unreachable deck is only a warning):

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

A slide is a picture to the studio — its words are not text it can find — so a
`slide.point` names a spot, not a phrase: `target: { x, y }` as fractions of the
slide. Read the spot off the deck's own layout (a 720 × 405 pt page: `x = pt /
720`, `y = pt / 405`) and aim just below the words the narration is on. One
point per bullet as the narration reaches it turns a slide the learner has to
read alone into one that is read to them.

A fraction only names the same spot on every screen when the slide scales with
its box, as a deck page does. An `html` slide does if you lay it out in `vw`
and `vh` (its frame is the slide's box, so `1vw` is 1% of the slide's width):
give it one full-frame element (`width: 100vw; height: 100vh`), place each
line absolutely with `left`/`top` in `vw`/`vh`, and size the text in `vw`. The
target then reads straight off the CSS: for a word that starts `13vw` from the
left on a line at `top: 36vh; height: 10vh`, `{ x: 0.16, y: 0.45 }` rests a
little inside the word, just under its text.
Sizes in `px` or `rem`, or content left to the frame's default centring, put
the words somewhere else on a smaller screen than where you measured them. A
`markdown` slide is laid out that way — its text keeps its size while the
slide shrinks — so do not point at one; write the slide as `html` instead
(compile-check warns).

Deck SVGs embed font data, and painting them briefly stalls the render's
main thread at each show/close — actions scheduled right next to a
`slide.show`/`slide.close` can start ~0.4s late. For deck-slide lessons a
`timing.p95Ms` of `500` (instead of the default `300`) is acceptable; keep
`300` for lessons without deck slides.

### Whiteboard assets

```yaml
whiteboardAssets:
  - { id: box, kind: rectangle, x: 320, y: 200, width: 420, height: 150, strokeColor: "#1971c2" }
  - {
      id: label,
      kind: text,
      x: 350,
      y: 250,
      width: 360,
      height: 40,
      text: "value × value × value",
      strokeColor: "#1e1e1e",
      fontSize: 28,
    }
```

Kinds: `rectangle`, `ellipse`, `diamond`, `text`, `freedraw`. Coordinates are
canvas pixels; keep content roughly within (250,150)–(1100,650) so it is visible
unzoomed.

Never put the board in full-screen mode: leave `maximized` out of every
`whiteboard.apply`. The default panel opens the board over the lesson with the
editor dimmed around it, which is the only board lessons use; a maximized
board fills the whole screen edge to edge and looks bad in the recorded lesson.

The board renders in Excalidraw's dark theme, which inverts colours:
`strokeColor` defaults to `#1e1e1e` (paints white) and `fontSize` to `28`, the
smallest label that stays readable in the recorded lesson. Never author a pale
or near-white colour such as `#e2e8f0` — it paints near-black and all but
vanishes on the dark canvas. For colour, use Excalidraw's mid-tone palette —
`#1971c2` blue, `#f08c00` orange, `#2f9e44` green, `#e03131` red, `#6741d9`
violet — which inverts to legible pastels, and give each colour a job: a board
whose shapes all share one colour reads flat.

A `freedraw` asset is a hand-drawn annotation stroke generated inside its box.
Pick one with `stroke` and size the box around whatever it annotates:

| `stroke`                                                                 | what it draws in the box                                                                                               | use it for                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `underline`, `double-underline`, `wavy`                                  | a line along the bottom edge — single, there-and-back, or a squiggle                                                   | the term being named; the key one; the one that is wrong   |
| `strike`, `scribble`                                                     | a line through the middle; a fast zigzag across the whole box                                                          | "not this"; crossed out for good                           |
| `circle`, `box`                                                          | an ellipse inscribed in the box; a loose hand-drawn frame around it                                                    | one thing singled out; several things that belong together |
| `check`                                                                  | a tick filling the box                                                                                                 | done, correct                                              |
| `arrow-right`, `arrow-left`, `arrow-up`, `arrow-down`                    | a straight arrow along the middle of the box, tip in the named direction                                               | a step, a flow, "becomes"                                  |
| `arrow-up-right`, `arrow-down-right`, `arrow-up-left`, `arrow-down-left` | an arrow across the box's diagonal, tip in the named corner                                                            | linking things that are not on one row or column           |
| `arrow-arc-right`                                                        | an arrow that leaves the bottom-left corner, bows up to the top edge and lands on the bottom-right corner              | hopping over what lies between two things                  |
| `arrow-arc-left`                                                         | an arrow that leaves the top-right corner, dips to the bottom edge and lands on the top-left corner                    | going back: a loop, a retry, a return value                |
| `brace-right`, `brace-left`, `brace-up`, `brace-down`                    | a curly brace spanning the box; its point faces the named direction, so the things it gathers are on the opposite side | "these three together are one X"                           |

Strokes always use the thin pen (stroke width 1, not an authorable field) —
freedraw renders heavier than a shape outline at the same width, and anything
thicker reads as a marker blob over the diagram:

```yaml
- { id: circle-owner, kind: freedraw, stroke: circle, x: 340, y: 280, width: 240, height: 90 }
- { id: back-edge, kind: freedraw, stroke: arrow-arc-left, x: 360, y: 430, width: 380, height: 70 }
- { id: three-fields, kind: freedraw, stroke: brace-right, x: 720, y: 220, width: 36, height: 210 }
```

Shapes and text take a few optional style fields. Each has one job — use it
for that job across the lesson, the way colour is used, and leave it out
otherwise:

| field                                             | applies to                        | default | use it for                                                                                                                                                                                                              |
| ------------------------------------------------- | --------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rounded: true`                                   | `rectangle`, `diamond`            | `false` | a card or a node that stands alone. Keep the default square corners for boxes drawn edge to edge — array cells, stack frames, table rows — which must meet squarely.                                                    |
| `strokeStyle: dashed` (or `dotted`)               | `rectangle`, `ellipse`, `diamond` | `solid` | something that is not real yet: a planned step, an optional part, a boundary or a scope rather than a thing.                                                                                                            |
| `fillStyle: hachure` (or `cross-hatch`, `zigzag`) | shapes with a `backgroundColor`   | `solid` | the one box the board is about. A sketched fill keeps a label inside the shape readable; `solid` is a flat block of colour. Fill colours invert like ink: author mid-tones (`#a5d8ff`, `#b2f2bb`, `#ffec99`).           |
| `align: center` (or `right`)                      | `text`                            | `left`  | a label inside a shape: give the text the shape's `x` and `width` and it is centred in the shape however wide its glyphs turn out — no guessing its width. Set `y` to the shape's `y + (height − fontSize × 1.25) / 2`. |

```yaml
- {
    id: node,
    kind: rectangle,
    x: 320,
    y: 200,
    width: 260,
    height: 90,
    rounded: true,
    strokeColor: "#1971c2",
  }
- {
    id: node-label,
    kind: text,
    align: center,
    x: 320,
    y: 227,
    width: 260,
    height: 36,
    text: "Scheduler",
  }
- {
    id: later,
    kind: rectangle,
    x: 640,
    y: 200,
    width: 260,
    height: 90,
    rounded: true,
    strokeStyle: dashed,
    strokeColor: "#f08c00",
  }
- { id: choice, kind: diamond, x: 420, y: 360, width: 200, height: 120, strokeColor: "#6741d9" }
```

### Drawing a diagram in

By default an apply puts its assets on the board in a single frame. `drawMs`
spends a budget drawing them instead, the way a presenter would:

```yaml
- id: show-vec
  type: whiteboard.apply
  at: { mark: show-vec }
  upsertIds: [vec-box0, vec-box1, vec-box2]
  drawMs: 900
```

The assets are drawn **one after another**, sharing the budget — nine ids and
`drawMs: 900` is a 100 ms stagger, not nine boxes at once. Within an asset,
shapes grow from their top-left corner, text types in a character at a time,
and a `freedraw` stroke traces point by point. The recorded lesson interpolates
between the recorded steps, so playback is smooth even though the live render
you watch in Chrome steps at 20 fps.

**The pointer is the pen.** When each asset gets at least **300 ms** of the
budget (`drawMs ÷ number of ids ≥ 300`), the pointer draws: it presses on the
shape's corner and drags it out, traces the stroke with the button held, and
moves along the line as text is written, at a hand's pace — quick off the
mark, slowing onto the end. Between two assets of the same apply it takes
150 ms of the second one's share to get there. When the apply ends it rests
where the pen lifted, and it stays there until the next gesture. With less
than 300 ms an asset the board is being filled in rather than drawn, and the
pointer stays out of it.

So budget for the hand: `drawMs: 1200` for two or three assets, `1800`–`2400`
for four to six. To put a whole finished diagram up at once, leave `drawMs`
out — then nothing is drawn and no pointer appears.

Use it for the diagram the narration is actively building — the box being
introduced, the arrow being drawn, the term being circled. A `drawMs` on
scene-setting furniture (a title, a legend, a board that is merely re-opened)
only makes the lesson wait. The budget is also busy time: the actions after it
are planned that much later, so keep it inside the narration beat it belongs to.

### More than one board

An apply only ever **adds**, and closing the panel keeps every element in the
scene — so a second diagram authored over the first one's coordinates draws on
top of it. Two ways to show a second diagram:

- `clear: true` wipes the board, then draws this action's assets onto the empty
  canvas. Use it when the lesson moves to a new topic.
- Lay the second diagram out in free canvas space and let the board accumulate.
  Use it when the new drawing extends the old one — an arrow leaving a box the
  viewer already saw reads better than a box redrawn from nothing.

`clear` never removes an id the same action upserts, so re-drawing one element
of the previous board while wiping the rest works.

### Opening the preview

`preview.open` acknowledges once the app has loaded in the panel, and that
first load takes two to five seconds — not the same twice. The actions you
chain after it with `afterAction` (the `expect.preview` checks, a
`runtime.collapseDock`) wait for it by design, and neither the timing gate nor
the repeatability comparison holds their start against them. The next action
the narration times is different: planned sooner than the load can finish, it
starts late, and the words run ahead of the screen in one render and not in
the next.

So open the preview where the narration leaves it room: at least 5 seconds
before the next action anchored to a mark. The end of the scene before the one
that uses the preview is a good place — as a whiteboard closes, or over the
sentence that turns to the code — rather than the first mark of the scene whose
first highlight follows a moment later. `studio-compile-check` warns when the
room is under 5 seconds.

### Preview focus

Focus that a `preview.click` gave an element in the preview does not last
through anything that takes keyboard focus into the studio itself:

- `editor.type` and `editor.select` focus the code editor, and Chrome then
  resets the (cross-origin) preview's focused element to its page.
- A maximized `slide.show` or a `whiteboard.apply` with `open: true` makes the
  editor and preview inert, the way a modal dialog should, which blurs the
  preview's focused element; closing the overlay returns focus to the studio's
  own controls, not to the preview.

So assert and narrate a focused element before any of those, or focus it again
with another `preview.click` after them. A Tab-like step that moves on from the
focused element starts from the top of the page afterwards. `studio-verify-lesson`
clears preview focus at the same moments, so it catches a lesson that leans on
focus surviving one.

## Editorial requirements (summary — full text in studio-persona.md)

- **Pick a shape**: one concept taught and run (usually 20–100 seconds), or a
  survey that tours many. Neither narration length nor scene count is capped,
  and the critic does not flag either.
- Short sentences read better out loud, but no length is flagged. No filler:
  _simply, obviously, easy, delve, in this video, don't worry_ etc. are flagged.
- Every scene cites ≥1 source (official docs/spec/tour URLs preferred).
- Narrate _why_; the typed code shows _what_. No fake mistakes.
- The critic (`✎` lines from the director) is advisory — address the notes or
  consciously keep the text, but never ignore a `sources.missing`.

## Failure → fix table

| Symptom                                         | Fix                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid lesson script: …`                      | Schema violation (including an unknown or misspelled key); the path in the message names the field.                                                                                                                                               |
| `Unknown marker "x" — known markers: …`         | An action references a mark not present in narration.                                                                                                                                                                                             |
| `Typing action "…" overlaps "…"` (compile)      | Two authored actions collide; move the later mark or add `offsetMs`.                                                                                                                                                                              |
| `⚠ …ms of silence inserted before dialog …`     | Your action outlasts the narration around it; add a sentence there or shorten the typed text.                                                                                                                                                     |
| `… ran to the speech engine's length limit …`   | A sentence hit Pocket's ~40s cap unended; reword or split it (the warning repeats until it changes).                                                                                                                                              |
| `Narration dialog N/M "…" ("…"): …`             | That dialog's synthesis failed or its audio is unusable; Burmese errors carry the provider's reason.                                                                                                                                              |
| `… needs Burmese narration …` (or the reverse)  | The narration select and the script's `locale` disagree; choose the matching provider (it never translates).                                                                                                                                      |
| `AthanLab: …` asking you to connect your key    | The saved key is missing, expired, revoked, or can no longer be read; connect a new key in the AthanLab panel.                                                                                                                                    |
| Other `AthanLab: …` errors                      | AthanLab's own reason (for example, no characters left); fix it on AthanLab, then render again (see below).                                                                                                                                       |
| `… stays N dB quieter than the rest …`          | Too quiet or too peaky for leveling to match the others; listen, and reword that dialog for a new take.                                                                                                                                           |
| `Anchor occurrence N of "…" not found` (render) | The `after` string doesn't match the file at perform time — check tabs/newlines and earlier insertions.                                                                                                                                           |
| `checkpoint.output.… never contains …`          | Fixture output and `expect.output` disagree, or the program doesn't print it.                                                                                                                                                                     |
| `runtime.waitForReady` times out                | Check the pinned install/run commands, package versions, expected port, and server diagnostics in the receipt.                                                                                                                                    |
| `Preview … command failed`                      | The iframe bridge did not acknowledge, the target's `data-testid` is missing, or the preview crashed.                                                                                                                                             |
| `checkpoint.preview.…` failure                  | The recorded route/DOM differs from `expect.preview`; inspect the attached diagnostic screenshot.                                                                                                                                                 |
| `preview.replayData` failure                    | The artifact lacks an rrweb seed or the mutation patches required for the authored interactions.                                                                                                                                                  |
| `timing.p95 — … (max 300ms)` failure            | Usually a squeezed action; check the receipts in the render report for the late action.                                                                                                                                                           |
| Repeatability FAIL on `repeat.actionTiming`     | The detail names the action that started at different times. If it follows a `preview.open`, the preview loaded slower in one render: open the preview earlier (see Opening the preview). Otherwise find what ran long before it in the receipts. |
| Repeatability FAIL on `repeat.audio`            | Pocket-TTS and VoxCPM2 are seeded: report it as a bug. AthanLab takes are not seeded — they replay from the browser cache or AthanLab's 24 h idempotent job (see below).                                                                          |

**Rendering again with AthanLab.** Dialogs AthanLab has already finished stay
in this browser's dialog cache, so a new render pays only for the dialogs that
are missing. AthanLab takes are not seeded: when the same account asks for
the same dialog text and voice within 24 hours, AthanLab returns its original
job (its idempotent job) without a new charge — which also picks up a dialog
AthanLab was still generating when the last render stopped. A `repeat.audio`
FAIL with AthanLab therefore means neither the cache nor that job had the
take, for example after the browser cache was cleared more than 24 hours after
the first render; render both runs again.

## A complete example

`src/studio/scripts/rust-borrow.yaml` is the canonical example: eleven scenes,
published-deck slides, keystroke and line-by-line typing, run + gates. Its narration
is Burmese (it is lesson 7 of the Burmese Rust from zero course): copy its structure,
and write English narration by studio-persona.md. Smaller historical
pilots (Go, incl. whiteboard + retry-fixture usage) live as test fixtures
under `src/studio/script/__fixtures__/`.

JavaScript/TypeScript regression fixtures live beside those pilots:
[`javascript-minimal.yaml`](../src/studio/script/__fixtures__/javascript-minimal.yaml)
checks the required JavaScript contract, while
[`typescript-vite-preview.yaml`](../src/studio/script/__fixtures__/typescript-vite-preview.yaml)
is the preview qualification case. Import the latter into `/studio` for its
two clean real-Chrome renders. Compilation or headless CI alone does not lift
the release-candidate gate; record both repeatability passes and complete the
human replay review first.
