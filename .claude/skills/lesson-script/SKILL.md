---
name: lesson-script
description: Author a Next Editor studio lesson — a narrated, auto-performed coding lesson defined as a LessonScript YAML. Use when asked to create/write/draft a lesson, a studio script, a narrated tutorial, or to fix a failing lesson render. Covers writing the YAML, compiling with the Director, verifying the render in Chrome, and reading the QA gates.
---

# Author a studio LessonScript

You are producing `src/studio/scripts/<slug>.yaml` — a complete narrated
coding lesson that the studio renders unattended. The full contract is in
**docs/lesson-script-authoring.md**: read it first, entirely, every time
(schema, marker/anchoring model, action catalog, fixture rules, failure
table). Editorial rules: **docs/studio-persona.md**. Canonical small example:
`src/studio/scripts/rust-borrow.yaml`.

## Procedure

1. **Read** `docs/lesson-script-authoring.md`, `docs/studio-persona.md`, and
   `src/studio/scripts/rust-borrow.yaml`.
2. **Design before writing**: one concept; work out the exact final code
   (pinned files plus your insertions); mentally run it and transcribe the
   exact program output for the fixture; then write narration that speaks
   _while_ each action happens, placing `[[mark:…]]` where actions begin.
3. **Write** the YAML. Discipline points that break renders when sloppy:
   - `editor.type` anchors (`after`) must match file content byte-for-byte
     (tabs `\t`, newlines `\n`; use double-quoted YAML strings).
   - Insert-only edits; open a file before typing into it.
   - To explain code already on screen, `editor.select` drag-highlights a range
     (`target.text`, matched byte-for-byte like `after`) — it never edits. The
     highlight grows with the pointer (character by character on one line, line
     by line across several) then rests, scrolling off-screen code into view
     first; you author only the target, and time the `at` mark so the highlight
     lands as the narration names the code, then let it sit.
   - The fixture result is the program's exact output, every line
     `\n`-terminated — `result.output` for Go/Kotlin, `result.stdout` for Rust
     (WebContainer lessons pin the workspace instead of a fixture).
   - Every scene needs a `sources` entry; keep sentences short.
   - Always include `checks: [{ type: timing.p95Ms, max: 300 }]` (`max: 500`
     if the lesson shows Google-deck slides — deck paints cost ~0.4s).
4. **Validate**: `bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml`
   - Optional preflight (the page validates too) but always run it: fix every
     error; address `✎` critic notes (advisory, but ALWAYS fix
     `sources.missing`, banned phrases, and `register.read-aloud` — the
     narrator is always conversational, never reading). It writes
     `<slug>.critique.json` next to the YAML.
   - Scripts auto-register by filename — do not edit
     `src/studio/plans/index.ts`. The YAML is the only artifact; end users can
     alternatively import it via /studio's **Import…** on the website.
5. **Render — verify in the user's Chrome, never headless** (user rule):
   - Use an already-running foreground dev server, then drive the real Chrome
     via claude-in-chrome: open `/studio?plan=<slug>`, press **Start render**,
     and watch the performance live (slides, typing, run) with periodic
     screenshots. Confirm the checks heading (e.g. "Checks (13/13 ok)") and
     scan the receipts for drift.
   - Never launch `bun run dev` in the background, detached, or concurrently
     with another tool. If no server is already available, ask the user to run
     it in a separate foreground terminal; otherwise stop after step 4 and
     report that the browser render is pending.
   - Do NOT run `bun scripts/studio-render.ts` for verification — the user
     wants to see the render happen and judge its visual feel.
   - On failure, the receipts panel names the failing action; see the failure
     table in the authoring doc.
   - If no browser is available (e.g. Codex on the VPS), stop after step 4
     and say the render is pending.
6. **Report**: slug, narration length, actions used, critic notes kept vs
   fixed, render/gate results. A human reviews the lesson before any draft is
   created — never call the lesson done, only rendered.
