# VS Code Recording and Playback Extension Implementation Plan

Date: 2026-07-19

Status: Ready for implementation handoff

Primary research: [VS Code Recording and Playback Extension Architecture Research](./vscode-recording-playback-extension-research.md)

Intended implementer: Claude Code

## 1. Handoff directive

Implement a new, self-contained VS Code extension that records and replays a multi-document VS Code editing session. This is a clean-sheet extension project. It is not a port of the current web application.

The first complete milestone is a visual, multi-document recording and playback vertical slice. Audio is a separately gated milestone because desktop microphone capture requires a native helper and platform-specific validation.

Do not silently change this plan. If implementation evidence invalidates an architectural decision, stop before making the conflicting change, explain:

1. What the plan currently requires.
2. What evidence contradicts it.
3. The smallest proposed change.
4. Its effect on scope, compatibility, testing, and risk.

Wait for approval before revising the plan or changing the architecture. Track routine progress in a separate implementation status document rather than rewriting this plan.

## 2. Non-negotiable boundaries

### 2.1 Allowed implementation area

Create the extension under:

```text
vscode-extension/
```

Implementation work should be confined to:

- `vscode-extension/**`
- A separate implementation status document under `vscode-extension/docs/`
- Architecture decision records under `vscode-extension/docs/adr/`
- This plan only after explicit approval for a plan revision

If CI integration later requires a repository-level `.github` change, explain it and request approval first.

### 2.2 Forbidden coupling

Do not:

- Modify the main application under `src/`.
- Modify `tube/`, `infra/`, or `remote-runtime/`.
- Modify the root `package.json`, root lockfile, root TypeScript configuration, or root Vite configuration for extension implementation.
- Import any module from the main application's `src/` tree.
- Reuse the existing editor or timeline machines.
- Reuse the main application's storage implementation.
- Reuse `src/core/dmp` or the DMP WASM codec.
- Read or write `.ne` files.
- Add `.ne` compatibility or interoperability work.
- Assume a recording contains one editor model.
- Drive playback by editing the user's real workspace files.
- Capture or upload data over the network by default.

Using a similar third-party dependency independently inside `vscode-extension/package.json` is permitted. Copying the main application's implementation is not.

### 2.3 Repository safety

Before implementation:

1. Read the root `CLAUDE.md` completely.
2. Check the operating system and obey its process and memory rules.
3. Inspect `git status --short` and preserve unrelated changes.
4. Read the architecture research document completely.
5. Do not create subagents on the Linux VPS.
6. Do not run full builds, tests, or typechecks on the Linux VPS.

On the macOS workstation, run the complete extension verification suite and the repository-required root verification suite before declaring implementation complete.

## 3. Product scope

### 3.1 Core visual milestone

The core milestone must support:

- Start and stop recording commands.
- A persistent, unambiguous recording indicator.
- Ordinary text documents across multiple workspace roots.
- Multiple simultaneously visible editor groups.
- Multiple editor surfaces showing the same document.
- Document edits, including multi-change transactions.
- Multi-cursor selections.
- Active editor, active tab, and active group changes.
- Vertical visible ranges.
- Tab moves, opens, closes, and group changes.
- Untitled text documents.
- Explicit markers for unsupported editor surfaces.
- Append-only working-session persistence.
- Recovery and finalization of an interrupted session.
- A versioned, extension-owned recording artifact.
- Read-only custom-editor playback.
- Play, pause, seek, speed control, and recorded topology navigation.
- Playback without opening or modifying the original workspace.

### 3.2 Audio milestone

After the audio feasibility gate passes for a platform, add:

- Local microphone recording through a standalone helper process.
- Audio permission and failure UX.
- Sample-based clock calibration.
- Audio metadata in the recording artifact.
- Audio-anchored playback.
- A clearly defined visual-only fallback.

Do not claim audio support on an operating system or architecture that has not passed the platform validation matrix.

### 3.3 Explicitly out of scope

The initial implementation excludes:

- `.ne` playback or writing
- Main-app interoperability
- Main-app code reuse
- Camera capture
- Screen capture
- Exact mouse coordinates
- Horizontal scroll capture
- Exact fold state
- Hover, suggest, peek, or inline-widget capture
- Generic terminal recording
- Generic third-party custom-editor recording
- Notebook structure, execution, and output recording
- Cross-window sessions
- VS Code for the Web
- Collaboration, upload, sharing, or cloud storage
- Editing a recording inside the custom editor

Diffs and notebooks may be added later only through explicit, separately designed adapters.

## 4. Definition of done

### 4.1 Core milestone is done only when

- All implementation lives inside `vscode-extension/`.
- The boundary test proves there are no imports from the main app.
- A session involving at least three documents, two groups, and one document shown in two groups records successfully.
- Replaying the finalized artifact produces the same document contents at every tested checkpoint.
- Per-surface selections and visible ranges are reconstructed independently.
- Playback never changes a real or untitled VS Code text document.
- Playback does not add entries to a real document's undo stack.
- An interrupted recording can be discovered and finalized or discarded.
- Malformed artifacts fail closed with a useful error.
- Unit, integration, artifact, recovery, and webview protocol tests pass.
- Performance budgets in this plan are met or a reviewed exception is documented.
- A VSIX can be built and installed into a clean VS Code profile.
- The implementation status document contains the required review evidence.

### 4.2 Audio milestone is done per platform only when

- The packaged helper runs from the installed VSIX.
- Permission grant, denial, and revocation paths have been tested.
- Start and stop are reliable across repeated recordings.
- Audio is written incrementally without being buffered in extension-host memory.
- Clock calibration stays within the measured synchronization budget.
- Helper termination creates an explicit discontinuity or failure marker.
- The player can seek and resume audio and visual state together.
- Platform-specific VSIX packaging is verified.

## 5. Target repository structure

Create the following structure incrementally. Do not add empty speculative modules that a phase does not yet use.

