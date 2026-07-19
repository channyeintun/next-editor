# Next Recording (VS Code extension)

Records and replays multi-document VS Code editing sessions as a
self-contained `.nextrecording` artifact, played back in a read-only custom
editor. This package is fully isolated from the main application in this
repository (see `docs/adr/0001-package-boundary.md`).

## Status

Under phased implementation. See `docs/implementation-status.md` for the
phase ledger and gate evidence.

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

| Command                     | What it does                                                  |
| --------------------------- | ------------------------------------------------------------- |
| `bun run format:check`      | Prettier check                                                |
| `bun run lint`              | Oxlint over `src`, `test`, `scripts`                          |
| `bun run typecheck`         | Strict `tsc` over host, webview, and integration-test configs |
| `bun run verify:boundaries` | Rejects imports resolving outside `vscode-extension/`         |
| `bun run test:unit`         | Vitest (pure unit/protocol/artifact tests)                    |
| `bun run test:integration`  | Extension Development Host tests via `@vscode/test-electron`  |
| `bun run build`             | esbuild host bundle + Vite webview bundle into `dist/`        |
| `bun run package`           | Builds and writes a VSIX into `.artifacts/`                   |

## Commands

- `Next Recording: Start Recording` (`nextRecording.start`)
- `Next Recording: Stop Recording` (`nextRecording.stop`)
- `Next Recording: Recover Interrupted Recording` (`nextRecording.recover`)
- `Next Recording: Open Recording` (`nextRecording.open`)
- `Next Recording: Export Recording` (`nextRecording.export`)
