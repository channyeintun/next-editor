# Memory Leak Review

Date: 2026-06-14

Scope: review of the provided Chrome Memory heap snapshot screenshot plus the local code paths that own recording data, preview iframes, Monaco editor state, Xterm terminals, workers, and WebContainer runtime lifecycle. This review was originally written before implementation changes; the validation section below reflects the current code after the fixes tracked in [progress.md](progress.md).

## Validation Against Progress

Validated on 2026-06-14 against the current repository and the last four commits.

- Finding 3, static iframe interaction listener cleanup, is addressed by the explicit generated-script cleanup added in `ada3be9` plus the follow-up parent cleanup fix. Parent cleanup now retains the exact cleanup function created for the injected document instead of re-reading it from `contentWindow` later.
- Finding 4, recording mouse tracking cleanup across iframe document changes, is addressed by `fc50299`. The current code stores the exact iframe `Document` used for mouse listener attachment and removes capture-phase listeners from that same document during navigation and teardown.
- Finding 5, Monaco playback model disposal, is addressed by `9d2e340`. Playback models are now under a distinct replay URI root and inactive replay models are disposed when the editor returns to normal workspace models or unmounts.
- Findings 1 and 2 remain intentional high-memory replay/runtime snapshot retention paths, not confirmed leaks. They still need product-level limits or deduplication decisions before implementation.
- Finding 6 remains intentionally unchanged: the recording codec worker is an app-lifetime singleton and is still low severity for the current app lifecycle.

## Snapshot Read

The screenshot is a single heap snapshot, so it cannot prove a leak by itself. It can still show useful pressure points:

- Large string retention dominates the heap: `system / ExternalStringData` is about 70 MB retained and `(string)` is about 62 MB retained. This matches code paths that store full editor content, full preview HTML, workspace file content, terminal output, compressed/decompressed recording JSON, and runtime snapshots.
- Detached DOM is a real warning signal: `Detached <div>`, `Detached <textarea>`, `Detached Text`, and `Detached <br>` all retain noticeable memory. Detached `textarea` and `br` nodes are especially consistent with Monaco/Xterm/editor DOM, while detached `div`/text nodes can also come from preview iframe documents.
- The object shapes shown in the snapshot, especially `{timestamp, isKeyframe, previewState, viewState}` and `{size, isOpen, mode, content, route, scrollTop, scrollLeft, currentInteraction}`, map directly to recording delta frames and preview snapshots.
- `compiled code` and `system / Context` retention is expected to be elevated in a Vite/Monaco/WebContainer app and should not be treated as a leak unless it keeps growing across unload/reset cycles.

## Findings

### 1. Recording data intentionally retains large strings and snapshots

Confidence: high. Severity: expected retention, high memory impact.