```text
vscode-extension/
  package.json
  bun.lock
  .gitignore
  .vscodeignore
  README.md
  CHANGELOG.md
  LICENSE                    # only if extension packaging requires a local copy
  tsconfig.json
  tsconfig.extension.json
  tsconfig.webview.json
  vite.config.ts
  esbuild.mjs
  vitest.config.ts
  package.nls.json
  media/
    icon.png
  src/
    extension.ts
    commands/
      registerCommands.ts
      startRecording.ts
      stopRecording.ts
      recoverRecording.ts
      openRecording.ts
      exportRecording.ts
    capture/
      RecordingCoordinator.ts
      CaptureSubscriptions.ts
      EventClock.ts
      DocumentRegistry.ts
      DocumentShadow.ts
      SurfaceRegistry.ts
      TabRegistry.ts
      TopologyTracker.ts
      TopologyReconciler.ts
      CapturePolicy.ts
    model/
      ids.ts
      manifest.ts
      events.ts
      checkpoints.ts
      topology.ts
      capabilities.ts
      limits.ts
      schemas.ts
    storage/
      SessionPaths.ts
      SessionMetadataStore.ts
      OrderedJournalWriter.ts
      JournalReader.ts
      CheckpointStore.ts
      SeekIndexBuilder.ts
      ArtifactWriter.ts
      ArtifactReader.ts
      RecoveryService.ts
      RecordingLibrary.ts
    playback/
      RecordingCustomDocument.ts
      RecordingEditorProvider.ts
      PlaybackDataService.ts
      WebviewProtocol.ts
      WebviewSession.ts
      getWebviewHtml.ts
    audio/
      AudioCapability.ts
      AudioHelperClient.ts
      AudioProtocol.ts
      ClockCalibration.ts
      AudioTrackMetadata.ts
    security/
      artifactLimits.ts
      safeArchivePath.ts
      contentSecurityPolicy.ts
      redactResource.ts
    ui/
      RecordingStatusBar.ts
      notifications.ts
    webview/
      index.html
      index.tsx
      App.tsx
      styles.css
      bridge/
        acquireBridge.ts
        protocol.ts
      player/
        PlaybackEngine.ts
        PlaybackState.ts
        SessionReducer.ts
        EventCursor.ts
        Renderer.ts
        RendererHost.ts
        topologyLayout.ts
        monaco/
          MonacoRenderer.ts
        codemirror/
          CodeMirrorRenderer.ts
      components/
        Transport.tsx
        Timeline.tsx
        RecordedWorkspace.tsx
        UnsupportedSurface.tsx
        ErrorView.tsx
  native/
    audio-recorder/
      Cargo.toml
      Cargo.lock
      src/
        main.rs
        protocol.rs
        recorder.rs
        clock.rs
  scripts/
    build-extension.mjs
    build-webview.mjs
    package-vsix.mjs
    verify-boundaries.mjs
    generate-fixture.mjs
    benchmark-renderer.mjs
  test/
    unit/
    artifact/
    recovery/
    webview/
    integration/
      suite/
      fixtures/
      runTest.ts
    performance/
  fixtures/
    recordings/
      minimal/
      multi-document/
      same-document-two-surfaces/
      unsupported-surface/
      corrupt/
  docs/
    implementation-status.md
    test-matrix.md
    artifact-format-v1.md
    audio-helper-protocol-v1.md
    adr/
      0001-package-boundary.md
      0002-player-renderer.md
      0003-recording-container.md
      0004-audio-helper.md
```

The native audio subtree is not created until its phase starts.

## 6. Tooling and packaging decisions

### 6.1 Independent package

`vscode-extension/` must have its own `package.json` and `bun.lock`. Run package commands from that directory so the root package and lockfile remain unchanged.

Use:

- TypeScript in strict mode
- A Node-targeted extension-host bundle
- Vite for the webview bundle
- Vitest for pure unit and protocol tests
- The official VS Code extension test tooling for Extension Development Host integration tests
- `@vscode/vsce` or the current official equivalent for VSIX packaging

At implementation time, confirm the current supported package names and pin exact versions in the extension lockfile. Do not copy dependency versions from the main app without verification.

### 6.2 VS Code engine

During scaffolding:

1. Check the current stable VS Code Extension API.
2. Select the oldest `engines.vscode` version that supports every public API actually used.
3. Record the selected minimum and rationale in `README.md`.
4. Do not use proposed APIs.
5. Do not import VS Code internal modules.

### 6.3 Extension manifest

Use these identifiers unless product naming is changed before implementation:

- Extension package name: `next-recording`
- Command namespace: `nextRecording`
- Configuration namespace: `nextRecording`
- Custom editor view type: `nextRecording.player`
- Artifact filename extension: `.nextrecording`

Keep each identifier centralized so branding can be changed without rewriting the format engine.

The manifest should contribute:

- `nextRecording.start`
- `nextRecording.stop`
- `nextRecording.recover`
- `nextRecording.open`
- `nextRecording.export`
- Custom editor association for `*.nextrecording`
- Configuration settings described later
- Context keys for recording and recovery state
- Command palette and editor-title actions where appropriate

Set:

```json
"extensionKind": ["ui"]
```

Declare virtual and untrusted workspace support accurately. The extension does not execute workspace code, but native-helper behavior and file access still require explicit tests.

### 6.4 Build outputs

Keep generated output inside ignored paths under `vscode-extension/`, for example:

```text
vscode-extension/dist/
vscode-extension/.test-vscode/
vscode-extension/.artifacts/
vscode-extension/native/audio-recorder/target/
```

The extension-local `.gitignore` and `.vscodeignore` must prevent test downloads, source maps not intended for distribution, fixtures, benchmark output, and native build directories from entering the VSIX.

## 7. Core data contracts

Define the logical format before wiring UI events. All runtime validators and TypeScript types must derive from one schema source or be checked for equivalence in tests.

### 7.1 Identifiers

Use opaque strings generated with `crypto.randomUUID()`:

- `sessionId`
- `rootId`
- `documentId`
- `surfaceId`
- `tabId`
- `groupId`
- `checkpointId`
- `audioTrackId`

Never expose API object identity or absolute filesystem paths as identifiers.

### 7.2 Time and sequence

Every timed event uses:

```ts
type EventEnvelope<TType, TPayload> = {
  seq: number;
  tUs: number;
  type: TType;
  payload: TPayload;
};
```

Requirements:

- `seq` starts at zero and increases by exactly one.
- `tUs` is an integer number of microseconds relative to session start.
- `tUs` may be equal across events but may not decrease.
- `seq` is authoritative when timestamps are equal.
- Use `process.hrtime.bigint()` in the extension host and convert only the session-relative result to a safe integer.
- Do not persist a machine-specific absolute monotonic-clock origin.

### 7.3 Manifest version 1

Define `ManifestV1` with at least:

```text
kind: "next-recording"
formatVersion: 1
sessionId
createdAt: ISO timestamp
finalizedAt: ISO timestamp
durationUs
producer:
  extensionVersion
  vscodeVersion
  platform
  architecture
timebase:
  kind: "host-monotonic-us"
capabilities:
  textDocuments
  selections
  verticalViewport
  topology
  audio
  unsupportedSurfaceMarkers
limitsApplied
workspaceRoots[]
documents[]
tabs[]
initialTopologyRef
eventJournalRef
seekIndexRef
audioTracks[]
integrity
```

