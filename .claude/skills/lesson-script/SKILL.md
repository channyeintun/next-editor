---
name: lesson-script
description: Author a Next Editor studio lesson — a narrated, auto-performed coding lesson defined as a LessonScript YAML. Use when asked to create/write/draft a lesson, a studio script, a narrated tutorial, or to fix a failing lesson render. Covers writing the YAML, compiling with the Director, rendering headlessly, and reading the QA gates.
---

# Author a studio LessonScript

You are producing `src/studio/scripts/<slug>.yaml` — a complete narrated
coding lesson that the studio renders unattended. The full contract is in
**docs/lesson-script-authoring.md**: read it first, entirely, every time
(schema, marker/anchoring model, action catalog, fixture rules, failure
table). Editorial rules: **docs/studio-persona.md**. Canonical small example:
`src/studio/scripts/go-swap.yaml`.

## Procedure

1. **Read** `docs/lesson-script-authoring.md`, `docs/studio-persona.md`, and
   `src/studio/scripts/go-swap.yaml`.
2. **Design before writing**: one concept; the exact final code (pinned files
   - your insertions); mentally run it and transcribe the exact program
     output for the fixture; then write narration that speaks _while_ each
     action happens, placing `[[mark:…]]` where actions begin.
3. **Write** the YAML. Discipline points that break renders when sloppy:
   - `editor.type` anchors (`after`) must match file content byte-for-byte
     (tabs `\t`, newlines `\n`; use double-quoted YAML strings).
   - Insert-only edits; open a file before typing into it.
   - `fixture.result.output` = the real program's exact stdout.
   - Every scene needs a `sources` entry; keep sentences short.
   - Always include `checks: [{ type: timing.p95Ms, max: 300 }]`.
4. **Compile**: `bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml`
   - Fix every error; address `✎` critic notes (advisory, but fix
     `sources.missing` and banned phrases).
   - Scripts auto-register by filename — do not edit `src/studio/plans/index.ts`
     and never hand-edit the emitted JSON in `src/studio/plans/scripts/`.
5. **Render** (needs Chrome + network; dev server in a separate terminal):
   - `bun run dev` (background), then `bun scripts/studio-render.ts <slug>`
   - Exit 0 means both renders passed all gates and repeatability. On failure,
     read `studio-out/<slug>-*/run-*-report.json` (receipts name the failing
     action) and the failure table in the authoring doc.
   - If the environment cannot run a browser, stop after step 4 and say the
     render is pending.
6. **Report**: slug, narration length, actions used, critic notes kept vs
   fixed, render/gate results. A human reviews the lesson before any draft is
   created — never call the lesson done, only rendered.
