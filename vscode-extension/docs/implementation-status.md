# Implementation Status — next-recording VS Code extension

Plan of record: [`docs/vscode-recording-playback-extension-implementation-plan.md`](../../docs/vscode-recording-playback-extension-implementation-plan.md) (repository root).
Research: [`docs/vscode-recording-playback-extension-research.md`](../../docs/vscode-recording-playback-extension-research.md).

This document tracks routine progress and phase-gate evidence. The plan itself is
not modified without explicit approval.

## Phase ledger

| Phase | Description                                      | Status                            |
| ----- | ------------------------------------------------ | --------------------------------- |
| 0     | Preflight and decision recording                 | Done (2026-07-20)                 |
| 1     | Isolated extension scaffold                      | Done (2026-07-20)                 |
| 2     | Capture topology and text-change feasibility     | Not started                       |
| 3     | Renderer benchmark and decision                  | Not started                       |
| 4     | Versioned model, journal, and checkpoints        | Not started                       |
| 5     | Native visual recording vertical slice           | Not started                       |
| 6     | Artifact finalization and read-only playback     | Not started                       |
| 7     | Recovery, security, privacy, and scale hardening | Not started                       |
| 8     | Audio feasibility and integration                | Deferred (gated per plan §12/§15) |
| 9     | Release candidate and handoff                    | Not started                       |

## Phase 0 evidence (2026-07-20)

### Preflight checks

- Root `CLAUDE.md` read completely. Implementation host is the macOS
  workstation (`Darwin arm64`), so the full verification suite is allowed;
  the VPS process/memory restrictions do not apply here.
- `git status --short` at start: clean worktree on `main`. No unrelated
  changes to preserve.
- The architecture research document was read completely before any
  implementation decision below.
- No root file (`package.json`, lockfile, TypeScript config, Vite config) is
  modified by this project. Root `package.json` declares no `workspaces`
  field, so `bun install` executed inside `vscode-extension/` produces an
  independent `vscode-extension/bun.lock` and does not touch the root
  lockfile.

### Toolchain confirmed on 2026-07-20

- Node.js v24.18.0, Bun 1.3.14 (package commands run from
  `vscode-extension/` only).
- Current stable VS Code Extension API: **1.125** (per `@types/vscode`
  latest stable on the npm registry).

### Dependency and tooling decisions

Exact versions are pinned in `vscode-extension/package.json` +
`bun.lock` at Phase 1. Registry-latest versions verified 2026-07-20:

| Purpose                 | Package                                                                                              | Version verified                                | Rationale                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Extension-host language | `typescript` (strict)                                                                                | 7.0.2                                           | Plan §6.1 requires strict TypeScript.                                                                                     |
| Host bundle             | `esbuild`                                                                                            | 0.28.1                                          | Node-targeted CJS bundle for the extension host; fast, zero-config, standard for extensions.                              |
| Webview bundle          | `vite`                                                                                               | 8.1.5                                           | Plan §6.1 mandates Vite for the webview bundle.                                                                           |
| Unit/protocol tests     | `vitest`                                                                                             | 4.1.10                                          | Plan §6.1 mandates Vitest for pure tests.                                                                                 |
| Integration tests       | `@vscode/test-electron` 3.0.0 + `mocha` 11.7.6                                                       | —                                               | Official Extension Development Host test tooling.                                                                         |
| VSIX packaging          | `@vscode/vsce`                                                                                       | 3.9.2                                           | Official packaging tool.                                                                                                  |
| API types               | `@types/vscode`                                                                                      | pinned to the selected engine floor (see below) | Pinning types to the floor makes the compiler enforce the minimum-engine contract.                                        |
| Schema source           | `zod`                                                                                                | 4.4.3                                           | One schema source generates both runtime validators and TS types (plan §7); works in host and webview.                    |
| ZIP write               | `yazl`                                                                                               | 3.3.1                                           | Streaming ZIP writer, independent dependency (plan §9.5 forbids reusing main-app compression code).                       |
| ZIP read                | `yauzl`                                                                                              | 3.4.0                                           | Streaming ZIP reader with explicit entry iteration — needed for archive-safety validation before extraction (plan §13.2). |
| Webview UI              | `react` / `react-dom`                                                                                | 19.2.7                                          | Plan §5 webview layout names React entrypoints (`index.tsx`, `App.tsx`).                                                  |
| Renderer candidate A    | `monaco-editor`                                                                                      | 0.55.1                                          | Benchmark candidate only until ADR 0002 (plan §11).                                                                       |
| Renderer candidate B    | `codemirror` 6 (`@codemirror/state` 6.7.1, `@codemirror/view` 6.43.6, `@codemirror/language` 6.12.4) | —                                               | Benchmark candidate only until ADR 0002.                                                                                  |