The manifest must not contain absolute source paths by default.

### 7.4 Workspace root descriptor

Store:

- `rootId`
- Display name
- Session ordinal
- Optional privacy-preserving logical label

Do not require the original root URI for playback.

### 7.5 Document descriptor

Store:

- `documentId`
- `rootId` or `null`
- Relative logical path or generated untitled label
- Display name
- URI scheme classification: `file`, `untitled`, `remote`, `virtual`, or `other`
- Initial language ID
- Initial EOL mode
- Initial VS Code version
- Initial checkpoint ID
- Content byte count
- SHA-256 of the exact initial text encoded as UTF-8

Do not persist query strings, authority names, usernames, home directories, or absolute URIs unless a future explicit opt-in feature is approved.

### 7.6 Document patch event

A document patch payload contains:

```text
documentId
beforeVersion
afterVersion
reason: undo | redo | unknown
changes[]:
  rangeOffsetUtf16
  rangeLengthUtf16
  text
beforeHash
afterHash
eolBefore
eolAfter
```

The changes form one atomic transaction and are applied in recorded array order.

### 7.7 Surface state

A surface references a document but owns its view state:

```text
surfaceId
documentId
groupId
viewColumn
selections[]:
  anchorOffsetUtf16
  activeOffsetUtf16
  kind: mouse | keyboard | command | unknown
visibleRanges[]:
  startLine
  startCharacter
  endLine
  endCharacter
isActive
```

Attach the applicable document version to selection and viewport events so replay can validate positions against the correct content state.

### 7.8 Tabs, groups, and topology

A topology snapshot contains:

- Ordered groups
- Session-local `groupId`
- Exposed view column
- Ordered `tabId` values per group
- Active group and active tab
- Tab descriptors and input kinds
- Visible surface-to-group relationships
- An explicit fidelity field describing unavailable geometry

Do not invent split dimensions or orientations that VS Code did not expose.

### 7.9 Event union

Version 1 should support:

- `session.started`
- `roots.snapshot`
- `document.enrolled`
- `document.patch`
- `document.checkpoint`
- `document.languageChanged`
- `document.eolChanged`
- `document.saved`
- `document.closed`
- `document.resumed`
- `surface.opened`
- `surface.closed`
- `surface.focused`
- `surface.selectionChanged`
- `surface.viewportChanged`
- `topology.snapshot`
- `window.focusChanged`
- `capability.unsupportedSurface`
- `capture.overload`
- `capture.shadowMismatch`
- `audio.started`
- `audio.calibration`
- `audio.discontinuity`
- `audio.stopped`
- `session.stopping`
- `session.finalized`
- `session.recovered`
- `session.failed`
- `marker`

Unknown event types in a newer artifact must not execute code. Version 1 readers should either safely skip explicitly ignorable events or reject unsupported required events according to a declared compatibility field.

## 8. Capture subsystem design

### 8.1 Recording coordinator

Implement an explicit coordinator state machine without reusing the main app's machine:

```text
idle
  → preparing
  → recording
  → stopping
  → finalizing
  → idle

preparing | recording | stopping | finalizing
  → failed

activation
  → recovering
  → idle
```

Requirements:

- Reject a second start while a session is active.
- Make stop idempotent.
- Install all subscriptions before capturing the initial snapshot.
- Remove subscriptions before writing `session.stopping`.
- Drain the ordered writer before finalization.
- Keep failure information in recovery metadata.
- Update context keys and status UI only after successful state transitions.

### 8.2 Event clock

`EventClock` owns session-relative time and sequence assignment. It is the only module allowed to allocate event sequence numbers.

The public capture callbacks should:

1. Read the event clock.
2. Translate the VS Code event into immutable internal data.
3. Update the minimum required registry or shadow state.
4. Enqueue an ordered write.
5. Return.

Do not await filesystem operations from VS Code event callbacks.

### 8.3 Document registry and enrollment

Use a canonical resource key derived in memory from the full URI, but persist only the privacy-preserving descriptor.

Enrollment rules:

- Enroll all supported visible text documents at start.
- Enroll a supported document the first time it becomes visible later.
- Keep capturing an enrolled open document while it is hidden.
- Ignore never-visible background documents.
- When an enrolled document closes and later reopens, reuse its logical `documentId` when the resource identity is unambiguous.
- If content may have changed while closed, emit `document.resumed` plus a complete checkpoint.
- Language changes that close and reopen the VS Code document should preserve logical identity and emit the relevant metadata/checkpoint events.

Apply exclusion and size policy before reading full document text. Record an explicit exclusion/unsupported marker without recording content.

### 8.4 Document shadow

Maintain for each enrolled document:

- Current exact string
- Current VS Code version
- EOL mode
- SHA-256 hash
- Change count since checkpoint
- Changed byte estimate since checkpoint
- Last checkpoint time

On a text transaction:

1. Verify the expected previous version.
2. Apply every content change sequentially using UTF-16 offsets.
3. Compare the reconstructed result with `event.document.getText()`.
4. Compare or update EOL mode.
5. Compute the after hash.
6. Emit the atomic patch when valid.
7. Emit `capture.shadowMismatch` and a complete checkpoint when invalid.
8. Reset the shadow to observed VS Code state after a mismatch.

Add randomized/property tests for surrogate pairs, combining characters, CRLF, multiline edits, overlapping multi-cursor transactions as delivered by VS Code, undo, and redo.

### 8.5 Checkpoint policy

Always checkpoint:

- On enrollment
- On resume after a closed interval
- On shadow mismatch
- Before dropping an enrolled document due to a configured limit
- At clean stop for every document whose last patch is newer than its last checkpoint

Use provisional adaptive thresholds for actively changing documents:

- 10 seconds since the last checkpoint, or
- 500 document transactions, or
- 1 MiB of inserted/replaced UTF-8 data

Whichever occurs first. Keep thresholds centralized and configurable for benchmarks. Do not expose tuning settings to users until measurements justify them.

### 8.6 Surface identity

Use `WeakMap<vscode.TextEditor, surfaceId>` for live editor-object identity.

When a visible editor appears:

- Resolve or enroll its document.
- Assign a new surface when the API object is new.
- Capture selections, visible ranges, view column, and group association.
- Emit `surface.opened`.

When it disappears from `visibleTextEditors`, emit `surface.closed` but retain historical identity. Do not conflate a tab with a surface.

### 8.7 Tab and group identity

Use weak object identity as the first signal and structural reconciliation as a fallback.

The topology reconciler should compare:

- View column
- Ordered tab input descriptors
- Active tab
- Previous group membership
- Visible editor associations