The recording machine captures editor frames with full editor content, Monaco view state, slide state, and preview state. `createFrame` stores `content`, `viewState`, and `previewState`, and finalization compresses the session into the loaded `recording` held in machine context: [src/core/src/machine/editorMachine.ts](src/core/src/machine/editorMachine.ts#L700), [src/core/src/machine/editorMachine.ts](src/core/src/machine/editorMachine.ts#L774), [src/core/src/machine/editorMachine.ts](src/core/src/machine/editorMachine.ts#L841-L843).

The preview state type includes an optional full `content` string, and runtime/workspace snapshots can include terminal output and full project file contents: [src/types/slides.ts](src/types/slides.ts#L89-L99), [src/types/runtime.ts](src/types/runtime.ts#L10-L26), [src/types/workspace.ts](src/types/workspace.ts#L9-L21).

This explains much of the string retention in the heap snapshot. It is not automatically a leak while a recording is loaded or has just been completed. It becomes leak-like if memory does not drop after `clearRecording`/unload, after closing preview, or after switching away from a large recording.

### 2. Runtime preview snapshots can duplicate full document HTML frequently

Confidence: high. Severity: medium to high for Node.js lessons with active runtime preview.

The WebContainer runtime injects a snapshot script into runtime HTML. That script posts `document.documentElement.outerHTML` to the parent and observes the whole document with a `MutationObserver`: [src/contexts/webContainerRuntimeSupport.ts](src/contexts/webContainerRuntimeSupport.ts#L152-L156).

On the parent side, the message bridge converts incoming HTML into replayable preview HTML and stores it in `lastRuntimeSnapshotRef`; when recording, it emits `preview_refresh` events containing the full snapshot content. The preview controller also captures runtime snapshots on iframe load and refresh paths: [src/components/preview/usePreviewController.ts](src/components/preview/usePreviewController.ts#L530-L548), [src/components/preview/usePreviewController.ts](src/components/preview/usePreviewController.ts#L688-L716).

This is a likely source of `ExternalStringData` and `(string)` growth. It can be correct behavior for replay, but it is expensive because one DOM mutation can lead to another full HTML string snapshot.

### 3. Iframe interaction capture injects listeners with no parent-side cleanup

Confidence: medium. Severity: medium.

Current status: fixed by `ada3be9` plus the follow-up parent cleanup patch.

For static preview recording, `usePreviewInteractionCapture` injects a generated script into the iframe document. The returned cleanup from `setupInteractionListeners` is a no-op, while the injected script installs document/window listeners for click, focus, key, input, scroll, route changes, and navigation messages: [src/components/preview/usePreviewInteractionCapture.ts](src/components/preview/usePreviewInteractionCapture.ts#L38-L45), [src/utils/iframeInteractionCapture.ts](src/utils/iframeInteractionCapture.ts#L126-L284).

If iframe documents are fully replaced, browser GC should usually collect the old document and its listener graph. The heap snapshot's detached DOM rows mean this area is still worth investigating: a stale iframe document retained by a listener, closure, DevTools reference, bfcache-like behavior, or parent reference could keep those injected listeners and DOM subtrees alive.

### 4. Mouse tracking may miss cleanup for listeners attached to previous iframe documents

Confidence: medium. Severity: medium.

Current status: fixed by `fc50299`.

During recording, the mouse tracking actor observes the whole document for iframes and re-runs `setupIframeListeners` when an iframe `src` or `srcdoc` attribute changes. It stores handlers by iframe element and attempts to remove existing handlers from the current `iframe.contentDocument`: [src/core/src/machine/editorMachine.ts](src/core/src/machine/editorMachine.ts#L373-L413), [src/core/src/machine/editorMachine.ts](src/core/src/machine/editorMachine.ts#L493-L512).

On iframe navigation, the current `contentDocument` may already be the new document, while the old handlers were attached to the previous document. The map entry is then overwritten. Final actor cleanup disconnects the observer and removes handlers from the current iframe document, but it may no longer have a direct handle to the old detached document: [src/core/src/machine/editorMachine.ts](src/core/src/machine/editorMachine.ts#L533-L552).

This is one of the stronger code-level matches for detached iframe DOM after recording or preview refresh loops.

### 5. Monaco playback models are created but not explicitly disposed

Confidence: medium. Severity: low to medium.

Current status: fixed by `9d2e340`.

Playback models are created under `file:///__next-editor__/playback` via `monaco.editor.createModel`, and I did not find a matching disposal path for those models: [src/components/editorModels.ts](src/components/editorModels.ts#L4-L26). The CodeEditor cleans its event disposables and editor ref on unmount, which is good, but that cleanup does not dispose Monaco models: [src/components/CodeEditor.tsx](src/components/CodeEditor.tsx#L303-L313).

This is less likely to explain detached DOM by itself, but it can explain retained source strings and Monaco-side memory when users load different projects/files over a long session. It may be bounded by workspace file count in normal use, but project churn could accumulate models.

### 6. Recording codec worker is an app-lifetime singleton

Confidence: medium. Severity: low.

The recording codec client creates a singleton worker and keeps it in module state. There is no public termination path: [src/storage/recordingCodecClient.ts](src/storage/recordingCodecClient.ts#L17-L48).

This is probably intentional for the full app lifetime and not the main source of the shown heap. It is still a possible retention source if this package is embedded/unmounted repeatedly or if large Comlink requests leave worker-side data alive longer than expected.

### 7. Several cleanup paths look healthy and probably are not the leak

Confidence: high.

- CodeEditor disposes Monaco event subscriptions and clears the editor ref on unmount: [src/components/CodeEditor.tsx](src/components/CodeEditor.tsx#L303-L313).
- Xterm disposes data/scroll subscriptions, disconnects `ResizeObserver`, disposes the fit addon, and disposes the terminal: [src/components/XtermTerminal.tsx](src/components/XtermTerminal.tsx#L110-L134).
- WebContainer runtime output is capped at 6 KB for runner output and 50 KB per terminal session: [src/contexts/useWebContainerRuntimeSession.ts](src/contexts/useWebContainerRuntimeSession.ts#L28-L29), [src/contexts/useWebContainerRuntimeSession.ts](src/contexts/useWebContainerRuntimeSession.ts#L166-L197).
- WebContainer reset kills processes, clears terminal sessions, removes runtime listeners, and tears down the shared container: [src/contexts/useWebContainerRuntimeSession.ts](src/contexts/useWebContainerRuntimeSession.ts#L270-L301), [src/contexts/webContainerRuntimeSupport.ts](src/contexts/webContainerRuntimeSupport.ts#L541-L548).
- Object URLs in audio playback, JSON export/import, and workspace zip export are revoked: [src/core/src/machine/audioActor.ts](src/core/src/machine/audioActor.ts#L227-L234), [src/storage/JsonStorage.ts](src/storage/JsonStorage.ts#L151-L194), [src/utils/workspaceZip.ts](src/utils/workspaceZip.ts#L33-L44).

## Overall Assessment

The heap snapshot strongly suggests heavy intentional retention from recording and preview snapshot data. The detached DOM rows are the part most worth treating as possible leak evidence.

Original likely leak candidates, in priority order:

1. Iframe lifecycle around preview refresh/runtime snapshots, especially injected iframe scripts and `MutationObserver` usage.
2. Mouse tracking listener cleanup across iframe `src`/`srcdoc` document changes while recording.
3. Undisposed Monaco playback models during long sessions with project/file churn.
4. App-lifetime recording codec worker, mostly relevant for embedded/unmount scenarios.

After validating [progress.md](progress.md), items 2 and 3 are addressed, and item 1 is partially addressed for static iframe interaction scripts. The runtime snapshot `MutationObserver` and full HTML snapshot path remain intentionally unchanged.

Useful confirmation signals in Chrome DevTools:

- For `Detached <textarea>`/`Detached <div>` retainers, check whether the retaining path goes through `iframeInteractionCapture`, `mouseTrackingActor`, Monaco model/editor internals, Xterm, or DevTools console/history.
- Compare snapshots after forced GC at these points: fresh editor load, after recording with preview refreshes, after stopping/clearing the recording, and after closing/reopening preview.
- If detached DOM count drops after closing DevTools or clearing console/snapshots, part of the retention is tooling-related rather than app-owned.
- If string retention remains high but detached DOM drops, the main issue is recording/runtime snapshot size rather than detached DOM leakage.
