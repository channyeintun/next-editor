# VS Code Recording and Playback Extension Architecture Research

Date: 2026-07-19

Status: Research conclusion; no implementation decisions beyond the recommendations and validation gates described here.

## Scope and product boundary

This work is a clean-sheet VS Code extension inspired by the recording and playback concept of the existing application. It is not a port of the existing implementation.

The proposed extension must therefore:

- Leave the main application unchanged.
- Avoid sharing or reusing its core machines, storage code, DMP codec, or `.ne` format.
- Use VS Code's native extension APIs as the source of recording events.
- Model a recording as a session containing many documents, editor surfaces, and tab groups, rather than as one editor model.
- Choose its playback renderer based on measured VS Code extension performance, not because the existing application uses Monaco.
- Use an extension-owned recording format with no interoperability requirement.

The resulting high-level architecture is:

```text
VS Code document/editor/tab events ─┐
                                    ├─> Session coordinator
Local audio recorder process ───────┘       │
                                            ▼
                                  journal + checkpoints
                                            │
                                            ▼
                                   extension recording
                                            │
                                            ▼
                              read-only custom editor player
```

## Research conclusion

The best fit for VS Code is a local UI extension with two distinct responsibilities:

1. The extension host observes native VS Code document, editor, tab, and workspace events and writes an append-only recording journal.
2. A read-only custom editor opens the finalized recording and renders the complete session in a controlled webview player.

The capture coordinator should not run in a webview. A webview has no privileged access to native editor state and cannot reliably acquire a microphone in desktop VS Code. The webview is useful for playback because it provides a controlled rendering surface without modifying the user's real files, editor groups, dirty state, or undo history.

If live audio is a product requirement, desktop audio capture should be handled by a small standalone process running locally beside the UI extension. Audio should not be assigned to an assumed `getUserMedia` or `MediaRecorder` implementation inside an extension webview.

## 1. Native VS Code session model

VS Code distinguishes between documents, editor views, tabs, and tab groups. Treating them as one model would lose important session behavior.

### Text documents

A `TextDocument` represents shared textual content and metadata. A document can remain open without being visible and can be presented by more than one editor view.

The recording should assign a session-local `documentId` when a document is enrolled. Its descriptor should contain:

- `documentId`
- Workspace `rootId`, when applicable
- Logical path relative to the workspace root
- Display name
- URI scheme classification, without persisting an absolute machine path by default
- Language identifier
- End-of-line mode
- Initial content checkpoint reference
- Initial VS Code document version

### Editor surfaces

A `TextEditor` is a particular view of a text document. The same document can be visible in multiple splits, and each view can have different selections and visible ranges.

Each observed editor view therefore needs a distinct `surfaceId` with state such as:

- `surfaceId`
- `documentId`
- `groupId`
- View column or reconstructed logical slot
- Selections
- Vertical visible ranges
- Active/focused state
- Supported surface kind

Content belongs to the document. Selection, viewport, focus, and group placement belong to the surface.

A `WeakMap<TextEditor, surfaceId>` is suitable for live object identity. The event log must use the stable session-local string identifier rather than trying to serialize the API object.

### Tabs and tab groups

A `Tab` is a graphical tab and is not guaranteed to have a normal `TextEditor` behind it. Tab inputs may represent text, diffs, notebooks, custom editors, webviews, or terminals.

`TabGroup` exposes its tabs, active tab, active state, and view column, but the public API does not provide a durable group ID, exact split orientation, split weights, or pixel geometry. The recorder must assign session-local group identities and reconcile them from successive snapshots.

Tab and group events should trigger a short reconciliation step that records a coherent topology snapshot. Content-edit events must never be debounced or coalesced away.

### Workspace roots

Multi-root workspaces must be represented explicitly. Each workspace folder receives a session-local `rootId`, display name, and ordinal. Documents store a logical path relative to their root. Untitled documents and documents outside any workspace root use `rootId: null`.

The recording should not assume that different roots have a shared filesystem or that the recorded workspace will exist during playback.

## 2. Capture event architecture

The session coordinator should subscribe to the following public APIs:

- `workspace.onDidChangeTextDocument`
- `workspace.onDidOpenTextDocument`
- `workspace.onDidCloseTextDocument`
- `workspace.onDidSaveTextDocument`
- Workspace folder and file-operation events where useful
- `window.onDidChangeTextEditorSelection`
- `window.onDidChangeTextEditorVisibleRanges`
- `window.onDidChangeActiveTextEditor`
- `window.onDidChangeVisibleTextEditors`
- `window.onDidChangeTextEditorViewColumn`
- `window.tabGroups.onDidChangeTabs`
- `window.tabGroups.onDidChangeTabGroups`
- Window focus changes when available through supported APIs

### Initial enrollment

At recording start, capture an initial snapshot containing:

- Workspace folders
- Tab groups and tabs
- Visible text editors
- Active tab group, active tab, and active editor
- Complete contents and metadata for initially visible supported documents

After start, enroll a document when it first becomes visible:

1. Record a complete checkpoint of its current contents and metadata.
2. Continue recording its document changes if it later becomes hidden.
3. Do not capture documents that were never visible during the session.

This policy gives playback enough state to reconstruct everything the user saw while limiting incidental background capture, recording size, and privacy exposure.

### Text change transactions

`workspace.onDidChangeTextDocument` emits a transactional `TextDocumentChangeEvent`. Its changes include:

- `rangeOffset`
- `rangeLength`
- Replacement `text`
- A range in line/column form
- The resulting `TextDocument`, including its new monotonically increasing version
- An optional reason identifying undo or redo

Offsets are measured in UTF-16 code units. The recording format must define this explicitly even if snapshots are encoded as UTF-8 bytes.

VS Code's current mirror-model implementation applies the changes in array order. The extension should nevertheless maintain a per-document shadow and verify the result against `document.getText()` after each transaction. If the previous version is unexpected or the reconstructed text differs, emit a complete checkpoint and continue from the observed VS Code state.

Every document transaction should record:

- `documentId`
- Before and after versions
- Atomic ordered change batch
- Undo/redo reason when supplied
- Before and after content hashes
- End-of-line changes when observed

Periodic complete checkpoints are still required for seeking, corruption containment, and crash recovery.

References:

- [VS Code `TextDocumentChangeEvent` API](https://code.visualstudio.com/api/references/vscode-api#TextDocumentChangeEvent)
- [Current VS Code mirror text model](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/model/mirrorTextModel.ts)

### Ordering and timestamps

Extension API events are observations made in the extension host. They are not exact physical keyboard or mouse timestamps, and VS Code does not document a causal ordering relationship across all event families.

Each callback should perform minimal synchronous work and immediately assign:

```text
seq:  globally increasing integer
tUs:  monotonic microseconds from the session origin
```

`seq` is authoritative for ties and observed ordering. `tUs` controls playback timing. The callback should enqueue an immutable event and return; serialization and journal writes happen through a single ordered writer.

Related topology, focus, and visibility events can be reconciled at the end of the current event burst. Document changes cannot be dropped, delayed behind a lossy debounce, or merged without validation.

## 3. Capture fidelity and API limits

### High-fidelity observations

The public API provides enough information to capture:

- Text contents and transactional edits
- Multiple documents
- Multiple editor views of the same document
- Active editor changes
- All selections in a text editor
- Whether a selection change was associated with mouse, keyboard, or command input
- Vertical visible ranges
- Tab and tab-group membership
- View columns
- Workspace roots
- Untitled and non-file text documents

### Approximate observations

The following can only be approximated:

- Split layout: view columns and membership are observable, but orientation, proportions, and pixel sizes are not fully exposed.
- Event time: timestamping occurs when the extension host receives the event.
- External edits: changes reflected in an open `TextDocument` can be recorded, but their originating process may not be identifiable.
- Horizontal viewport position: visible-range events describe vertical document ranges, not exact horizontal scroll.

### Unavailable through supported APIs

Extensions cannot access the VS Code workbench or native editor DOM. Consequently the extension cannot faithfully capture:

- Mouse coordinates over the real editor
- Pixel geometry of cursors or selections
- Horizontal scroll position
- Hover widgets
- Suggest/completion widget state
- Peek views
- Inline widgets owned by other extensions
- Exact fold state through a general public recording API
- Generic terminal output or third-party custom-editor contents

The product should never imply that these states are recorded when they are not.

Reference: [VS Code extension capability restrictions](https://code.visualstudio.com/api/extension-capabilities/overview#restrictions)

### Surface support policy

The first version should support normal text editors across many documents, groups, and workspace roots.

Other surface types require separate adapters:

- Diff editors need original/modified document and view-state semantics.
- Notebooks need cell structure, metadata, execution state, and output events; recording only cell text is insufficient.
- Terminals require a terminal-specific design and permission/privacy policy.
- Third-party custom editors cannot be generically introspected.
- Webview tabs expose no generic semantic state to another extension.

When an unsupported surface becomes active or visible, record an explicit opaque/unsupported surface marker and topology state rather than silently treating it as a supported text editor.

## 4. Audio architecture

### Why capture audio should not live in a webview

In current desktop VS Code source, extension webviews are allowed a small permission set including pointer lock and clipboard operations. The `media` permission appears in the permissions allowed for VS Code's core window, not in the extension-webview set.

Therefore an extension architecture must not assume that microphone `getUserMedia()` or `MediaRecorder` works in a desktop extension webview. The Node-based extension host also does not provide browser media APIs.

Reference: [Current VS Code Electron permission configuration](https://github.com/microsoft/vscode/blob/main/src/vs/code/electron-main/app.ts#L2655-L2718)

VS Code also contains internal screen-media handling, but that is implementation code rather than a stable extension API. It must not be treated as a supported screen-capture contract for extensions.

### Recommended desktop audio design

If live narration is required, declare the extension as a local UI extension with:

```json
"extensionKind": ["ui"]
```

Ship a small standalone recorder executable for each supported desktop platform. Prefer a standalone process over a Node native addon to avoid Electron and Node ABI coupling.

The recorder protocol should support messages such as:

- `READY`
- `START`
- `STARTED`
- `LEVEL`
- `PROGRESS`
- `STOP`
- `STOPPED`
- `ERROR`

The helper should write encoded audio directly to the session's local temporary directory. The extension host should not buffer the complete audio stream in memory.

Running as a UI extension keeps the recorder local when the workspace is accessed through Remote SSH or a Dev Container. VS Code APIs can still observe the remotely hosted workspace and documents, while the microphone process executes where the user's microphone exists.

References:

- [VS Code extension host placement](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [Remote extension architecture](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
- [Platform-specific extension packages](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions)

### Audio-anchored timing

The extension-host coordinator should own the recording lifecycle:

```text
idle → arming → recording → stopping → finalized
                   └───────────────→ failed/recovering
```

The user-facing recording state should not become active until the audio helper reports readiness. Establish a common session origin, store the audio start offset and first confirmed sample position, and preserve enough timing metadata to detect startup delay or audio discontinuity.

During playback, the webview's audio element should be the authoritative clock. Visual playback should derive the desired event position from audio time on each animation frame rather than running a separate long-lived timer that can drift.

### Audio risks

The native helper is the highest-risk capability because it must be proven across:

- macOS microphone permission and TCC behavior
- Windows microphone privacy settings
- Linux PipeWire and PulseAudio environments
- x64 and ARM packaging targets
- Marketplace package size and review expectations
- Extension updates while incomplete sessions exist
- Remote and virtual workspace configurations

If narration is mandatory for the first release, a cross-platform helper spike is Phase 0. If it is not mandatory, the cheapest correct milestone is multi-document visual recording and playback without audio, followed by audio after feasibility is established.

Camera and screen capture should be later, independent capabilities rather than assumptions embedded in the core session model.

## 5. Playback surface assessment

### Recommended primary surface: read-only custom editor

The authoritative player should be implemented with a `CustomReadonlyEditorProvider` for the extension's recording artifact.

This is a first-class VS Code integration: the recording opens as an editor tab and participates in normal file associations and editor lifecycle. Its webview provides a controlled surface in which the extension can reconstruct the whole recorded session.

It is the strongest primary option because it:

- Never modifies the user's real workspace files.
- Avoids dirty scratch documents.
- Avoids undo-stack pollution.
- Does not rearrange the user's current tab groups during playback.
- Can render multiple recorded documents and groups in one controlled session view.
- Keeps the visual renderer and audio playback clock in the same JavaScript realm.
- Allows efficient seeking through checkpoints without issuing high-frequency native workspace edits.

Reference: [VS Code custom editors](https://code.visualstudio.com/api/extension-guides/custom-editors)

The custom editor should initially set `supportsMultipleEditorsPerDocument` to false, or otherwise coordinate a single authoritative playhead, to avoid two views independently playing the same recording and audio.

### `TextDocumentContentProvider`

A content provider creates read-only native VS Code documents. It is useful as an optional companion command such as "Open recorded document at current time in VS Code."

It is not the best authoritative player because:

- Updates are resource invalidations after which VS Code asks for document content again.
- A multi-document replay would open and manage real VS Code tabs and groups.
- The extension cannot reconstruct exact recorded split dimensions.
- It would add playback documents to the user's current editor topology.
- It is poorly matched to one coherent audio-driven session containing many simultaneous surfaces.

Reference: [VS Code virtual documents](https://code.visualstudio.com/api/extension-guides/virtual-documents)

### Untitled or in-memory scratch documents

Driving scratch documents with `TextEditor.edit` or `WorkspaceEdit` gives native rendering, but introduces:

- Dirty document state
- Undo history
- Asynchronous edit application
- Potential user interference
- High-frequency edit pressure
- Focus and tab-layout disruption
- Difficulty representing the same recorded document in several independent views

This is not suitable as the primary player. It may still be useful for an explicit export or inspection workflow initiated by the user.

### Renderer choice inside the custom editor

The architecture should define a renderer interface without prematurely selecting Monaco.

At minimum, benchmark Monaco and CodeMirror 6 against representative recordings containing:

- Several simultaneously visible document surfaces
- Repeated switching between tabs and groups
- Large documents
- Rapid edit bursts
- Multiple selections
- Frequent checkpoint seeks
- Theme changes

Measure:

- Initial load time
- Memory consumption
- Patch-to-paint latency
- Seek latency
- Performance with multiple visible surfaces
- Ease of preserving independent selection and viewport state
- Language rendering/tokenization cost

Monaco may prove advantageous because of its model and view-state APIs, but that conclusion must come from the extension benchmark rather than from the existing application's choice.

### Webview lifecycle

Hidden webview contents are normally destroyed unless `retainContextWhenHidden` is enabled. Retaining a multi-document player can consume substantial memory.

The default strategy should be:

1. Pause playback when the custom editor becomes hidden.
2. Persist only compact state such as playhead, selected surface, playback rate, and UI preferences with `setState`.
3. Reconstruct renderer state from the nearest checkpoint when the webview becomes visible again.
4. Use a webview-ready handshake before sending recording state.
5. Acknowledge important messages because successful `postMessage` submission is not proof that the application processed the message.

Reference: [VS Code webview persistence](https://code.visualstudio.com/api/extension-guides/webview#persistence)

## 6. Extension-owned recording storage

The extension needs its own persistent recording artifact, but this is entirely separate from the main application's core and storage.

There is no `.ne` compatibility goal and no reason to carry DMP or the main application's model assumptions into the extension.

### Logical schema

A versioned logical recording should contain:

```text
manifest
workspace roots
document descriptors
surface descriptors
group/topology snapshots
globally ordered events
document checkpoints
seek index
audio metadata and files, when enabled
capability and failure markers
```

Representative event types include:

- `document.enroll`
- `document.patch`
- `document.checkpoint`
- `document.language`
- `document.eol`
- `document.save`
- `surface.open`
- `surface.close`
- `surface.focus`
- `surface.selection`
- `surface.viewport`
- `topology.snapshot`
- `roots.snapshot`
- `window.focus`
- `audio.started`
- `audio.discontinuity`
- `capability.unsupported`
- `recording.error`
- User-defined markers

Every timed event should use the common envelope:

```text
{ seq, tUs, type, payload }
```

### Working session and finalization

Attempting to update one archive continuously during recording creates unnecessary crash-recovery complexity. Use two representations:

1. An append-only working session directory in local extension storage.
2. A finalized, versioned extension artifact after a clean stop.

The working session can contain an event journal, periodic document checkpoints, audio output, and recovery metadata. At finalization, validate it, build a seek index, and package it into the user-facing recording.

This design permits recovery after extension-host crashes, window reloads, workspace-root transitions, or audio-helper failure.

### Privacy and security

Recordings contain source code and potentially narration. The extension should:

- Enroll only documents that become visible.
- Show an unambiguous recording indicator.
- Provide exclusion patterns.
- Avoid recording absolute paths by default.
- Avoid network upload by default.
- Warn about secrets and sensitive files.
- Treat imported recordings as untrusted.
- Enforce archive entry, event count, document size, and decompressed-size limits.
- Prevent archive path traversal.
- Render recorded code strictly as text.
- Use a restrictive webview content security policy.

## 7. Multi-root, remote, external-edit, and lifecycle behavior

### Multi-root workspaces

Root membership is event metadata, not a dependency on the live workspace. Playback must work without mounting or opening the original roots.

Adding or removing workspace folders can cause significant extension-host lifecycle changes in some workspace transitions. The append-only journal must be durable enough to recover a partial session rather than relying on a final stop handler.

### Remote workspaces

The extension should run as a local UI extension because the microphone and low-latency interaction are local. Document and workspace access should use VS Code APIs, including `workspace.fs` where needed, so remote resources are routed correctly.

The extension must not assume that Node's local filesystem APIs can directly read a Remote SSH or container workspace path.

Desktop support should be implemented first. VS Code for the Web is a separate capability tier because it lacks a native helper and has different browser permission and filesystem constraints.

### External file edits

VS Code file create, rename, and delete events do not capture every operation performed by external applications or through all filesystem paths. Open document models may still update after VS Code observes an external disk change, but the extension often cannot reliably identify its origin.

The product contract should state:

> The extension records changes reflected in supported open VS Code document models, not complete filesystem history.

Reference: [VS Code workspace API event limitations](https://code.visualstudio.com/api/references/vscode-api#workspace)

### Multiple windows

A recording session is scoped to one VS Code window and its extension-host instance. A single extension instance cannot reconstruct a globally ordered event stream spanning independent VS Code windows.

Use a unique session directory per window/session and either allow independent recordings or enforce a local lock policy later. Do not claim cross-window recording in the initial product scope.

## 8. Failure modes and mitigations

### Extension-host lag

Failure: Event timestamps become late and the queue grows during heavy processing.

Mitigations:

- Keep callbacks constant-time apart from necessary document validation.
- Use a single ordered writer.
- Monitor queue depth and write latency.
- Emit overload markers rather than silently losing content changes.
- Use checkpoints to recover from detected shadow divergence.

### Event ordering ambiguity

Failure: Focus, tab, visibility, and editor-position events arrive as several observations of one UI action.

Mitigations:

- Assign `seq` at callback entry.
- Associate content events directly with their `documentId`.
- Reconcile UI topology into coherent snapshots after event bursts.
- Make playback deterministic from recorded sequence rather than attempting to infer the user's physical action.

### Audio startup skew or discontinuity

Failure: Visual events begin before the microphone is active, or audio drops/restarts.

Mitigations:

- Use an arming state and explicit helper readiness.
- Store audio-start offset and sample progress.
- Record discontinuity/error markers.
- Allow a visual-only degraded recording if product policy permits.

### Webview hidden or disposed

Failure: Playback state is lost or audio keeps running while the visual player is absent.

Mitigations:

- Pause on hide.
- Persist a compact playhead state.
- Restore from checkpoints after the webview-ready handshake.
- Avoid `retainContextWhenHidden` until measurements justify its memory cost.

### Workspace reload or extension crash

Failure: Finalization does not run.

Mitigations:

- Append and flush a recovery journal throughout recording.
- Use session UUID directories.
- Discover and offer recovery of incomplete sessions on activation.
- Make finalization repeatable and idempotent.

### Unsupported surface

Failure: Playback appears complete while important state was never captured.

Mitigations:

- Record explicit capability markers.
- Show the limitation in the player timeline.
- Add independent adapters rather than weakening the core text-session model.

### Large documents and long sessions

Failure: Excessive memory, event volume, checkpoint size, or slow seeking.

Mitigations:

- Establish document and session limits.
- Use adaptive checkpoint intervals.
- Write incrementally rather than buffering a session in memory.
- Build a seek index at finalization.
- Benchmark representative worst cases before choosing the player renderer and serialization encoding.

## 9. Riskiest assumptions to validate first

The following assumptions should remain explicit validation gates:

1. A standalone microphone helper can be packaged, permissioned, and supported reliably across the selected desktop platforms.
2. Public tab, group, editor, and visibility events are sufficient to reconstruct a useful multi-document topology despite missing stable group identifiers and split geometry.
3. A per-document shadow remains correct for multi-cursor edits, formatters, code actions, undo/redo, EOL changes, external refreshes, and large replacements.
4. At least one renderer can smoothly display multiple recorded document surfaces and seek quickly within acceptable memory limits.
5. A local UI extension receives editor events with acceptable latency for Remote SSH and Dev Container workspaces.
6. Crash recovery and repeated finalization preserve a usable partial session after extension-host or audio-helper failure.
7. Users find the explicitly supported fidelity boundary useful without mouse coordinates, exact split geometry, horizontal scroll, hover/suggest state, and generic third-party surface capture.

## 10. Recommended validation and implementation sequence

### Phase 0A: native event and topology spike

Build the smallest Extension Development Host prototype that observes but does not yet package:

- Two documents edited alternately
- The same document in two splits
- Tab moves between groups
- Group creation and closure
- Multi-cursor edits
- Undo and redo
- Formatting and code actions
- Untitled documents
- A multi-root workspace
- A remote workspace if available
- Diff, notebook, terminal, and custom-editor transitions as unsupported markers

Success criteria:

- Deterministic document and surface identities
- Shadow contents match VS Code after every transaction
- Topology snapshots remain internally consistent
- No content events are lost under representative edit rates

### Phase 0B: playback renderer spike

Create a read-only custom editor that consumes synthetic multi-document session data through a renderer abstraction.

Benchmark Monaco and CodeMirror 6 with the same recordings and record load time, memory, edit-to-paint latency, and seek latency. Select the renderer only after these results.

### Phase 0C: native audio helper spike

If narration is required, prove:

- Permission prompts and denial behavior
- Start/stop reliability
- Timestamp/sample alignment
- Crash handling
- Direct-to-disk output
- Platform-specific packaging
- Behavior with local and remote workspaces

Do this before designing the full audio UI or treating audio as guaranteed.

### Phase 1: visual vertical slice

Implement:

- Start/stop commands and an explicit recording indicator
- Extension-host session coordinator
- Multi-document text capture
- Multiple editor surfaces and topology snapshots
- Selection and vertical viewport capture
- Append-only journal and checkpoints
- Recovery of an incomplete session
- Final extension-owned artifact
- Read-only custom editor playback
- Play, pause, seek, and multi-document navigation

Do not add camera, screen capture, notebooks, terminal capture, or shared main-app behavior in this phase.

### Phase 2: audio integration

After the helper spike succeeds:

- Package supported platform binaries
- Add microphone selection and permission UX where possible
- Add the arming/recording/stopping lifecycle
- Store sample-based synchronization metadata
- Make audio the playback clock
- Define visual-only fallback and audio-failure policy

### Phase 3: hardening and optional adapters

Add:

- Performance and storage limits
- Privacy exclusions and warnings
- Corrupt/untrusted recording defenses
- Remote-workspace verification
- Optional native recorded-document inspection
- Diff and notebook adapters only when their fidelity contracts are designed
- Camera or screen capture only as independent, proven capabilities

## Final recommendation

Proceed with an extension-native, multi-document session recorder. Keep capture in the local extension host, use a recoverable append-only journal, and make a read-only custom editor the authoritative playback surface. Treat the renderer as a benchmarked component and native desktop audio as an early feasibility gate.

Do not port the main application's editor machines, storage, DMP codec, `.ne` format, or single-model assumptions into this project.