If a group or tab cannot be matched unambiguously, allocate a new ID and record a topology discontinuity marker rather than guessing silently.

Run reconciliation after the current burst of tab/group/visible-editor events. Start with `queueMicrotask`; if tests show VS Code emits related events across later turns, use the smallest measured debounce and preserve the earliest observation timestamp.

### 8.8 Event-volume policy

Rules:

- Never debounce or discard document patches.
- Record every active-editor and active-tab transition.
- Record every selection event initially.
- Coalesce identical consecutive selection states only when no intervening meaningful event exists.
- Coalesce viewport events to the final state within a provisional 50 ms window per surface, while retaining the first timestamp.
- Deduplicate identical topology snapshots.
- Record overload markers if queue limits are crossed.

Any more aggressive compression requires benchmark evidence and approval because it changes playback semantics.

### 8.9 Unsupported surfaces

Classify tab inputs using public `TabInput*` types. When a diff, notebook, terminal, webview, or custom editor becomes active or visible:

- Preserve its tab/group position.
- Record its public label and safe kind.
- Do not persist sensitive URI details by default.
- Emit `capability.unsupportedSurface`.
- Render a visible placeholder during playback.

## 9. Storage and artifact design

### 9.1 Local working sessions

Store working sessions under the local UI extension's `globalStorageUri`:

```text
sessions/<sessionId>/
  session.json
  events.ndjson
  checkpoints/
    <checkpointId>.txt
  audio/
    <audioTrackId>.wav
  recovery.json
  finalized.json
```

Use Node filesystem APIs only for this local extension-owned storage. Use VS Code filesystem APIs for user-selected workspace or remote resources.

### 9.2 Session metadata writes

Write state transitions atomically:

1. Write a complete temporary metadata file in the same directory.
2. Flush it.
3. Rename it over the previous metadata file.

`session.json` records the current lifecycle state and last durable sequence. It must be sufficient to distinguish active, interrupted, finalized, failed, and discarded sessions.

### 9.3 Ordered journal

Use newline-delimited JSON for version 1 working events.

Requirements:

- Exactly one writer owns the file handle.
- Writes preserve sequence order.
- Enforce a bounded in-memory queue.
- Flush buffered data at least every 100 ms or 64 KiB, whichever comes first.
- Call an actual file sync periodically and at lifecycle boundaries; begin with one second and measure cost.
- Recovery may discard one incomplete final line.
- A malformed line before the tail ends recovery at the last verified sequence and records corruption.
- Journal replay verifies continuous sequence, nondecreasing time, schema, and referenced IDs.

### 9.4 Checkpoint files

Store checkpoint contents as exact UTF-8 text in the working directory with metadata containing:

- Checkpoint ID
- Document ID
- Sequence
- Time
- VS Code version
- EOL mode
- Byte length
- SHA-256

Write checkpoint data to a temporary file and atomically rename it before journaling the checkpoint reference.

### 9.5 Final artifact

Use a streaming ZIP container for `.nextrecording` version 1. Add the ZIP implementation as an independent extension dependency; do not import it from the main app.

Recommended entries:

```text
manifest.json
events.ndjson
index.json
documents/<documentId>/checkpoints/<checkpointId>.txt
audio/<audioTrackId>.wav
integrity.json
```

Finalize in this order:

1. Stop capture subscriptions.
2. Drain and sync the journal.
3. Write final checkpoints.
4. Validate the complete working session by replaying it.
5. Build the seek index.
6. Write the archive to a temporary destination.
7. Close and sync the archive.
8. Reopen and validate its manifest, index, hashes, and event tail.
9. Atomically rename it to the final `.nextrecording` path.
10. Write `finalized.json` in the working session.
11. Keep the working directory until cleanup policy confirms the artifact is valid and no recovery is needed.

Document the exact format in `vscode-extension/docs/artifact-format-v1.md` before declaring version 1 stable.

### 9.6 Seek index

Build an index that maps regular time buckets and important events to:

- Event byte offset or chunk identifier
- Nearest checkpoint per document
- Applicable topology snapshot
- Audio frame/time mapping when audio exists

Start with one-second time buckets. Measure artifact size and seek latency before changing the interval.

### 9.7 Recording library and export

The canonical finalized artifact initially remains in extension-local storage. Provide:

- A command to list and open local recordings.
- An explicit Export command that asks the user for a destination.
- A warning when exporting a large artifact to a remote filesystem.
- A streamed or bounded copy path; do not load an arbitrarily large archive into one `Uint8Array`.

Do not require a workspace to open a recording.

### 9.8 Recovery

On activation, scan only the extension's session directory for non-final states.

For each recoverable session, offer:

- Finalize partial recording
- Inspect failure details
- Discard recording
- Defer

Discard must be explicit and target one validated session directory. Finalization must be idempotent so it can be retried after another interruption.

## 10. Playback design

### 10.1 Custom editor provider

Register a `CustomReadonlyEditorProvider` for `*.nextrecording` with multiple editors per document disabled initially.

`openCustomDocument` should:

- Open the artifact read-only.
- Validate archive paths and size limits before extraction.
- Parse and validate the manifest.
- Reject unsupported required format versions.
- Extract or cache only the entries required for indexed playback.
- Return a lightweight custom document object with explicit disposal.

`resolveCustomEditor` should:

- Configure `localResourceRoots` narrowly.
- Generate a nonce-based strict CSP.
- Disable unneeded webview capabilities.
- Establish a versioned ready handshake.
- Send metadata only after the webview announces readiness.
- Pause and persist compact state when hidden.
- Dispose message listeners and cache leases reliably.

### 10.2 Host/webview protocol

Define a discriminated, versioned message union. Validate messages on both sides.

Host-to-webview examples:

- `host.hello`
- `recording.metadata`
- `recording.initialState`
- `recording.eventChunk`
- `recording.checkpoint`
- `recording.audioResource`
- `request.failed`
- `player.pause`

Webview-to-host examples:

- `webview.ready`
- `recording.requestWindow`
- `recording.requestCheckpoint`
- `player.stateChanged`
- `message.ack`
- `webview.error`

Requirements:

- Every request has a request ID.
- Important responses are acknowledged.
- Duplicate requests are safe.
- Late responses for disposed sessions are ignored.
- Large checkpoint/event data is chunked or transferred as `ArrayBuffer` where supported.
- The entire artifact is never posted into the webview as one JSON object.

### 10.3 Playback engine

Build the playback engine as pure TypeScript independent of VS Code and the chosen renderer.

Responsibilities:

