# ADR 0001: Package boundary — the extension is an isolated package

Date: 2026-07-20

Status: Accepted

## Context

The repository hosts a web application (`src/`, `tube/`, `infra/`,
`remote-runtime/`) that records and replays coding sessions using its own
editor machines, DMP WASM codec, and `.ne` artifact format. The
implementation plan (§2) mandates a clean-sheet VS Code extension that is
inspired by the product concept but shares no code, format, or build
infrastructure with the main application.

## Decision

1. All extension work lives in `vscode-extension/` with its own
   `package.json`, `bun.lock`, TypeScript configs, and build scripts. Package
   commands run only from that directory.
2. The extension never imports from the repository's `src/` tree or any
   other main-app path. A boundary verification script
   (`scripts/verify-boundaries.mjs`, added in Phase 1) fails the build if any
   import in `vscode-extension/src/**` or `vscode-extension/test/**` resolves
   outside `vscode-extension/`, excluding declared runtime/tooling packages
   (`vscode`, Node builtins, and dependencies of the extension package).
3. The root `package.json`, root lockfile, root `tsconfig`, and root Vite
   config are never modified for extension work. Root `package.json` has no
   `workspaces` field, so `bun install` inside `vscode-extension/` is fully
   independent (verified 2026-07-20).
4. The extension defines its own recording artifact (`.nextrecording`,
   streaming ZIP, format v1). It does not read or write `.ne`, does not use
   diff-match-patch or the DMP WASM codec, and has no interoperability layer.
5. Third-party dependencies that resemble main-app choices (e.g. a ZIP
   library, React) are permitted only as independent entries in
   `vscode-extension/package.json`; copying main-app implementation code is
   not.
6. Recordings are stored in the extension's own `globalStorageUri` working
   directory; playback happens in a read-only custom editor and never edits
   real workspace documents.

## Consequences

- The extension can be reviewed, versioned, packaged, and eventually
  extracted to its own repository without untangling shared code.
- Some concepts (event envelopes, checkpoint policies) are deliberately
  re-implemented rather than reused; divergence from the main app is
  expected and acceptable.
- CI for the extension, if added later, requires an explicit approval for
  any `.github/` change (plan §2.1).
