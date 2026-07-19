# VS Code Recording and Playback Port: Architecture Assessment

Date: 2026-07-19

Scope: Assessment of the recording/replay machines in `src/core/src/machine/`, the DMP WASM codec in `src/core/dmp/`, and the SCR3/`.ne` storage path. This is a read-only design assessment; no implementation, builds, tests, or typechecks were performed.

## Executive summary

A playback-only `.ne` custom editor is the right first milestone. It should use a `CustomReadonlyEditorProvider` with the existing Monaco/web playback path inside a webview.

For native capture, the browser-dependent machine and media actors should initially remain in a recording webview. The extension host should observe VS Code editors and send portable, timestamped capture events to that webview. A broad `ICodeEditor` compatibility shim would hide important differences between Monaco and VS Code and is not recommended.

For replay, in-webview Monaco should remain the primary surface. Native scratch documents are feasible as an optional mode, but they are poorly suited to high-frequency animated edits.

The largest format risk is document identity: v4 frames cannot identify arbitrary VS Code documents, workspace roots, or editor groups. Native multi-document capture therefore requires either a deliberately constrained v4 scope or a shared format evolution.

## 1. Portable core and required adapters

| Area                                                                   | Assessment                                                                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frame encoding, delta application, reconstruction, and replay reducers | Portable as-is. These are predominantly pure data transformations.                                                                                       |
| DMP WASM implementation                                                | Portable as-is; its loader needs an environment adapter.                                                                                                 |
| SCR3/`.ne` encoder and decoder                                         | Reuse exactly. Extract into a shared package instead of cloning it into the extension.                                                                   |
| `timelineMachine`                                                      | Runs largely as-is in a webview. It cannot run unchanged in the extension host because it uses `requestAnimationFrame`.                                  |
| `editorMachine`                                                        | Reuse the statechart and event semantics, but not the file verbatim. It currently wires Monaco, browser actors, clocks, `Blob`, and media APIs directly. |
| Capture/replay actions                                                 | Need explicit capture and rendering ports.                                                                                                               |
| Audio/camera/screen actors                                             | Webview-only, with runtime capability checks.                                                                                                            |
| Mouse actor                                                            | Reusable only for content inside the webview. It cannot observe pointer coordinates over native VS Code editors.                                         |