- Load manifest and initial topology.
- Seek to the nearest indexed state at or before a target time.
- Restore document checkpoints.
- Apply document patches in sequence order.
- Maintain shared document state and independent surface state.
- Apply topology snapshots.
- Expose deterministic player state to the renderer.
- Use visual time when no audio track exists.
- Use audio time when a valid audio track exists.
- Handle unsupported-surface markers without failing the session.

Test the same event reducer in Node and webview tests.

### 10.4 Visual-only clock

Without audio:

- Use `performance.now()` only for the current playback interval.
- Derive desired session time from start playhead, playback rate, and elapsed monotonic time.
- Apply all events through the desired time each frame.
- Never rely on one timeout per event.
- Pause automatically when the webview is hidden or disposed.

### 10.5 Audio clock

With audio:

- Treat the media element's current playback time as authoritative.
- Convert audio time through recorded calibration metadata when necessary.
- On each animation frame, advance visual state to the corresponding session time.
- On seek, pause, restore indexed state, set audio position, wait for seek readiness, then render and optionally resume.
- Surface audio discontinuities on the timeline.

### 10.6 Topology layout

Recorded topology contains group order and view columns but not exact pixel geometry. Implement a deterministic logical layout:

- Preserve group ordering.
- Preserve active group and tabs.
- Use equal-sized groups by default.
- Clearly label the layout as reconstructed when fidelity metadata says geometry was unavailable.
- Never invent recorded screen coordinates.

## 11. Renderer evidence gate

Do not choose Monaco solely because the existing app uses it.

### 11.1 Shared renderer contract

Define a contract capable of:

- Creating and disposing document models by `documentId`
- Creating multiple surfaces for one document
- Applying batched document changes
- Setting independent selections and vertical view state
- Switching tabs and topology
- Applying theme and basic language metadata
- Suspending hidden surfaces
- Reporting render-complete timing for benchmarks

The playback engine owns truth. The renderer is a projection and may be destroyed and reconstructed.

### 11.2 Benchmark fixtures

Generate synthetic fixtures without using `.ne` or main-app recordings:

1. Small: 3 documents, 2 surfaces, 5 minutes, 5,000 events.
2. Multi-surface: 10 documents, 4 groups, two documents duplicated across groups, 25,000 events.
3. Large file: 5 MiB document with localized edits and seeks.
4. Edit burst: 100 document transactions per second for 10 seconds.
5. Long session: 60 minutes and 250,000 events with periodic checkpoints.
6. Unicode: surrogate pairs, combining marks, CRLF, and mixed languages.

### 11.3 Measurements

Measure each candidate in the same release-mode webview bundle:

- Bundle size
- Initial manifest-to-first-paint time
- Time to create 1, 5, 10, and 20 surfaces
- Patch-to-paint p50, p95, and p99
- Seek-to-stable-frame p50 and p95
- Memory after load
- Memory after 100 seeks
- Hidden-surface suspension behavior
- Correctness of duplicated document surfaces
- Ease of restoring selections and viewport

### 11.4 Provisional acceptance budgets

On the designated macOS development workstation, target:

- First usable frame under 1.5 seconds for the multi-surface fixture.
- Patch-to-paint p95 under 50 ms at normal recording rates.
- Seek-to-stable-frame p95 under 250 ms for a 30-minute fixture.
- No unbounded memory growth across 100 repeated seeks.
- Ten visible surfaces without visible input-thread stalls.

Record hardware, VS Code version, build mode, and methodology with results.

### 11.5 Renderer decision

Write `docs/adr/0002-player-renderer.md` containing results and the decision. Then:

- Keep the selected adapter.
- Remove the losing production dependency and adapter unless it remains behind an explicitly development-only benchmark target.
- Confirm the final player never depends on a renderer-specific state as its canonical session state.

If neither candidate meets the budgets, stop and propose a reduced-surface or custom-renderer strategy before proceeding.

## 12. Audio helper design and gate

Do not begin this phase until the visual vertical slice is stable unless the owner explicitly makes audio the blocking Phase 0 priority.

### 12.1 Helper process

Default implementation direction:

- Standalone Rust executable
- `cpal` or the then-current maintained cross-platform input library
- PCM WAV output for the first synchronization milestone
- JSON Lines control protocol over stdin/stdout
- Diagnostics over stderr without source-code or token data
- Direct-to-disk audio writes

PCM WAV is intentionally simple and broadly playable but large. Treat it as the first proven codec, not a permanent compression decision. Propose Opus or another encoding only after measuring size, CPU, licensing, browser playback, and platform packaging.

### 12.2 Protocol

Document a versioned protocol in `docs/audio-helper-protocol-v1.md`.

Host messages:

- `hello`
- `listDevices`
- `prepare`
- `start`
- `ping`
- `stop`
- `shutdown`

Helper messages:

- `ready`
- `devices`
- `prepared`
- `started`
- `level`
- `pong`
- `progress`
- `stopped`
- `error`

Every message contains:

- Protocol version
- Request or correlation ID when applicable
- Helper state
- No arbitrary filesystem path supplied by an untrusted recording

The extension creates and validates the output path. The helper must refuse paths outside the provided validated session audio directory.

### 12.3 Clock calibration

The host event clock and audio sample clock must be related through measurements rather than assumed identical.

Implement:

1. Prepare the input device before the visual recording state begins.
2. Timestamp each host `ping` send and `pong` receive with the host monotonic clock.
3. Include current captured sample frame in each helper response.
4. Estimate the host time at the response midpoint.
5. Discard high-round-trip outliers.
6. Fit an affine mapping between host session microseconds and audio sample frames.
7. Persist mapping coefficients, sample rate, calibration points, and uncertainty.
8. Refresh calibration periodically during long recordings.
9. Record a discontinuity if sample progression or residual error crosses a measured threshold.

Do not claim sub-frame precision. Report measured p50/p95 synchronization uncertainty.

### 12.4 Failure behavior

Handle:

- No input devices
- Permission denied
- Device disappears
- Helper cannot start
- Helper exits unexpectedly
- Output write failure
- Disk full
- Sample discontinuity
- Stop timeout
- Corrupt/incomplete WAV header after a crash

The coordinator must either:

- Continue as a clearly marked visual-only recording when policy permits, or
- Stop cleanly and preserve a recoverable partial session.

Never remain visually marked as recording after the helper or coordinator has failed.

### 12.5 Platform matrix

Maintain `docs/test-matrix.md` with rows for:

- macOS arm64
- macOS x64, if supported
- Windows x64
- Windows arm64, if supported
- Linux x64 with PipeWire
- Linux x64 with PulseAudio
- Remote SSH workspace with local audio
- Dev Container workspace with local audio

