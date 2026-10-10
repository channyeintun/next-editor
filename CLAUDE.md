## Always Follow Conway's Law

Structure code to mirror who changes it. This repository is changed by one author plus parallel AI agents, and each usually owns one domain at a time (a recording track, audio, cursor, whiteboard, slides, preview, workspace, runtime, chat, x86, dmp, a studio stage). Module boundaries must match those domains:

- **One domain, one module.** A domain's logic lives in one cohesive module behind a narrow, explicit interface. A change to one domain should touch that module, not several others.
- **Hubs wire, owners implement.** Do not grow the files every domain converges on (`editorMachine.ts`, `machine/types.ts`, `frameCapture.ts`, `frameReplay.ts`, `useNextEditor.ts`). Put new behavior in the owning domain's module and only register or wire it in the hub.
- **Owners own their state.** Never write another domain's internal state directly; call a helper that the owning module exports.
- **Dependencies point inward.** `src/core` never imports from the app layer (`src/storage`, `src/utils`, `src/components`, `src/types`, `src/contexts`). Move what core needs into core and re-export it from the app path if the app still uses it.
- **One rule, one home.** When two domains need the same rule or constant, give it one owner and import it; do not copy it.
- **Split by reason to change.** When a file mixes concerns that different people or agents change for different reasons, split it along those domains (no catch-all barrels) rather than letting it grow.

## Studio Lessons (agent-authorable)

When asked to create or fix a narrated studio lesson (a "LessonScript"),
follow `docs/lesson-script-authoring.md` — the complete authoring contract
(YAML at `src/studio/scripts/<slug>.yaml` → `bun scripts/studio-director.ts`
→ `bun scripts/studio-render.ts <slug>`). Claude Code sessions also have the
`lesson-script` skill for this. Never hand-edit the emitted JSON under
`src/studio/plans/scripts/`.

## Mandatory Workflow

After completing the work, provide:

- A recommended Git commit message following the Conventional Commits specification (e.g., `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).

### Default Principles

- Always finish by providing a recommended Git commit message
- After every successful commit, push the current branch to `origin`.
