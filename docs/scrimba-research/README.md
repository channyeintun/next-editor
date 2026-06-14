# Scrimba Bundle Research

Last updated: 2026-06-14

## Purpose

This directory records an agent-agnostic investigation of how Scrimba works based on the bundled code in `tmp/`. It is intended to be resumable by any future agent without rereading every bundled line from scratch.

The source material is minified production JavaScript. There are no JavaScript source maps in `tmp/`; only the CSS references a missing map. Treat every conclusion as bundle-derived unless explicitly marked as inference.

## Research Packet

- `findings.md` - current architecture findings and behavioral model.
- `action-protocol.md` - stream/action opcode map and action semantics found so far.
- `progress.md` - file-by-file research status, summaries, and remaining work.

## High-Level Findings

1. Scrimba is implemented as a custom Imba-style application with a large platform/app bundle and a separate IDE/runtime bundle.
2. The central interactive unit is a `Scrim` content model in `tmp/app.UK3DL7B2.js`.
3. The IDE/player runtime lives mainly in `tmp/chunks/ide.36BDFLCO.js`.
4. Scrimba records interaction as a compact, append-only stream of typed numeric actions rather than as plain video frames.
5. Playback/seeking is implemented by a reversible stream cursor that applies and reverts actions to reach a target point in the timeline.
6. Browser preview replay is DOM-state based: a `BrowserPage` stores HTML, attributes, logs, status, URL, and applies/reverts DOM mutation actions.
7. Runtime execution uses a WebContainer path (`SIWebContainer`) plus service-worker/iframe helpers, with a static/browser DOM replay path for preview state.
8. Audio, captions, transcript editing, trim/cut/speedup cues, and timeline clips are first-class model concepts.
9. A default blank workspace snapshot is available in `tmp/scrim.blank.json.5TFCQ3DL.js`.

## Important Evidence Anchors

- Action opcode table: `tmp/chunks/ide.36BDFLCO.js`, character offset `566697`.
- Action registration helper `Ve(...)`: `tmp/chunks/ide.36BDFLCO.js`, near character offset `569461`.
- Base action class `IDEStreamAction`: `tmp/chunks/ide.36BDFLCO.js`, near character offset `2293694`.
- Stream cursor apply/revert logic: `IDEStreamCursor` in `tmp/chunks/ide.36BDFLCO.js`.
- DOM replay engine: `BrowserPage` in `tmp/chunks/ide.36BDFLCO.js`.
- WebContainer runtime: `SIWebContainer` in `tmp/chunks/ide.36BDFLCO.js`.
- Scrim content model: `Scrim`, `ScrimStream`, `ScrimRec`, `ScrimClip`, `ScrimPractice`, `ScrimPreview` in `tmp/app.UK3DL7B2.js`.
- Blank workspace snapshot: `tmp/scrim.blank.json.5TFCQ3DL.js`.

## How To Continue

Start with `progress.md`, then read `findings.md` and `action-protocol.md`. If deeper proof is needed, rerun the extraction commands in `progress.md` instead of opening the minified bundles directly.

Recommended next research tasks:

1. De-minify only targeted class regions, not whole bundles.
2. Trace `IDEBranch.load`, `IDEStream` deserialization, and branch creation.
3. Trace local recording capture sources for Monaco, DOM tracker, pointer tracker, and media chunks.
4. Trace server persistence of `ScrimStream` and legacy `/legacy/files/` loading.
5. Compare these findings with Next Editor's `src/core` architecture if the goal is product parity.