For each row record build, launch, permission, capture, repeated start/stop, one-hour stability, packaged VSIX, and sync results.

Only package and advertise targets with completed rows.

## 13. Security, privacy, and limits

### 13.1 Default limits

Centralize provisional limits and test them. Initial conservative values may include:

- Maximum captured document: 10 MiB
- Maximum event text payload: 2 MiB per transaction
- Maximum events per session: 5,000,000
- Maximum artifact entries: 100,000
- Maximum manifest size: 2 MiB
- Maximum individual checkpoint: 20 MiB
- Maximum total extracted non-audio data: 1 GiB
- Maximum decompression ratio per compressed entry
- Maximum journal queue memory: 32 MiB

Do not silently truncate a supported document or patch. Stop capture for that document, write a capability/limit marker, and preserve session consistency.

Tune values only with evidence and update format/security documentation.

### 13.2 Archive safety

Before extracting any entry:

- Normalize separators.
- Reject absolute paths.
- Reject drive-letter paths.
- Reject `..` traversal.
- Reject symlinks and unsupported entry types.
- Enforce entry count and declared/uncompressed sizes.
- Extract only into a unique validated cache directory.
- Never execute extracted content.

Verify hashes before giving content to the player.

### 13.3 Webview safety

Use:

- A strict nonce-based CSP
- No inline script without a nonce
- No remote scripts, fonts, images, or analytics
- Narrow `localResourceRoots`
- Schema validation for every message
- Text rendering APIs that do not interpret recorded code as HTML
- Explicit disposal of object URLs and listeners

The player must be fully functional offline.

### 13.4 Capture privacy

Provide configuration for:

- Excluded glob patterns
- Maximum document size
- Whether untitled documents may be captured
- Whether remote documents may be captured
- Whether audio is enabled

Before the first recording, show a concise disclosure that visible code and possibly narration are stored locally. Do not show repeated modal prompts after acknowledgement unless privacy settings change materially.

Never log captured source text. Logs may contain IDs, counts, hashes, durations, and sanitized display labels.

## 14. User experience requirements

### 14.1 Start recording

`nextRecording.start` should:

1. Reject unsupported concurrent state.
2. Show the first-use privacy disclosure when needed.
3. Validate local storage capacity as far as practical.
4. Check audio capability if audio is enabled.
5. Enter preparing/arming state.
6. Install capture subscriptions.
7. Capture initial roots, topology, documents, and surfaces.
8. Start durable journal writing.
9. Transition to recording.
10. Show a red status-bar item with elapsed time and Stop action.

If preparation fails, remove subscriptions and leave no ambiguous active indicator.

### 14.2 Stop recording

`nextRecording.stop` should:

1. Become idempotent immediately.
2. Change the status item to stopping/finalizing.
3. Stop accepting new capture events at a defined sequence boundary.
4. Stop audio when active.
5. Drain writes and create final checkpoints.
6. Finalize and validate the artifact.
7. Announce the saved recording with Open and Export actions.
8. Clear the recording context keys.

If finalization fails, preserve the working session and offer recovery.

### 14.3 Playback

The custom editor should provide:

- Play/pause
- Seek bar
- Elapsed and total time
- Playback speed
- Active recorded file and group indication
- Reconstructed group layout
- Recorded tabs
- Multiple selections when supported by the renderer
- Visible unsupported-surface placeholders
- Audio availability/discontinuity state
- A clear error view for invalid recordings

Playback must not request permission to modify workspace files.

### 14.4 Commands and context keys

Use context keys such as:

- `nextRecording.isPreparing`
- `nextRecording.isRecording`
- `nextRecording.isStopping`
- `nextRecording.hasRecoverableSession`
- `nextRecording.audioAvailable`
- `nextRecording.playerActive`

Menus should hide or disable actions that are invalid in the current state.

## 15. Phased execution plan

Complete phases in order. Do not combine all phases into one unreviewable commit.

### Phase 0: preflight and decision recording

Tasks:

- Read repository instructions and research.
- Confirm clean worktree and allowed paths.
- Confirm current stable VS Code API and extension tooling.
- Create `vscode-extension/docs/implementation-status.md`.
- Record the package boundary in ADR 0001.
- Record initial assumptions, supported platform, and deferred capabilities.

Acceptance gate:

- No source implementation yet.
- Owner can see exact dependency/tooling choices and any deviations.
- No root package or application files changed.

Suggested commit:

```text
docs(vscode): record extension implementation decisions
```

### Phase 1: isolated extension scaffold

Tasks:

- Create the independent package and lockfile.
- Add extension manifest, TypeScript configs, host and webview build configs.
- Add minimal `activate` and `deactivate` functions.
- Register placeholder commands and a placeholder read-only custom editor.
- Add extension-local ignore files.
- Add unit, integration, and packaging scripts.
- Add `verify-boundaries.mjs` to reject imports resolving outside `vscode-extension/`, except declared tooling/runtime packages.
- Add a smoke integration test that activates the extension.

Acceptance gate:

- Extension compiles and activates in an Extension Development Host.
- Placeholder custom editor opens a synthetic `.nextrecording` fixture.
- VSIX packaging succeeds.
- Boundary verification passes.
- Root application files and lockfile remain unchanged.

Suggested commit:

```text
chore(vscode): scaffold isolated recording extension
```

### Phase 2: capture topology and text-change feasibility

Tasks:

- Implement event clock and in-memory event sink.
- Implement document, surface, tab, and group registries.
- Implement visible-first document enrollment.
- Implement document shadow and patch validation.
- Implement topology reconciliation and diagnostic snapshots.
- Add a diagnostic command that writes a human-readable temporary session trace.
- Add integration scenarios for multiple documents, duplicate surfaces, groups, multi-cursor edits, undo/redo, formatting, untitled files, and unsupported tabs.
- Measure callback duration and event ordering.

Do not implement the final artifact yet.

Acceptance gate:

- All tested document shadows exactly equal VS Code contents after every transaction.
- Same-document split views have one document ID and distinct surface/tab/group IDs.
- Topology snapshots are deterministic across repeated test runs.
- Unsupported surfaces are explicit.
- No content event loss is observed in the stress fixture.
- Any API gaps are reported before proceeding.

Suggested commit:

```text
feat(vscode): prove multi-document capture model
```

### Phase 3: renderer benchmark and decision

Tasks:

- Implement the pure playback reducer and renderer contract against synthetic in-memory recordings.
- Implement minimal Monaco and CodeMirror adapters.
- Generate the benchmark fixtures in this plan.
- Run release-mode benchmarks on the designated workstation.
- Validate multiple surfaces sharing one document.
- Write ADR 0002 with raw results and decision.
- Remove the losing production dependency or isolate it to benchmarks.

