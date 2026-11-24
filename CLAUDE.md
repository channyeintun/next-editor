## Always Follow Conway's Law

Structure code to mirror who changes it. This repository is changed by one author plus parallel AI agents, and each usually owns one domain at a time (a recording track, audio, cursor, whiteboard, slides, preview, workspace, runtime, chat, x86, dmp, a studio stage). Module boundaries must match those domains:

- **One domain, one module.** A domain's logic lives in one cohesive module behind a narrow, explicit interface. A change to one domain should touch that module, not several others.
- **Hubs wire, owners implement.** Do not grow the files every domain converges on (`editorMachine.ts`, `machine/types.ts`, `frameCapture.ts`, `frameReplay.ts`, `useNextEditor.ts`). Put new behavior in the owning domain's module and only register or wire it in the hub. `src/core/src/hubRules.test.ts` checks two of these: it fails on a function over 10 lines of code in `editorMachine.ts`, on more lines in its functions outside the machine, on a type declared there, and on a new top-level type or an inline event type in `machine/types.ts`.
- **Owners own their state.** Never write another domain's internal state directly; call a helper that the owning module exports.
- **Dependencies point inward.** `src/core` never imports from the app layer (`src/storage`, `src/utils`, `src/components`, `src/types`, `src/contexts`). Move what core needs into core and re-export it from the app path if the app still uses it.
- **One rule, one home.** When two domains need the same rule or constant, give it one owner and import it; do not copy it.
- **Split by reason to change.** When a file mixes concerns that different people or agents change for different reasons, split it along those domains (no catch-all barrels) rather than letting it grow.
- **webnode is scope-frozen.** A change to `src/core/webnode` needs a lesson, starter or user report that fails, or a measured speed or memory gain on one (install time, time to the first preview, peak memory). No conformance-only work: nothing to match Node, bash or Linux beyond that. See "Scope" in `src/core/webnode/README.md`.

## Studio Lessons (agent-authorable)

When asked to create or fix a narrated studio lesson (a "LessonScript"),
follow `docs/lesson-script-authoring.md` — the complete authoring contract
(YAML at `src/studio/scripts/<slug>.yaml` → `bun scripts/studio-director.ts`
→ `bun scripts/studio-render.ts <slug>`). Claude Code sessions also have the
`lesson-script` skill for this. Never hand-edit the emitted JSON under
`src/studio/plans/scripts/`.

Commit and push a lesson's YAML and its Director sidecar as one commit; under
`bun run dev`, reload `/studio` to see it. Lessons are not in the app bundle:
`bun scripts/lesson-scripts.ts publish --remote` puts committed lessons on
nexteditor.dev with no build and no deploy. It writes to production, so Chan
runs it, or an agent on his word. A lesson with a new dependency set also needs
`webnode-deps` build and upload and a deploy. A change to the script schema or
the Director is deployed before a lesson that needs it is published.

## Mandatory Workflow

After completing the work, provide:

- A recommended Git commit message following the Conventional Commits specification (e.g., `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).

### Default Principles

- Always finish by providing a recommended Git commit message
- After every successful commit, push the current branch to `origin`.
