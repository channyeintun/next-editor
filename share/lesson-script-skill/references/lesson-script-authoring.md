# LessonScript Authoring Contract

The complete, self-contained specification for writing studio lesson scripts.
Written for any agent (Claude, Codex, Cursor, …) as much as for humans:
following this document end-to-end produces a lesson that compiles, renders
unattended, and passes every mechanical gate. The editorial rules live in
[studio-persona.md](./studio-persona.md). No repository or CLI is needed —
https://nexteditor.dev/studio is the whole toolchain.

## Contents

- [What you are producing](#what-you-are-producing)
- [The mental model](#the-mental-model-read-this-before-writing)
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
browser at render time: open https://nexteditor.dev/studio, click
**Import…**, and pick the file — it is validated and critiqued in the page.

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

## Workflow

**Users (production website)** need no tooling at all: open `/studio`, pick a
lesson from the dropdown (or **Import…** a YAML file — validated and
critiqued in the page), press **Start render**, watch, and **Create draft…**
(sign-in required for drafts; publishing stays a separate human action).

Users can also provide a narrator reference: the voice row offers **Record**
(microphone) or an audio-file picker. The prepared sample is stored in the
browser (IndexedDB). English Pocket-TTS cloning accepts 2–20s and stays
entirely local. Burmese VoxCPM2 renders require a selected 5–20s reference and
send it transiently through the authenticated Worker to the private Modal
function for every uncached dialog; neither service persists it. Reusing that
reference keeps one speaker across the render. Scripts keep pinning built-in
profiles in `build.voiceProfile` — reference selection is a render-time choice,
and the draft description records the selected voice name.

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

**Workflow for authors and agents**:

```text
1. Write   <slug>.yaml            # anywhere on disk; the YAML is the artifact
2. Import  nexteditor.dev/studio  # Import… validates + critiques in the page
   → fix every schema/marker error; fix critic notes of the kinds
     sources.missing, banned phrases, and register.read-aloud
3. Render  press Start render, watch the performance,
           confirm "Checks (N/N ok)" in the panel
4. A human watches the lesson and decides on Create draft… (sign-in).
```

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
  voiceProfile: pocket-alba-v1 # the built-in narrator voice
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
  - { type: timing.p95Ms, max: 300 } # required on every script
```

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
another deterministic workspace. It must include a pinned lockfile and this
versioned runtime declaration (commands are exact strings and never inherited
from ambient editor settings):

```yaml
runtime:
  kind: webcontainer
  adapterVersion: 1
  defaultMode: live
  initCommand: pnpm install --frozen-lockfile
  runCommand: pnpm dev
  expectedPort: 5173 # optional only when the server port truly is not fixed
  lockfilePath: pnpm-lock.yaml
  environment: {} # non-secret, pinned values only
```

`lockfilePath` must name a file in `lesson.workspace.files`. The preflight
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
page: no proxy, no sign-in, no rate limit, and no lesson that stops working
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
  registers that hold something, four to a line
  (`[asm-run] rax=0x3c  rdi=0x1`), because an assembly lesson is usually about
  them. A fixture that pins `registers` replays those lines; one that omits the
  field replays none. Pin them when the narration points at a register.
- **The exit status is always printed** (`[asm-run] Program exited with status
0`), because a program that exits non-zero has said something.

Per-kind fixture `result` shapes (all fields exact program truth):

- `go-playground` — `{ status: success | compile-error | runtime-error, output, exitCode, compileErrors? }`
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
  `expect.*` gates that follow `runtime.run` or Python's `runtime.start`).

Action catalog:

| type                   | fields                                                                | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.openFile`   | `path`                                                                | Path must exist in `workspace.files`. A cursor tween to the file row is derived automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `editor.type`          | `target: {file, after, occurrence}`, `text`, `cadence?`               | **Insert-only.** `after` is an exact substring of the file's _current_ content; insertion happens at the end of its `occurrence`-th match (`after: ""` = start of file). The file must already be open (`workspace.openFile` first). Typed `text` is inserted verbatim — include leading `\n` and tabs. `cadence` picks how the code appears: `natural` (default — single keystrokes with word and thinking pauses, matched to a reference human typing recording), `fast-explainer` (brisker keystrokes), `line-by-line` (incremental reveal, one line at a time, no keystrokes), `block` (whole insertion at once after a beat). Prefer `line-by-line` or `block` for longer snippets the narration only summarizes; keystroke cadences suit short, narrated-along edits. |
| `editor.select`        | `target: {file, text, occurrence}`                                    | **Highlight, never edits.** Drag-selects the `occurrence`-th exact byte-for-byte match of `text` (same rule as `after`) to point at code the narration is explaining; the file must already be open (`workspace.openFile` first). It sets a real editor selection — so the range is highlighted — and glides the attention cursor across it, reading as a mouse drag-select. The seed-derived drag time counts as busy time like typing, so narration waits for it; keep spans short and let the words explain. It only reads code that is already there — use `editor.type` to add code.                                                                                                                                                                                   |
| `runtime.run`          | —                                                                     | Runs the workspace on the lesson's playground (every `.go` file / every `.kt` file / the single `main.rs`). Playground kinds only. Give it `timeoutMs: 15000` (Rust live compiles are slow — use `30000`). Retries transient service failures once, silently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `runtime.start`        | `retry`                                                               | WebContainer only. Starts the exact configured init/run commands. JS/TS acknowledge after startup begins, then use `runtime.waitForReady`; console-only Python acknowledges only after its one-shot process exits cleanly. Dependency/process failures abort with runtime diagnostics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `runtime.waitForReady` | `retry`                                                               | WebContainer only. Waits for ready status, a server URL, and `expectedPort` when declared. This is signal-based; never replace it with authored sleeps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `runtime.collapseDock` | —                                                                     | Collapses the runner dock, which starts expanded and otherwise stays that way for the whole render — covering the editor through every explanation. The collapse sticks: run output appends to the console without re-opening the dock, so one action early in the lesson is usually all a script needs, and a later one only matters if something expanded it again. Give the board back to the code once the output has been read. No-op if already collapsed. Any runtime kind except `none`.                                                                                                                                                                                                                                                                            |
| `preview.open`         | `mode: docked \| floating`, `retry`                                   | WebContainer only. Opens the panel, then pings the injected iframe bridge. It acknowledges only when that bridge is ready.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `preview.click`        | `target`, `retry`                                                     | Clicks one stable preview target. Because clicks may have non-idempotent effects, `retry.maxAttempts` must be `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `preview.input`        | `target`, `value`, `retry`                                            | Sets the target's value and emits input/change events through the acknowledged bridge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `preview.scroll`       | `target?`, `top`, `left?`, `retry`                                    | Scrolls the document or a stable target to exact coordinates; `left` defaults to `0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `preview.route`        | `route`, `retry`                                                      | Navigates to an absolute-path route such as `/done` and acknowledges the resulting location.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `expect.preview`       | `target?`, `textContains?`, `value?`, `route?`, `attribute?`, `retry` | Requires a target or route. Text/value/attribute checks require a target. A passing observation is stored in the artifact as a DOM/route checkpoint; a failure aborts and captures a diagnostic screenshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `slide.show`           | `slideId`, `maximized` (default true)                                 | `slideId` must be in `lesson.slides`. Showing a slide while another is open advances **in place** (like moving to the next slide) — do not `slide.close` between consecutive slides; close only when returning to the editor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `slide.close`          | —                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `whiteboard.apply`     | `open?`, `maximized?`, `upsertIds: []`, `clear?`, `drawMs?`           | Ids from `lesson.whiteboardAssets`. Must open, change maximize, clear, or upsert ≥1 asset. `drawMs` draws the upserts in instead of applying them at once, and `clear` wipes the board first (both under Whiteboard assets); `drawMs` must be under the action's `timeoutMs` and at most 6000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `expect.output`        | `contains`, `timeoutMs`                                               | QA gate, not lesson content: waits for a console line containing the string; any `[go-run error]` / `[kotlin-run error]` / `[rust-run error]` / `[zig-run error]` / `[haskell-run error]` / `[asm-run error]` line fails it. Use with Playground runtimes after `runtime.run`, or with console-only Python after `runtime.start`; it is not a JavaScript/TypeScript preview assertion.                                                                                                                                                                                                                                                                                                                                                                                      |
| `expect.file`          | `path`, `contains`                                                    | Asserts the final workspace file contains the string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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

### The fixture must be the truth

The fixture result's program output (`output` for Go/Kotlin/Zig, `stdout` for
Rust and Haskell) must be **exactly** what the real program prints (every line,
`\n`-terminated). Two reasons: `expect.output` runs against it in
fixture mode, and a later `--runtime=live` render runs the real Playground —
if your pinned program and fixture disagree, live renders fail. Mentally
execute the final code (pinned files + your insertions) and transcribe its
output.

For WebContainer lessons, the pinned workspace is the truth instead of a
synthetic result. Pin `package.json`, the declared lockfile, every source
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
SVG into the plan. Deck page ids resolve during the render build in the
page (a mismatch lists the valid ids); Import… validates the YAML, while
the deck is fetched only when the render starts:

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

Kinds: `rectangle`, `ellipse`, `text`, `freedraw`. Coordinates are canvas
pixels; keep content roughly within (250,150)–(1100,650) so it is visible
unzoomed.

A `freedraw` asset is a hand-drawn annotation stroke generated inside its box.
Pick one with `stroke`: `underline`, `strike`, `circle`, `check`,
`arrow-right`, or `arrow-down`. Size the box around whatever it annotates —
`circle` inscribes the box, `underline` runs along its bottom edge. Strokes
always use the thin pen (stroke width 1, not the authorable field) — freedraw
renders heavier than a shape outline at the same width, and anything thicker
reads as a marker blob over the diagram:

```yaml
- { id: circle-owner, kind: freedraw, stroke: circle, x: 340, y: 280, width: 240, height: 90 }
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

| Symptom                                         | Fix                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Invalid lesson script: …`                      | Schema violation; the path in the message names the field.                                              |
| `Unknown marker "x" — known markers: …`         | An action references a mark not present in narration.                                                   |
| `Typing action "…" overlaps "…"` (compile)      | Two authored actions collide; move the later mark or add `offsetMs`.                                    |
| `⚠ …ms of silence inserted before dialog …`     | Your action outlasts the narration around it; add a sentence there or shorten the typed text.           |
| `Anchor occurrence N of "…" not found` (render) | The `after` string doesn't match the file at perform time — check tabs/newlines and earlier insertions. |
| `checkpoint.output.… never contains …`          | Fixture output and `expect.output` disagree, or the program doesn't print it.                           |
| `runtime.waitForReady` times out                | Check the pinned install/run commands, lockfile, expected port, and server diagnostics in the receipt.  |
| `Preview … command failed`                      | The iframe bridge did not acknowledge, the target's `data-testid` is missing, or the preview crashed.   |
| `checkpoint.preview.…` failure                  | The recorded route/DOM differs from `expect.preview`; inspect the attached diagnostic screenshot.       |
| `preview.replayData` failure                    | The artifact lacks an rrweb seed or the mutation patches required for the authored interactions.        |
| `timing.p95 — … (max 300ms)` failure            | Usually a squeezed action; check the receipts in the render report for the late action.                 |
| Repeatability FAIL on `repeat.audio`            | Should not happen (synthesis is seeded); report it as a bug rather than working around it.              |

## A complete example

`examples/rust-borrow.yaml` (bundled beside this document) is the canonical
example: eight scenes, published-deck slides, keystroke and line-by-line
typing, run + gates, in the conversational persona register. Start from a copy
of it.