None of these decisions copy versions from the main application; each was
verified against the registry on the date above.

### Engine floor (provisional, finalized during Phase 1 scaffolding)

Provisional `engines.vscode`: `^1.86.0`.

Rationale: every API family the plan requires is stable well before 1.86 —
custom readonly editors (1.44), `workspace.onDidChangeTextDocument` with
undo/redo `reason` (1.49), tab/tab-group API incl. `TabInput*` types (1.67),
`TextEditorSelectionChangeKind`, visible ranges, multi-root workspace APIs
(all ≤1.67). 1.86 is chosen as the floor rather than 1.67 because it is the
first release requiring Node 18+ semantics matching our compiled target and
it comfortably predates the current stable (1.125) by >3 years of releases.
`@types/vscode` is pinned to the floor so any accidental use of a newer API
fails typecheck. If Phase 1/2 compilation shows a needed API is missing at
1.86, the floor moves up to the oldest version that has it and this section
plus `README.md` record the change.

- No proposed APIs.
- No VS Code internal module imports.

### Identifiers (fixed by plan §6.3)

- Package name `next-recording`, namespaces `nextRecording.*`, custom
  editor view type `nextRecording.player`, artifact extension
  `.nextrecording`. Centralized in one identifiers module during Phase 1.

### Initial assumptions

- Supported platform for development and first validation: macOS arm64,
  VS Code desktop, local workspaces (single- and multi-root) and untitled
  documents.
- `extensionKind: ["ui"]` per plan §6.3; remote-workspace behavior is
  observed through VS Code APIs but not a validated platform row yet.
- Timebase: `process.hrtime.bigint()` session-relative microseconds
  (plan §7.2).
- Artifact container: streaming ZIP, format documented in
  `docs/artifact-format-v1.md` before v1 is declared stable.

### Deferred capabilities (explicitly out of scope for the core milestone)

- Audio (Phase 8 gate; native helper not created until that phase starts).
- Diff, notebook, terminal, webview, and third-party custom-editor surface
  capture (explicit unsupported-surface markers only).
- VS Code for the Web, cross-window sessions, collaboration/upload,
  `.ne` interoperability, screen/camera capture, horizontal scroll, exact
  fold state, mouse coordinates.

## Phase 1 evidence (2026-07-20)

- Independent package installed with Bun 1.3.14; `vscode-extension/bun.lock`
  created; root lockfile untouched (verified via `git status`).
- Version adjustments against the registry during install:
  `@types/react` 19.2.17, `@types/react-dom` 19.2.3 (the react runtime
  version numbers do not exist for the types packages), `typescript` pinned
  to 5.9.3 (7.x is the new native compiler line; 5.9 is the mature LTS
  semantics the toolchain here is known-good with).
- Acceptance gate results:
  - `bun run typecheck` — pass (host, webview, test configs, strict).
  - `bun run lint`, `bun run format:check` — pass.
  - `bun run verify:boundaries` — pass.
  - `bun run test:unit` — 2 tests pass.
  - `bun run build` — host bundle 3.3 kB, webview bundle 190.6 kB.
  - `bun run test:integration` — 3 tests pass in a real Extension
    Development Host (VS Code 1.129.1, darwin-arm64): activation,
    command registration, and opening a synthetic `.nextrecording` in the
    placeholder custom editor (`vscode.TabInputCustom` with viewType
    `nextRecording.player`).
  - `bun run package` — VSIX 9 files / 64 kB; contents audited: only
    `dist/`, `package.json`, `package.nls.json`, README, CHANGELOG.
- Note: current stable VS Code observed at integration time is 1.129.1;
  the 1.86 engine floor stands.

## Verification log

| Date       | Phase | Commands                                                                                                                   | Result   |
| ---------- | ----- | -------------------------------------------------------------------------------------------------------------------------- | -------- |
| 2026-07-20 | 0     | (docs only — no source yet)                                                                                                | n/a      |
| 2026-07-20 | 1     | `bun run check` equivalent (format:check, lint, typecheck, verify:boundaries, test:unit, build, test:integration, package) | all pass |
