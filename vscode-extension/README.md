# Next Recording (VS Code extension)

Records and replays multi-document VS Code editing sessions as a
self-contained `.nextrecording` artifact, played back in a read-only custom
editor. This package is fully isolated from the main application in this
repository (see `docs/adr/0001-package-boundary.md`).

## What it records

- Ordinary text documents across multiple workspace roots (visible-first
  enrollment: a document is captured once it becomes visible, and keeps
  being captured while hidden).
- Document edits as atomic UTF-16 transactions with hash-chained
  validation, plus periodic full checkpoints.
- Multi-cursor selections, vertical visible ranges, active editor/tab/
  group changes, tab and group topology, untitled documents, undo/redo.
- Explicit markers for unsupported surfaces (diff editors, notebooks,
  terminals, webviews, custom editors) — honest placeholders, never fake
  content.

Everything is stored locally under the extension's own storage. Nothing is
uploaded.

## Commands

- `Next Recording: Start Recording` — one-time privacy disclosure, then a
  red status-bar indicator with elapsed time.
- `Next Recording: Stop Recording` — drains and validates the session,
  packages a `.nextrecording` artifact, offers Open/Export.
- `Next Recording: Open Recording` — library of local recordings (works
  without a workspace).
- `Next Recording: Export Recording` — copy an artifact to a chosen
  destination.
- `Next Recording: Recover Interrupted Recording` — finalize, inspect, or
  discard sessions left behind by a crash or reload.

## Settings

| Setting                                  | Default | Meaning                                                                                                   |
| ---------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `nextRecording.capture.exclude`          | `[]`    | Glob patterns never captured (matched against root-relative path and file name). Read at recording start. |
| `nextRecording.capture.maxDocumentBytes` | 10 MiB  | Larger documents are excluded with an explicit marker.                                                    |
| `nextRecording.capture.includeUntitled`  | `true`  | Capture untitled documents.                                                                               |
| `nextRecording.capture.includeRemote`    | `true`  | Capture remote/virtual documents.                                                                         |
| `nextRecording.playback.defaultSpeed`    | `1`     | Initial player speed.                                                                                     |
| `nextRecording.diagnostics.level`        | `off`   | Output-channel logging (never contains captured source text).                                             |

## Playback

Recordings open in a read-only player (Monaco-based; selected by benchmark
evidence, see `docs/adr/0002-player-renderer.md`): play/pause, seek bar,
speed control, reconstructed editor-group layout with recorded tabs, and
independent per-surface selections/viewports. Playback never opens or
modifies real workspace documents and works fully offline. Recorded
topology has no pixel geometry; groups render equal-sized in recorded
order (labeled reconstruction, plan §10.6).

## Format

`.nextrecording` v1 is a ZIP container with a manifest, NDJSON event
journal, per-document checkpoints, a seek index, and SHA-256 integrity
tables. Imported recordings are treated as untrusted: the reader enforces
path, size, count, and decompression-ratio limits and verifies every hash
before content reaches the player. See `docs/artifact-format-v1.md` and
`docs/adr/0003-recording-container.md`.

## Known limitations (v1)

- Audio narration is not yet implemented (plan Phase 8 — gated on a native
  helper feasibility spike; the format already reserves audio tracks).
- Diff editors, notebooks, terminals, webviews, and third-party custom
  editors appear as explicit unsupported-surface placeholders.
- Horizontal scroll, exact fold state, mouse coordinates, hover/suggest
  widgets, and exact split geometry are not captured (not exposed by the
  public API).
- One recording session per VS Code window; no cross-window sessions.
- VS Code for the Web is unsupported.
- Remote SSH / Dev Container workspaces record through VS Code APIs but
  have no validated platform row yet.

## Minimum VS Code version

`engines.vscode: ^1.86.0`.

Rationale: every public API this extension uses is stable well before 1.86 —
custom readonly editors (1.44), text document change events with undo/redo
reason (1.49), the tab/tab-group API including `TabInput*` types (1.67),
selection kinds, visible ranges, and multi-root workspace APIs (≤1.67).
`@types/vscode` is pinned to `1.86.0` so the compiler rejects any
accidental use of newer API. No proposed APIs and no VS Code internal
modules are used.

## Development

All commands run from `vscode-extension/` with Bun as the package manager.
The root repository package is never touched.

```bash
cd vscode-extension
bun install --frozen-lockfile
bun run check          # aggregate: format, lint, typecheck, boundaries, tests, build, integration
```

Individual steps:

| Command                      | What it does                                                  |
| ---------------------------- | ------------------------------------------------------------- |
| `bun run format:check`       | Prettier check                                                |
| `bun run lint`               | Oxlint over `src`, `test`, `scripts`                          |
| `bun run typecheck`          | Strict `tsc` over host, webview, and integration-test configs |
| `bun run verify:boundaries`  | Rejects imports resolving outside `vscode-extension/`         |
| `bun run test:unit`          | Vitest (unit, artifact, recovery, webview-protocol tests)     |
| `bun run test:integration`   | Extension Development Host tests via `@vscode/test-electron`  |
| `bun run benchmark:renderer` | Renderer benchmark in a real VS Code webview (dev-only)       |
| `bun run build`              | esbuild host bundle + Vite webview bundle into `dist/`        |
| `bun run package`            | Builds and writes a VSIX into `.artifacts/`                   |

`node scripts/generate-fixture.mjs` regenerates the synthetic reproduction
fixtures under `fixtures/recordings/`.

Status and phase-gate evidence: `docs/implementation-status.md`.
