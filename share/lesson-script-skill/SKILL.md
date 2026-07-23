---
name: lesson-script
description: Author a Next Editor studio lesson — a narrated, auto-performed coding lesson defined as one LessonScript YAML file, rendered in the browser at nexteditor.dev/studio. Use when asked to create, write, draft, or fix a narrated coding lesson (Rust, Go, Kotlin, Python, JavaScript, TypeScript) for Next Editor.
---

# Author a Next Editor LessonScript

You are producing one YAML file — a complete narrated coding lesson that the
Next Editor studio performs and records unattended in the browser. No
repository, CLI, or install is needed: the YAML is the only artifact, and
https://nexteditor.dev/studio validates, critiques, renders, and gates it.

Read, entirely and in order, before writing:

1. `references/lesson-script-authoring.md` — the complete contract (schema,
   marker/anchoring model, action catalog, fixture rules, failure table).
2. `references/studio-persona.md` — the editorial rules (conversational
   register, plain English, banned phrases, sourcing).
3. `examples/rust-borrow.yaml` — a real, shipped lesson to start from.

## Procedure

1. **Design before writing.** One concept per lesson. Work out the exact
   final code (pinned starter files plus your insertions), mentally run it,
   and transcribe the program's exact output for the fixture.
2. **Write the narration as a conversation** — the way a teacher talks at a
   whiteboard, never the way a manual reads: contractions everywhere natural
   ("that's", "doesn't", "let's"), an occasional short question the next
   sentence answers, plain words a non-native speaker knows. Place
   `[[mark:…]]` exactly where each action should begin.
3. **Write the YAML.** Discipline points that break renders when sloppy:
   - `editor.type` anchors (`after`) must match the file content
     byte-for-byte (tabs `\t`, newlines `\n`; use double-quoted YAML
     strings). Insert-only; open a file before typing into it.
   - To explain code already on screen, `editor.select` drag-highlights a
     range (`target.text`, matched byte-for-byte like `after`) — it never
     edits; open the file first. The highlight grows with the pointer (character
     by character on one line, line by line across several) then rests,
     scrolling off-screen code into view first; you author only the target, and
     time the `at` mark so the highlight lands as the narration names the code,
     then let it sit.
   - End insertions that sit in front of existing code with `\n` — the
     performer presses Enter first so existing code moves down naturally.
   - The fixture's program output must be exactly what the real program
     prints, every line `\n`-terminated.
   - Studio automatically reserves two quiet seconds before the first dialog
     and after the final dialog/action. Do not add filler narration, blank
     scenes, or timing offsets to manufacture recording buffers.
   - Every scene needs a `sources` entry; keep sentences under ~20 words.
   - Always include `checks: [{ type: timing.p95Ms, max: 300 }]`
     (`max: 500` if the lesson shows Google-deck slides).
4. **Validate and render on the website**: open https://nexteditor.dev/studio,
   click **Import…**, and pick your YAML. Fix every validation error, and
   every critic note of the kinds `sources.missing`, banned phrases, and
   `register.read-aloud` (the narrator always talks, never reads). Press
   **Start render** and watch; the render passes only when the checks panel
   shows all gates green, e.g. "Checks (13/13 ok)".
5. **Voice**: narration is synthesized in the page (pocket-tts). The voice
   row can record or clone the author's own voice (2–20 s sample, stored
   only in that browser) — a render-time choice; the YAML keeps a built-in
   `voiceProfile`.
6. **Report**: lesson slug, scenes/actions used, critic notes fixed vs kept,
   and the checks result. A human reviews the rendered lesson and decides on
   **Create draft…** (sign-in required) — never call the lesson done, only
   rendered.
