# Scrimba Bundle Research

Last updated: 2026-06-15

## Purpose

This directory records an agent-agnostic investigation of how Scrimba works based on the bundled code in `tmp/`. It is intended to be resumable by any future agent without rereading every bundled line from scratch.

The source material is minified production JavaScript. There are no JavaScript source maps in `tmp/`; only the CSS references a missing map. Treat every conclusion as bundle-derived unless explicitly marked as inference.

## Research Packet

- `findings.md` - current architecture findings and behavioral model.
- `action-protocol.md` - stream/action opcode map and action semantics found so far.
- `progress.md` - file-by-file research status, exact completed source spans, summaries, and remaining work.

## High-Level Findings

1. Scrimba is implemented as a custom Imba-style application with a large platform/app bundle and a separate IDE/runtime bundle.
2. The central interactive unit is a `Scrim` content model in `tmp/app.UK3DL7B2.js`.
3. The IDE/player runtime lives mainly in `tmp/chunks/ide.36BDFLCO.js`.
4. Scrimba records interaction as a compact, append-only stream of typed numeric actions rather than as plain video frames.
5. Playback/seeking is implemented by a reversible stream cursor that applies and reverts actions to reach a target point in the timeline.
6. Browser preview replay is DOM-state based: a `BrowserPage` stores HTML, attributes, logs, status, URL, and applies/reverts DOM mutation actions.
7. Runtime execution uses a WebContainer path (`SIWebContainer`) plus service-worker/iframe helpers, with a static/browser DOM replay path for preview state.
8. Audio, captions, transcript editing, trim/cut/speedup cues, and timeline clips are first-class model concepts.
9. Newer Scrimba workspaces use `SIWorkspace`/`SIFS` OP snapshots and deltas, while legacy scrims serialize `IDEFile`/`IDEFS` widgets.
10. Modern workspace runtime state syncs through `HostWorkspace` providers, usually a per-scrim `WCWorkspace` from the global `SIWebContainer` singleton.
11. The visible WebContainer bridge uses a hidden iframe on reserved port `8123`, OP msgpack packets, `OPDataUpdate` patches, and a bundled `.bootstrap.mjs` script whose source asset is referenced but missing locally.
12. This repo's current architecture is materially different: it stores complete recording artifacts with keyframe/delta frame arrays, workspace/runtime snapshot events, and a separate WebContainer provider sync path.
13. A default blank workspace snapshot is available in `tmp/scrim.blank.json.5TFCQ3DL.js`.

## Important Evidence Anchors

- Completed skip map: `progress.md`, section `Completed Evidence Ranges`.
- Action opcode table: `tmp/chunks/ide.36BDFLCO.js`, character offset `567982` for the `COMMIT`/`MSR` area and `566697` for the broader enum section.
- Action registration helper `Ve(...)`: `tmp/chunks/ide.36BDFLCO.js`, near character offset `569461`.
- Base action class `IDEStreamAction`: `tmp/chunks/ide.36BDFLCO.js`, near character offset `2293694`.
- Stream cursor apply/revert logic: `IDEStreamCursor` in `tmp/chunks/ide.36BDFLCO.js`.
- DOM replay engine: `BrowserPage` in `tmp/chunks/ide.36BDFLCO.js`.
- Modern workspace state: `SIWorkspace`, `SIFS`, `SIFile`, `SIDir`, `IDEOPSnapshotAction`, and `IDEOPDeltaAction` in `tmp/chunks/ide.36BDFLCO.js`.
- WebContainer/runtime host path: `SIWebContainer` in `tmp/chunks/ide.36BDFLCO.js`; `HostWorkspace`, `LocalWorkspace`, and `WCWorkspace` in `tmp/app.UK3DL7B2.js`.
- WebContainer bridge/client protocol: `SIWebContainer` around `tmp/chunks/ide.36BDFLCO.js` character offsets `1159200-1165200`; OP msgpack helpers and `OPDataUpdate` in `tmp/app.UK3DL7B2.js` character offsets `452600-454620` and `674500-676000`.
- Host save/diff persistence after `HostWorkspace.$changed`: `tmp/app.UK3DL7B2.js` character offsets `3701850-3704620`, `616969-620198`, and `1165200-1175200`.
- Service-worker/request routing: `ServiceWorkerFrame`, `ide-sw-container`, `runner-frame`, `player-frame`, and `scrim-view.oncontainermessage` in `tmp/chunks/ide.36BDFLCO.js`.
- Scrim content model: `Scrim`, `ScrimStream`, `ScrimRec`, `ScrimClip`, `ScrimPractice`, `ScrimPreview` in `tmp/app.UK3DL7B2.js`.
- Nested route/path behavior: `scrim-view.sync/open` in `tmp/chunks/ide.36BDFLCO.js` character offsets `2917200-2920200`, plus URL helpers in `Scrim`, `ScrimPractice`, and `IDEStream`.
- Blank workspace snapshot: `tmp/scrim.blank.json.5TFCQ3DL.js`.

## How To Continue

Start with `progress.md`, then read `findings.md` and `action-protocol.md`. If deeper proof is needed, rerun the extraction commands in `progress.md` instead of opening the minified bundles directly.

Recommended next research tasks:

1. De-minify only targeted class regions, not whole bundles.
2. Trace host-side implementations hidden behind RPC/bridge actions such as `load_from_prod`, `LocalWorkspace.merge`, `WCWorkspace.merge`, `WCWorkspace.install`, and `WCWorkspace.serializeDir`.
3. Locate or reconstruct standalone service-worker/tracker/bootstrap artifacts (`/__sw__.html`, `/__sw__blank.html`, `/__sw__tracker.js`, `/assets/tracker.4FYFXZYK.iife.js`, and `/assets/webcontainer.RMFWBHQ3.mjs?file`) if they are available outside this bundle.
4. Continue commit research only if server-side artifacts or another client bundle are available; the visible `ScrimCommit`/`ide-commit-dialog` client path has been traced.
5. If product parity is the goal, decide whether Next Editor should emulate Scrimba's action stream/branch cursor or keep its existing frame/delta recording model.