Acceptance gate:

- One renderer meets correctness requirements.
- Performance results are reproducible and documented.
- Selection is evidence-based.
- Playback state remains renderer-independent.

If neither renderer passes, stop and request an architecture decision.

Suggested commit:

```text
perf(vscode): select recording playback renderer
```

### Phase 4: versioned model, journal, and checkpoints

Tasks:

- Finalize version 1 schemas and runtime validators.
- Implement ordered journal writer and reader.
- Implement atomic session metadata writes.
- Implement checkpoint storage and hashes.
- Implement seek index builder.
- Add recovery parsing for truncated journal tails.
- Add pure replay validation.
- Document working-session and artifact schemas.

Acceptance gate:

- Journal sequence and timestamps are validated.
- Crash simulation at every write boundary recovers to the last durable sequence.
- Randomized patches replay to the same final hashes.
- Checkpoint corruption is detected.
- Format documentation matches fixtures and runtime schemas.

Suggested commit:

```text
feat(vscode): add recoverable recording journal
```

### Phase 5: native visual recording vertical slice

Tasks:

- Implement the recording coordinator lifecycle.
- Wire native capture events into the ordered journal.
- Implement exclusions, limits, and status-bar UX.
- Implement start and stop commands.
- Add final checkpoints and session validation.
- Add local recording library metadata.
- Exercise multi-root and untitled scenarios.

Acceptance gate:

- A real multi-document session records from start to stop.
- The finalized working state replays correctly in a headless validator.
- Status and context keys remain accurate on success and failure.
- Starting twice and stopping twice are safe.
- Closing/reloading VS Code leaves a recoverable session.

Suggested commit:

```text
feat(vscode): record native multi-document sessions
```

### Phase 6: artifact finalization and read-only playback

Tasks:

- Implement streaming archive writer and reader.
- Enforce archive security limits.
- Implement the custom read-only document/provider.
- Implement versioned host/webview messaging.
- Integrate the selected renderer.
- Implement playback engine, visual clock, seek, topology reconstruction, and unsupported placeholders.
- Implement recording library Open and Export flows.
- Add webview hide/dispose restoration.

Acceptance gate:

- A finalized artifact opens without the original workspace.
- Play, pause, seek, and speed work.
- Multiple groups and same-document surfaces render correctly.
- Playback performs no workspace edits.
- Hiding and reopening restores the playhead and player state.
- Corrupt and malicious fixtures fail closed.
- Performance budgets pass.

Suggested commit:

```text
feat(vscode): add read-only session playback
```

### Phase 7: recovery, security, privacy, and scale hardening

Tasks:

- Implement activation-time recovery UX.
- Add idempotent finalization and explicit discard.
- Complete privacy disclosure and exclusion settings.
- Add disk-full, limit, writer-failure, and corrupted-tail tests.
- Add archive traversal, decompression, schema abuse, and webview-message tests.
- Run long-session and large-document fixtures.
- Audit logs for captured text or absolute paths.
- Complete format and security documentation.

Acceptance gate:

- All threat cases fail safely.
- No captured source appears in extension logs.
- Recovery preserves all durable events.
- Limits produce explicit markers and consistent playback.
- Long-session memory remains bounded.

Suggested commit:

```text
fix(vscode): harden recording recovery and privacy
```

### Phase 8: audio feasibility and integration

Tasks:

- Create the native helper only now, unless reprioritized explicitly.
- Implement and test the JSON Lines protocol.
- Prove microphone capture on the current workstation.
- Implement direct-to-session WAV recording.
- Implement host/helper clock calibration.
- Integrate preparing, recording, stopping, and failure states.
- Add audio metadata and archive entry.
- Make playback audio-anchored.
- Package a platform-specific VSIX.
- Record platform validation evidence and unsupported targets.

Acceptance gate:

- Current platform row in the audio test matrix is complete.
- Repeated start/stop and helper-crash tests pass.
- Synchronization uncertainty is measured and acceptable.
- Visual-only fallback is unambiguous.
- No unsupported platform is advertised.

Suggested commits:

```text
feat(vscode): add local audio recorder helper
feat(vscode): synchronize playback to recorded audio
```

### Phase 9: release candidate and handoff

Tasks:

- Install the packaged VSIX into a clean profile.
- Record a fresh multi-root, multi-document session.
- Replay it without opening the original workspace.
- Run the full verification matrix.
- Audit VSIX contents and size.
- Update README, CHANGELOG, status, ADRs, and known limitations.
- Remove diagnostic commands and benchmark-only production dependencies.
- Prepare the review evidence listed below.

Acceptance gate:

- Core definition of done passes.
- Audio definition of done passes only for advertised platforms.
- Worktree contains no generated artifacts or unrelated changes.
- No main-app source or core file changed.
- Reviewer can reproduce the result from documented commands.

Suggested commit:

```text
chore(vscode): prepare recording extension review build
```

## 16. Test plan

### 16.1 Pure unit tests

Cover:

- ID allocation and registry reuse
- URI privacy mapping
- UTF-16 patch application
- Multi-change transactions
- CRLF and EOL changes
- Unicode surrogate pairs and combining marks
- Hash calculation
- Event-clock ordering
- Coordinator transition validity
- Topology reconciliation
- Topology deduplication
- Selection and viewport serialization
- Runtime schema acceptance/rejection
- Seek index construction
- Playback reducer determinism
- Audio clock calibration mathematics

### 16.2 Artifact tests

Cover:

- Minimal valid artifact
- Multiple documents and groups
- Unknown optional event
- Unsupported required event
- Unsupported format version
- Missing manifest
- Invalid JSON
- Duplicate IDs
- Sequence gaps
- Decreasing timestamps
- Hash mismatch
- Missing checkpoint
- Oversized manifest or entry
- Zip traversal paths
- Absolute and drive-letter paths
- Excessive decompression ratio
- Truncated archive
- Truncated event tail

Keep golden fixtures small and generated from extension-owned schemas.

### 16.3 Recovery tests

Interrupt after:

- Session directory creation
- Initial metadata write
- Initial checkpoint write
- Partial journal line
- Journal flush before metadata update
- Metadata update before journal sync
- Final checkpoint
- Index creation
- Temporary archive creation
- Archive close before rename
- Rename before finalized marker

Each case must have a deterministic recover/finalize/discard result.

### 16.4 VS Code integration tests

Automate where supported:

- Activation
- Start/stop commands
- Editing two documents alternately
- Same document in two groups
- Multi-cursor insertion and deletion
- Undo/redo
- Formatter/workspace edit
- Untitled document
- Open/close/reopen document
- Group and tab changes
- Custom editor open
- Playback does not change document versions

