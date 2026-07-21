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
`src/studio/scripts/go-swap.yaml`.

## Procedure

1. **Read** `docs/lesson-script-authoring.md`, `docs/studio-persona.md`, and
   `src/studio/scripts/go-swap.yaml`.
2. **Design before writing**: one concept; work out the exact final code
   (pinned files plus your insertions); mentally run it and transcribe the
   exact program output for the fixture; then write narration that speaks
   _while_ each action happens, placing `[[mark:…]]` where actions begin.
3. **Write** the YAML. Discipline points that break renders when sloppy:
   - `editor.type` anchors (`after`) must match file content byte-for-byte
     (tabs `\t`, newlines `\n`; use double-quoted YAML strings).
   - Insert-only edits; open a file before typing into it.
   - `fixture.result.output` = the real program's exact stdout.
   - Every scene needs a `sources` entry; keep sentences short.
   - Always include `checks: [{ type: timing.p95Ms, max: 300 }]`.
4. **Validate**: `bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml`
   - Optional preflight (the page validates too) but always run it: fix every
     error; address `✎` critic notes (advisory, but fix `sources.missing` and
     banned phrases). It writes `<slug>.critique.json` next to the YAML.
   - Scripts auto-register by filename — do not edit
     `src/studio/plans/index.ts`. The YAML is the only artifact; end users can
     alternatively import it via /studio's **Import…** on the website.
5. **Render — verify in the user's Chrome, never headless** (user rule):
   - `bun run dev` (background), then drive the real Chrome via
     claude-in-chrome: open `/studio?plan=<slug>`, press **Start render**,
     and watch the performance live (slides, typing, run) with periodic
     screenshots. Confirm the checks heading (e.g. "Checks (13/13 ok)") and
     scan the receipts for drift.
   - Do NOT run `bun scripts/studio-render.ts` for verification — the user
     wants to see the render happen and judge its visual feel.
   - On failure, the receipts panel names the failing action; see the failure
     table in the authoring doc.
   - If no browser is available (e.g. Codex on the VPS), stop after step 4
     and say the render is pending.
6. **Report**: slug, narration length, actions used, critic notes kept vs
   fixed, render/gate results. A human reviews the lesson before any draft is
   created — never call the lesson done, only rendered.
