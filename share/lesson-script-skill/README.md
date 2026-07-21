# Next Editor `lesson-script` skill

Author a narrated, auto-performed coding lesson for
[Next Editor](https://nexteditor.dev) as one YAML file, and render it in the
browser at **https://nexteditor.dev/studio** — no repository, install, or CLI.

This folder is a self-contained [Agent Skill](https://agentskills.io) (a
`SKILL.md` plus reference documents). It works with any AI tool that can read
markdown, and with humans.

## What's inside

| File                                    | Purpose                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| `SKILL.md`                              | The skill: procedure + discipline points for an agent          |
| `references/lesson-script-authoring.md` | The complete LessonScript contract (schema, actions, fixtures) |
| `references/studio-persona.md`          | Editorial rules: conversational register, plain English        |
| `examples/rust-borrow.yaml`             | A real, shipped lesson to start from                           |

## Use it with…

- **Claude Code**: copy this folder to `.claude/skills/lesson-script/` in any
  project (or `~/.claude/skills/lesson-script/` for all projects), then ask:
  "create a lesson about X".
- **Claude (claude.ai)**: zip this folder and upload it as a Skill
  (Settings → Capabilities), or add the files to a Project's knowledge.
- **Codex / Cursor / any other agent**: point the agent at `SKILL.md` (for
  example, reference it from your `AGENTS.md` or paste it as context) — it is
  plain instructions with no tool-specific features.
- **By hand**: read `references/lesson-script-authoring.md` and write the
  YAML yourself.

## The short version

1. Write `<slug>.yaml` (start from `examples/rust-borrow.yaml`).
2. Open https://nexteditor.dev/studio → **Import…** → fix every error and
   critic note.
3. **Start render**, watch the lesson perform itself, and confirm
   "Checks (N/N ok)".
4. Optionally narrate with your own cloned voice (the voice row: record or
   upload 2–20 s; the sample never leaves your browser).
5. Sign in and **Create draft…** to upload it like any recording. A human
   reviews before anything is published.

To make a zip for sharing or claude.ai upload:

```sh
zip -r lesson-script-skill.zip lesson-script-skill
```