The current serialized frame is Monaco-shaped: it contains content, Monaco selection/position, Monaco view state, mouse state, and other app-specific state ([`types.ts`](../src/core/src/types.ts#L177)). The capture path synchronously reads `ICodeEditor` and `ITextModel` ([`captureActions.ts`](../src/core/src/machine/captureActions.ts#L396), [`editorMachineHelpers.ts`](../src/core/src/machine/editorMachineHelpers.ts#L370)).

The Monaco dependency should be replaced with a portable capture sample, conceptually:

```text
sessionId, webviewEpoch, sequence
sourceTimestamp
documentId, beforeVersion, afterVersion
beforeLength, afterLength
changes[]: offset, deleteLength, text
selection, activePosition
optional fullContent resync
```

### Extension-host capture adapter

The host adapter should map VS Code events as follows:

- `onDidChangeTextDocument` becomes one transactional edit event.
  - `rangeOffset` maps to `offset`.
  - `rangeLength` maps to `deleteLength`.
  - `text` maps to `text`.
  - Keep a per-document shadow version, length, and preferably content/hash.
  - Do not assume `beforeVersion === afterVersion - 1`; use the stored previous version.
  - If versions, lengths, or hashes disagree, send a full snapshot and force a keyframe.
- `onDidChangeTextEditorSelection` becomes a Monaco-shaped structural selection.
  - VS Code uses zero-based line/character coordinates; the recording uses one-based Monaco coordinates.
  - Preserve anchor/active direction as well as ordered start/end.
- `onDidChangeTextEditorVisibleRanges` provides approximate vertical reveal information only.
  - VS Code does not expose horizontal visibility through `visibleRanges`, so it cannot reproduce Monaco `viewState` faithfully.
  - Native captures should set `viewState` to `null` rather than fabricate it.
- `onDidChangeActiveTextEditor` becomes a document-switch barrier and full snapshot.
  - For the first capture release, recording should stop or pause when the active document changes.

VS Code provides transactional content changes and strictly increasing document versions, including changes caused by undo and redo. This aligns well with the existing exact-edit model. See the official [`TextDocumentChangeEvent`](https://code.visualstudio.com/api/references/vscode-api#TextDocumentChangeEvent), [`TextDocumentContentChangeEvent`](https://code.visualstudio.com/api/references/vscode-api#TextDocumentContentChangeEvent), and [`TextDocument`](https://code.visualstudio.com/api/references/vscode-api#TextDocument) APIs.

One important protocol rule is that the host should timestamp an event when it observes it. The webview must not assign the timestamp when the message arrives.

### Replay adapter

Frame reconstruction can remain unchanged. Its output should be passed to an `EditorRenderPort` with two implementations:

- The webview implementation calls the existing Monaco `applyFrameState` path.
- The native implementation calculates the same minimal prefix/suffix replacement, converts offsets with `document.positionAt`, edits a scratch document, sets its selection, and calls `revealRange`.

All replay-generated native operations should carry a session token or suppression marker so they cannot be recaptured as user edits.

### Suggested package boundaries

The current core export surface includes UI and application concerns. A cleaner shared boundary would be:

- `recording-model`: frame DTOs, schema, frame deltas, encoder, reconstruction, and replay reducers.
- `scr3-codec`: SCR3 encoder/decoder, DMP binder, and the pinned WASM artifact.
- `recording-machine`: XState coordination against injected clock, capture, render, media, and persistence ports.
- Platform adapters: Monaco/browser, VS Code extension host, and VS Code webview.

## 2. Machine placement, clocks, and host/webview bridging

For the first native-capture architecture, `editorMachine`, the timeline, media actors, DMP, and the streaming encoder should run in a dedicated webview. The extension host should own VS Code observation, URI/workspace identity, and durable file writing.

```text
Native VS Code editors
        | editor/document events
        v
Extension-host broker ----- durable .ne/media chunks
        | ordered, timestamped messages
        v
Recording webview
machine + timeline + media + codec + optional Monaco
```

### Current clock behavior

The current playback is not actually audio-anchored. The timeline's rAF wall clock is the master, and audio is periodically nudged toward it ([`audioActor.ts`](../src/core/src/machine/audioActor.ts#L268)).

If audio anchoring is a requirement, playback should use `HTMLAudioElement.currentTime` as the rAF-sampled clock whenever audio exists. The performance clock should be the fallback for recordings without audio. Seek should reposition both audio and editor state before resuming.

During capture, session zero should be established only when the audio recorder reports that it started. Editor events observed while media permission or startup is pending should be buffered and subsequently mapped onto that origin.

### Failure modes and mitigations

| Failure                                   | Mitigation                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Messages are delayed or reordered         | Attach a session ID, webview epoch, and strictly monotonic sequence number. Acknowledge important batches and reject duplicates or stale epochs.                                                                                |
| Host and webview clocks differ            | Timestamp at the host event source. Estimate host-to-webview monotonic-clock offset with repeated ping/pong samples, select the lowest-latency sample, and recalibrate periodically.                                            |
| Edits occur while media is starting       | Arm the host first and buffer events. Establish session zero only when the recorder reports that it started.                                                                                                                    |
| Text-edit messages back up                | Text changes cannot be silently dropped. Coalesce selection and viewport events; on content gaps, request a full snapshot and force a keyframe. Stop with a recoverable partial recording if a bounded content queue overflows. |
| Stop messages race with final edits       | Use a two-phase stop: freeze capture, drain through a sequence barrier, then finalize audio and the SCR3 footer.                                                                                                                |
| Webview is hidden or destroyed            | Retain context only during recording, persist stream/media chunks continuously in the host, and treat disposal as an interrupted but recoverable recording.                                                                     |
| Extension reloads or webview is recreated | Store only identifiers and small UI state with `setState`; never store recording bytes there. Rebuild playback from the host-owned file and seek to the restored playhead.                                                      |
| Remote workspace adds latency             | Treat Remote SSH/Codespaces as a separate capability tier and measure the bridge under realistic latency before supporting recording there.                                                                                     |

VS Code normally destroys hidden webview content. `retainContextWhenHidden` changes that behavior but has a meaningful memory cost, so normal playback should prefer restoration through `getState`/`setState` ([Webview API](https://code.visualstudio.com/api/extension-guides/webview)). Remote extension placement and local webview behavior are described in the [Remote Extensions guide](https://code.visualstudio.com/api/advanced-topics/remote-extensions).

SCR3 and MediaRecorder chunks should be streamed into host-owned temporary files throughout capture. A webview crash would then lose only the unacknowledged tail rather than the complete recording.

## 3. Replay surface comparison

### 3.1 In-webview Monaco: recommended

This is the only option that preserves the existing synchronous frame application, Monaco view state, cursor decorations, and high-frequency animation without extension-host IPC or VS Code undo history. The web app already uses separate playback models rather than editing source files ([`models.ts`](../src/monaco/models.ts#L7)).

It should be the default playback surface, including inside the playback-only custom editor.

### 3.2 Native editable scratch document: optional

This provides native syntax services and accessibility, but every render is an asynchronous extension API operation. It must never target a real workspace file.

`TextEditor.edit` is preferable to `WorkspaceEdit` for the visible scratch editor: `TextEditor.edit` exposes `undoStopBefore` and `undoStopAfter`, while `workspace.applyEdit` does not. Even with undo stops suppressed, the scratch buffer still accumulates edit history and dirty state. Untitled documents can also produce save prompts. See [`TextEditorEditOptions`](https://code.visualstudio.com/api/references/vscode-api#TextEditorEditOptions) and [`workspace.applyEdit`](https://code.visualstudio.com/api/references/vscode-api#workspace.applyEdit).

If native rendering falls behind, it should skip intermediate display frames and render the latest reconstructed state. This preserves the final content but reduces the fidelity of very rapid typing.

An in-memory writable filesystem scheme is preferable to raw untitled documents if this mode is pursued, although it does not eliminate undo history or asynchronous edit costs.

### 3.3 `TextDocumentContentProvider`: not suitable for animation

This surface is safe and read-only, but each invalidation asks the provider for the document content again. Replacing a complete virtual document repeatedly causes excessive document churn and makes cursor/scroll synchronization awkward.

It is suitable for a static snapshot or seek result, not 30-60 Hz playback. See [Virtual Documents](https://code.visualstudio.com/api/extension-guides/virtual-documents).

## 4. Features that break or degrade

### Screen capture

`getDisplayMedia` in a webview should be treated as an optional runtime capability, not an extension-platform contract. It requires a direct user gesture inside the webview, and behavior can vary across VS Code Desktop, VS Code Web, remote setups, operating systems, and permission policies.

The current screen recording is local-only and is never folded into the `.ne` recording. Even successful screen capture therefore does not become part of cross-product `.ne` playback.

### Mouse tracking over native editors

The public VS Code API does not expose native editor pointer coordinates. The extension can record semantic caret, selection, active-editor, and visible-range changes, but it should not fabricate a mouse trail. A webview can track only pointer activity within its own DOM.

### Multi-root workspaces

This is a format problem rather than only an adapter problem. `EditorFrame` has no document URI or workspace-root identity, while the workspace snapshot is an application-specific project structure ([`workspace.ts`](../src/types/workspace.ts#L136)).

For v4 compatibility, native capture should be restricted to one document or one explicitly constructed virtual project. Full multi-root fidelity calls for a shared schema evolution that defines recording-relative document IDs and root manifests without leaking absolute local paths.

### Split editors

Frames have no editor-group or surface identifier. The initial adapter should capture only the active editor. Reproducing two views of one document, different scroll positions, or simultaneous selections requires a new surface identity in the recording model.

### External file edits

Changes that reach an open VS Code `TextDocument` can be captured, whether they came from typing, undo, another extension, or a formatter. Raw filesystem changes to inactive documents do not provide usable content deltas.

On document activation, the adapter should compare URI, version, length, and hash with its shadow state and emit a full snapshot when they differ. The initial product should promise active-editor history, not complete filesystem history.

### Viewport fidelity

Native capture can approximate vertical reveal but cannot reproduce horizontal scroll, exact pixel offsets, Monaco folding/view zones, or full Monaco view state.

### App-specific tracks

Slides, preview/runtime state, whiteboard, chat, and similar web-app concepts have no direct native VS Code equivalents. They remain playable in the webview, but recording them requires explicit feature-specific adapters.

## 5. `.ne` byte compatibility

The safest definition of byte compatibility is mutual interoperability: both products use the same encoder, decoder, recording schema, and DMP WASM binary. Literal deterministic byte-for-byte output additionally requires identical metadata ordering, compression implementation/version, generated IDs, and timestamps.

Important constraints are:

- SCR3 stream format is currently version 4 and has explicit compressed, inflated, asset, record-count, and total-size limits ([`format.ts`](../src/storage/streamingRecordingCodec/format.ts#L56)). The extension should reuse this implementation rather than reproduce it.
- The recording schema accepts exactly version 4 ([`types.ts`](../src/core/src/types.ts#L198)). Extension-only fields should not be added informally to v4.
- A `.ne` file is not necessarily self-contained. Audio and camera bytes are deliberately external sibling files ([`encode.ts`](../src/storage/streamingRecordingCodec/encode.ts#L247), [`RecordingStorage.ts`](../src/storage/RecordingStorage.ts#L147)). The extension needs the same filename and fallback-resolution rules. Missing companions should produce silent or video-less playback rather than invalidate the `.ne` file.
- Screen video is not part of `.ne` at all.
- The DMP algorithm operates on UTF-8 bytes, while exact editor-change offsets follow JavaScript/Monaco string-offset semantics. The same implementations should be shared, with cross-product fixtures covering surrogate pairs, combining characters, CRLF, and multi-change transactions.
- The WASM implementation is reusable, but `loadDmpCodec` is Vite-oriented. The extension host should read the same `.wasm` artifact and call the existing byte-instantiation entry point ([`dmpCodec.ts`](../src/storage/dmpCodec/dmpCodec.ts#L109), [`src/core/dmp/README.md`](../src/core/dmp/README.md)).
- The largest compatibility obstacle is document identity: content deltas do not serialize a file path, root, or editor surface. This cannot be repaired solely by a VS Code adapter.

The compatibility suite should include:

- Web encode to extension decode, compared frame by frame.
- Extension encode to web decode, compared frame by frame.
- Shared DMP fixtures for Unicode, surrogate pairs, combining characters, CRLF, and multi-change transactions.
- Companion audio/camera discovery and missing-media behavior.
- Incomplete-stream recovery and finalization.
- Corrupt and adversarial stream inputs at every declared size limit.
- Optional canonical-recording-to-exact-bytes fixtures if deterministic encoding is an explicit requirement.

## 6. Playback-only custom editor milestone

This is both inexpensive and strategically useful. It should be implemented as a `CustomReadonlyEditorProvider`, the VS Code abstraction intended for interactive read-only binary views ([Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors)).

### Proposed scope

1. Register `*.ne` as an optional custom editor instead of immediately replacing the default file association.
2. Read the file through `workspace.fs` so remote and virtual workspace URIs work.
3. Host a thin playback entrypoint containing the existing decoder, DMP WASM, timeline, audio actor, and Monaco replay renderer.
4. Resolve referenced audio/camera companions in the extension host and expose them to the webview. Initially reading audio into a `Blob` is the lowest-change route because the current audio playback state expects one.
5. Restore only URI, playhead, speed, and volume after webview recreation; re-decode and seek on restore.
6. Disable multiple simultaneous views of one recording initially.
7. Apply a restrictive content security policy. Treat `.ne` preview HTML and workspace assets as untrusted input, and never execute recorded HTML in the privileged parent webview context.
8. Handle missing media, malformed streams, hide/reopen, Unicode deltas, and remote URIs gracefully.

### What the milestone de-risks

- Webview bundling and Content Security Policy behavior.
- Loading the existing DMP WASM artifact.
- SCR3 decoding outside the web application.
- Audio/camera companion-file resolution.
- Webview disposal and restoration.
- Cross-product `.ne` compatibility.
- Untrusted-recording handling.

It does this without editing user files or committing to the native capture schema.

### Acceptance criteria

- Open a web-generated `.ne` in VS Code.
- Play, pause, seek, and change playback speed.
- Render Unicode and multi-change deltas correctly.
- Load sibling audio and camera media when present.
- Degrade gracefully when sibling media is missing.
- Survive hiding, reopening, and webview recreation.
- Open recordings through remote and virtual filesystem URIs.
- Report corrupt or unsupported files without crashing the extension host.

## Riskiest assumptions

1. **v4 can represent arbitrary VS Code workspaces.** It cannot currently identify documents, roots, or editor surfaces.
2. **`MediaRecorder`, `getUserMedia`, and `getDisplayMedia` work consistently in extension webviews.** This needs an early platform-matrix spike.
3. **Host-to-webview traffic can preserve typing timing under load and remote latency.** It requires sequencing, clock synchronization, backpressure, and measurement.
4. **Native scratch-document replay will look as smooth as Monaco.** This is unlikely at high edit rates because every edit crosses an asynchronous API boundary.
5. **A `.ne` file is the complete recording.** This is false whenever audio or camera media exists.
6. **Native pointer and split-editor fidelity are available.** They are not sufficiently exposed by the public API.
7. **The existing core can be reused without a package-boundary refactor.** Playback can be bundled quickly, but native capture will otherwise inherit browser, Monaco, UI, and storage coupling.

## Recommended sequence

1. Build the read-only `.ne` custom editor using webview Monaco.
2. Add shared compatibility fixtures and package the SCR3/DMP path once for both products.
3. Run a single-document capture spike with microphone audio, host-side event observation, clock synchronization, and continuous host persistence.
4. Measure media availability, bridge latency, edit burst behavior, webview lifecycle, and remote workspaces.
5. Decide on a shared post-v4 document/surface schema before promising multi-document, multi-root, or split-editor capture.