Where VS Code test APIs cannot deterministically drive UI grouping, add a documented manual scenario instead of relying on private commands or DOM access.

### 16.5 Webview tests

Test the player reducer and protocol outside VS Code for:

- Ready handshake
- Duplicate and out-of-order responses
- Chunked event loading
- Seek cancellation
- Hide/pause/restore
- Disposed session messages
- Unsupported surface display
- Invalid host messages
- Renderer reconstruction
- Audio and visual clock modes

### 16.6 Manual matrix

Record evidence for:

- Empty window
- Single-folder workspace
- Multi-root workspace
- Local workspace
- Remote SSH or Dev Container when available
- Light and dark themes
- Split editors
- Large documents
- Long recording
- Extension-host reload during recording
- Disk pressure or simulated writer failure
- Installing and opening from a packaged VSIX

## 17. Performance and observability

### 17.1 Capture budgets

Target on the designated workstation:

- Capture callback p95 under 2 ms excluding unavoidable full-text validation.
- Capture callback maximum under 10 ms during normal editing.
- No lost document transactions during a 10,000-transaction stress run.
- Ordered writer queue below 32 MiB.
- Durable journal sync p95 under 250 ms without blocking callbacks.
- Extension-host memory bounded across a one-hour fixture.

If calling `document.getText()` after every transaction is too expensive for large files, do not remove correctness validation silently. Propose a measured adaptive strategy with mandatory periodic checks and checkpoint fallback.

### 17.2 Playback budgets

Use the renderer budgets from the evidence gate and additionally target:

- No workspace document version changes during playback.
- Seek result hash equality for every document.
- No retained renderer instances after custom document disposal.
- No audio continuing after the player is hidden, closed, or disposed.

### 17.3 Diagnostics

Add a named extension output channel with configurable diagnostic level.

Allowed diagnostics:

- Session and component IDs
- Event counts and sequence ranges
- Timings and queue sizes
- Document byte counts
- Content hashes
- Sanitized logical labels
- Capability and error codes

Forbidden diagnostics:

- Source contents
- Replacement text
- Narration data
- Absolute source paths
- Environment variables
- Credentials or tokens

## 18. Configuration surface

Start with a small configuration surface:

```text
nextRecording.capture.exclude
nextRecording.capture.maxDocumentBytes
nextRecording.capture.includeUntitled
nextRecording.capture.includeRemote
nextRecording.audio.enabled
nextRecording.playback.defaultSpeed
nextRecording.diagnostics.level
```

Do not expose internal checkpoint, debounce, queue, or archive-security limits as public settings until there is a demonstrated user need. Keep those centralized internal constants and benchmark hooks.

Configuration changes made during recording should either:

- Apply only to future enrollments and emit a configuration marker, or
- Require the next recording.

Document the behavior explicitly; do not let policy change silently mid-session.

## 19. Verification commands

Define extension-local scripts so the final workflow is approximately:

```bash
cd vscode-extension
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
bun run test:artifact
bun run test:integration
bun run benchmark:renderer
bun run build
bun run package
```

The exact script names may be adjusted during scaffolding, but document the final equivalents in `vscode-extension/README.md` and keep one aggregate `bun run check` command for the extension.

On the macOS workstation, also follow the root `CLAUDE.md` verification requirements before claiming repository completion, including the full root checks and builds it specifies.

On the Linux VPS, do not run memory-heavy builds, tests, typechecks, linters, browser automation, extension-host integration tests, or benchmarks. Perform only safe file-level checks and report the commands that must run on the workstation or CI.

## 20. Change and commit discipline

### 20.1 Before each phase

- Confirm the previous phase gate passed.
- Update `vscode-extension/docs/implementation-status.md` with evidence.
- Explain any expected change outside the phase scope before making it.
- Preserve unrelated worktree changes.

### 20.2 During implementation

- Keep changes reviewable by phase.
- Do not mix main-app refactors into extension commits.
- Do not commit generated VSIX files, test VS Code downloads, build output, or native target directories.
- Add tests with the behavior they cover rather than as a later cleanup batch.
- Treat failed gates as blockers, not invitations to weaken acceptance criteria silently.

### 20.3 After commits

Follow `CLAUDE.md`: use Conventional Commits and push the current branch to `origin` after every successful commit.

## 21. Required final handoff for review

When implementation is ready to return for review, provide one self-contained report containing:

### 21.1 Scope summary

- Implemented phases
- Deferred phases
- Supported VS Code versions
- Supported operating systems and architectures
- Supported workspace types
- Explicit unsupported surfaces and capabilities

### 21.2 Change summary

- Commit list
- Changed file groups by subsystem
- Dependency list and justification
- ADR list
- Confirmation that no main-app module is imported or modified

### 21.3 Verification evidence

- Exact commands run
- Exit results
- Extension Development Host scenarios
- Renderer benchmark table
- Capture performance measurements
- Recovery matrix results
- Security fixture results
- VSIX install smoke test
- Audio platform matrix and synchronization measurements when applicable

### 21.4 Reproduction artifacts

- One small visual-only `.nextrecording` fixture
- One multi-document/multi-group fixture
- One same-document/two-surface fixture
- One intentionally corrupt fixture
- One audio fixture only when audio support is implemented

Fixtures must contain synthetic, non-sensitive content.

### 21.5 Known risks

- Remaining API-fidelity gaps
- Untested platforms
- Performance exceptions
- Recovery limitations
- Format limitations
- Security or privacy follow-ups

Do not describe the implementation as complete if a required definition-of-done item or advertised platform gate remains open.

## 22. Reviewer checklist

The returning implementation will be reviewed for:

- Strict separation from the main app
- Multi-document and multi-surface correctness
- Native VS Code API usage only
- Event ordering and UTF-16 patch correctness
- Deterministic topology reconstruction
- Recovery and finalization safety
- Artifact validation and path safety
- No workspace mutation during playback
- Webview CSP and protocol validation
- Renderer decision evidence
- Bounded capture and playback memory
- Accurate audio capability claims
- Privacy-preserving metadata and logs
- Honest unsupported-surface behavior
- Reproducible tests and VSIX packaging

## Final execution instruction

Start with Phase 0 and proceed sequentially through the core visual milestone. The first architecture gates are the native multi-document capture spike and the renderer benchmark. Do not begin by adapting the main application, selecting Monaco without evidence, designing around `.ne`, or building audio into a webview.

The extension is successful when it behaves like a native VS Code recording product while keeping capture, persistence, playback, and failure handling entirely within its own package and explicitly supported API surface.
