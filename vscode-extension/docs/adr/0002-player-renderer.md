# ADR 0002: Playback renderer — Monaco (evidence-based)

Date: 2026-07-20

Status: Accepted

## Context

The plan (§11) forbids choosing Monaco solely because the main application
uses it. Both candidates were implemented against the same renderer
contract (`src/webview/player/Renderer.ts`) with the playback engine
(`SessionReducer`) owning canonical state, and measured in the same
release-mode bundle inside a **real VS Code webview** (Extension
Development Host), which is the production playback environment.

## Methodology

- Hardware: Apple Silicon macOS workstation (`darwin arm64`).
- Host: VS Code 1.129.1 Electron webview, Node 24.18.0 extension host.
- Build: Vite 8 production (minified), separate dev-only bundle
  (`vite.benchmark.config.ts`), Monaco and CodeMirror isolated in their own
  chunks for size attribution.
- Fixtures (plan §11.2): generated deterministically in-page from seeded
  PRNGs (`src/webview/player/fixtures.ts`): small (3 docs/5k events),
  multi-surface (10 docs/4 groups/2 duplicated docs/25k), large-file
  (~5 MiB/localized edits), edit-burst (100 tx/s × 10 s), long-session
  (60 min/250k events/periodic checkpoints), unicode (surrogate pairs,
  combining marks, CJK).
- Adapters apply recorded transactions with identical evolving-buffer
  semantics (one change at a time, UTF-16 offsets). Both rendered
  plaintext; language tokenization cost was _not_ measured (follow-up
  noted below).
- Patch-to-paint sampled ~150 patches/fixture via double-rAF; seeks use
  checkpoint restore + forward patches + selection/viewport restore; memory
  is `performance.memory.usedJSHeapSize` (coarse, no forced GC).
- Raw data: `.artifacts/renderer-benchmark.json` (regenerate with
  `bun run benchmark:renderer`).

## Results (2026-07-20 run)

Bundle size (minified, per-candidate chunk): **Monaco 2 805 KB + 74 KB
CSS; CodeMirror 212 KB.**

| Fixture                     | Metric                                                        | Monaco         | CodeMirror         | Budget (§11.4)           |
| --------------------------- | ------------------------------------------------------------- | -------------- | ------------------ | ------------------------ |
| multi-surface               | first paint                                                   | 26.9 ms        | 37.4 ms            | < 1 500 ms               |
| multi-surface               | create 1/5/10/20 surfaces                                     | 32/33/33/38 ms | 33/33/67/134 ms    | 10 without stalls        |
| multi-surface               | patch-to-paint p95                                            | 31.4 ms        | 25.3 ms            | < 50 ms                  |
| multi-surface               | seek p95                                                      | 38.6 ms        | **252.2 ms**       | < 250 ms                 |
| large-file (5 MiB)          | patch-to-paint p95                                            | 31.0 ms        | 26.2 ms            | < 50 ms                  |
| large-file                  | seek p95                                                      | 33.4 ms        | 116.3 ms           | < 250 ms                 |
| long-session (60 min, 250k) | seek p50/p95                                                  | 124.9/187 ms   | **676.9/980.4 ms** | < 250 ms (30-min analog) |
| long-session                | full replay wall time                                         | 7.7 s          | **132.8 s**        | —                        |
| long-session                | heap load → after 100 seeks                                   | 166→158 MB     | 85→98 MB           | bounded                  |
| unicode                     | final text correctness                                        | pass           | pass               | must pass                |
| all six                     | duplicated-surface correctness, suspension/resume correctness | pass           | pass               | must pass                |

Both renderers restore independent per-surface selections and vertical
viewports through their native APIs (Monaco `setSelections`/
`revealRangeAtTop` + view state save/restore; CodeMirror
`EditorSelection` dispatches + `scrollIntoView`), with comparable
implementation effort.

## Decision

**Monaco** is the playback renderer.

- Monaco meets every provisional acceptance budget, including seek p95 of
  187 ms on a fixture _twice_ the size of the budgeted 30-minute session.
- CodeMirror misses the seek budget by ~4× on the long-session fixture,
  is marginally over it on multi-surface, replays the long fixture 17×
  slower, and degrades sharply at 20 simultaneous surfaces.
- CodeMirror's advantages (13× smaller bundle, slightly lower
  patch-to-paint medians) do not outweigh failing a hard budget: the VSIX
  is installed locally, so bundle size is a disk/startup cost, not a
  network cost. Measured webview first paint with Monaco stayed under
  53 ms on every fixture.

## Honest caveats

1. An earlier run showed a Monaco correctness failure on the unicode
   fixture. Root cause: the fixture generator produced offsets that split
   surrogate pairs — input the VS Code API never emits (Monaco clamps such
   positions; CodeMirror splices raw strings). After aligning synthetic
   offsets to code-point boundaries (matching real recordings), Monaco
   passes; the generator fix is in `fixtures.ts` (`alignToCodePoint`).
2. The CodeMirror adapter dispatches one transaction per recorded change
   per view. Batching consecutive patches into single dispatches could
   narrow the seek gap, but requires offset remapping across composed
   changes (a correctness risk this format deliberately avoids) and was
   out of scope for a faithful minimal-adapter comparison.
3. Tokenization/theme cost was not measured (both plaintext). Monaco
   ships its own tokenizer infrastructure; if rich highlighting is added
   to the player later, patch-to-paint should be re-measured.
4. `performance.memory` is coarse and GC-timing dependent; one earlier
   run showed a transient 638 MB CodeMirror heap after large-file seeks
   that did not reproduce. Neither renderer showed monotonic growth
   across 100 seeks in the final run.

## Consequences

- `monaco-editor` stays a production dependency; the Phase 6 player
  integrates `MonacoRenderer`.
- `@codemirror/state` / `@codemirror/view` move to devDependencies and are
  referenced only by the explicitly development-only benchmark bundle
  (`vite.benchmark.config.ts`, excluded from the VSIX), preserved so the
  benchmark remains reproducible.
- Canonical session state remains in the renderer-independent
  `SessionReducer`; the player never treats Monaco state as source of
  truth, so this decision is reversible.
