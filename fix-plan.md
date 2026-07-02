# Fix Plan: Media-Link Export/Load + Lock-File Reverse Sync

Two independent issues. Both root causes verified in code; neither is fixed yet.

---

## Issue 1 — Renamed/re-hosted media files break audio & video playback on URL load

### Symptom

Export produces `<base>.ne` + `<base>.weba` (audio) + `<base>.webm` (camera). If the user
renames those files before uploading (e.g. to an S3 bucket), loading the `.ne` via
`?url=` plays neither audio nor video. There is also no way to point a recording at
media hosted somewhere else (a CDN/S3 URL that doesn't sit next to the `.ne`).

### Root cause

1. **Export bakes the literal at-export filename into the `.ne`.**
   [RecordingStorage.ts:246-266](src/storage/RecordingStorage.ts:246) — `exportAsFile`
   writes `cameraFile: "<base>.webm"` / `audioFile: "<base>.weba"` (where `<base>` is the
   export-time filename) into the recording before encoding. The SCR3 header persists these
   strings verbatim ([encode.ts:221-229](src/storage/streamingRecordingCodec/encode.ts:221)).

2. **URL load resolves only that stored name — no fallback to the `.ne`'s own basename.**
   [useUrlLoader.ts:49-70](src/hooks/useUrlLoader.ts:49) — `withResolvedMediaUrls` does
   `new URL(recording.audioFile, neUrl)`. If the user renamed `lesson.ne` → `intro-01.ne`
   (and the media likewise), the `.ne` still says `audioFile: "lesson.weba"`, so the app
   fetches `…/lesson.weba` → 404. The local _file import_ path already has basename
   fallback ([RecordingStorage.ts:56-70](src/storage/RecordingStorage.ts:56),
   `pickCompanionFile`), but the URL path has none.

3. **No way to configure absolute media URLs.** The format and loader already fully
   support persisted `audioUrl` / `cameraUrl` ([format.ts:98-108](src/storage/streamingRecordingCodec/format.ts:98),
   [decode.ts:168-174](src/storage/streamingRecordingCodec/decode.ts:168), and
   `withResolvedMediaUrls` skips resolution when a URL is already present) — but nothing in
   the editor ever sets them, and `exportAsFile` has no input for them.

4. **Latent corruption bug (same cluster): transient URLs get baked into re-exports.**
   `exportAsFile` passes the recording through with whatever `audioUrl`/`cameraUrl` it has
   in memory, and the encoder writes them verbatim. A recording that was imported with a
   companion video carries a `blob:` object URL ([RecordingStorage.ts:92](src/storage/RecordingStorage.ts:92));
   one loaded via `?url=` carries the old host's absolute URL. Re-exporting bakes those in,
   and because `withResolvedMediaUrls` _prefers_ a present `cameraUrl`/`audioUrl`, the dead
   `blob:` URL (or stale host URL) silently defeats sibling-file resolution on next load.
   `normalizeRecordingData` does not strip these.

### Fix design

Resolution priority at load time (per media kind):

1. **Configured URL** persisted in the `.ne` (`audioUrl` / `cameraUrl`) — set explicitly by
   the user via the new UI. Absolute (S3/CDN) or relative to the `.ne`.
2. **Stored sibling filename** (`audioFile` / `cameraFile`) resolved against the `.ne` URL
   (current behavior).
3. **`.ne` basename fallback** — `intro-01.ne` → `intro-01.weba` / `intro-01.webm`, using
   the extension from the stored `audioFile`/`cameraFile` (fall back to `.weba`/`.webm`
   when absent).

Falling from 2 to 3 requires knowing the fetch failed, so resolution becomes
"candidate list + probe" rather than a single string.

#### Step 1 — Sanitize export (`RecordingStorage.exportAsFile`)

- Strip transient URLs before encoding: drop `audioUrl`/`cameraUrl` values with a `blob:`
  (or `data:`) scheme. Also drop stale _resolved_ sibling URLs unless they were explicitly
  configured by the user (see step 2 for how configured URLs are distinguished — simplest:
  the configure dialog is the only thing that writes them at export time; `exportAsFile`
  otherwise clears both fields and writes only `audioFile`/`cameraFile`).
- Keep writing `audioFile`/`cameraFile` sibling names even when a URL is configured, so the
  sibling fallback still works if the configured host goes away.

#### Step 2 — "Configure media links" UI

- Add a small dialog reachable from the workspace settings menu in
  [EditorHeader.tsx](src/components/EditorHeader.tsx) (same menu as Export recording),
  enabled when `currentRecording` has external media (`audioFile`/`audioUrl`/
  `cameraFile`/`cameraUrl` present, or blobs that will be externalized on export).
- Fields: **Audio URL** and **Video URL** (free text; accept absolute `https://…` or a
  relative path resolved against the eventual `.ne` location). Empty = not configured =
  same-basename behavior. Validate with `new URL(value, "https://example.com/")` and warn
  on `blob:`/`data:`.
- Persist onto the in-memory recording via the existing update path
  (`extendRecording({ ...currentRecording, audioUrl, cameraUrl })` from
  `useNextEditorActions`) so a subsequent **re-export** writes them into the `.ne`
  (encoder already serializes both fields — no codec change needed).
  - Verify `extendRecording` doesn't needlessly respawn the audio actor when only the URL
    fields change; if it does, add a narrower update action on the machine.
- Note in the dialog copy: "Leave empty to load media by the `.ne` file's own name
  (`lesson.ne` → `lesson.weba` / `lesson.webm`)."

#### Step 3 — Basename fallback on URL load (`useUrlLoader.ts`)

- Replace `withResolvedMediaUrls` with a candidate-list builder per media kind:
  `[persisted URL (if any), stored filename resolved vs neUrl, neBasename + stored-ext resolved vs neUrl]`,
  deduplicated.
- **Audio:** `attachExternalAudio` already fetches the audio itself — iterate candidates,
  first successful (ok, non-empty, non-HTML) response wins. Cheap to do with the existing
  `fetchNextEditorUrl` proxy fallback.
- **Camera:** playback consumes `cameraUrl` directly in a `<video src>`, so a bad URL fails
  silently inside the player. Probe candidates before assigning: try `HEAD` (fall back to
  `GET` with `Range: bytes=0-0` since S3 presigned URLs sometimes reject HEAD) via
  `fetchNextEditorUrl`; assign the first candidate that answers 2xx with a non-HTML
  content type. Run this in the same out-of-band phase as `attachExternalAudio`
  ([useUrlLoader.ts:483](src/hooks/useUrlLoader.ts:483)) so streaming startup is untouched;
  set the probed URL with `extendRecording`.
- Keep current behavior as the happy path: if candidate 1 or 2 probes fine, nothing changes.

#### Step 4 — (Optional, same pattern) captions

`captionFiles` has the identical rename problem ([useUrlLoader.ts:99-118](src/hooks/useUrlLoader.ts:99)).
Add `<neBasename>.vtt` as a fallback candidate when the declared caption files 404.
Low priority; call out in PR but can ship separately.

### Tests

- Unit: candidate-list builder — configured URL wins; stored-name second; basename+ext
  third; relative configured URLs resolve against the `.ne` URL; `blob:` never emitted.
- Unit: `exportAsFile` — recording with `blob:` `cameraUrl` exports a `.ne` whose decoded
  header has no `cameraUrl`; configured URLs survive; `audioFile`/`cameraFile` always
  written when blobs exist. (Round-trip through the real codec, as
  [recordingCodec.test.ts](src/storage/recordingCodec.test.ts) does.)
- Unit: `attachExternalAudio` fallback ordering with a mocked `fetch` (first candidate 404
  → second candidate used; HTML SPA-fallback response rejected).
- Run with `npx vp test run` + `tsc`; manual UI check is the user's.

### Risks / notes

- Probing adds at most 1–2 extra requests per media kind and only on the URL-load path
  after a miss; no effect on the streaming `.ne` decode.
- Cross-origin S3 buckets still need CORS (or the `/api/proxy` endpoint) — same as today;
  the proxy fallback in `fetchNextEditorUrl` already covers hosts that have it.
- Backwards compatible: old `.ne` files gain the basename fallback for free; no format
  version bump (fields already exist in SCR3).

---

## Issue 2 — Lock files only appear in the file tree after opening the terminal

### Symptom

The startup installer (`pnpm install` / `npm install`) creates `pnpm-lock.yaml` /
`package-lock.json` inside the WebContainer, but the workspace file tree doesn't show
them. Opening the terminal makes them appear.

### Root cause

Reverse sync (container FS → workspace store) is wired **only to terminal-session
activity**, never to the runner/installer:

- The only two `readWorkspaceProject` call sites are
  [WebContainerRuntimeProviderImpl.tsx:126](src/contexts/WebContainerRuntimeProviderImpl.tsx:126)
  (inside `onTerminalOutput`) and
  [WebContainerRuntimeProviderImpl.tsx:370](src/contexts/WebContainerRuntimeProviderImpl.tsx:370)
  (after Enter/Ctrl-C in `sendTerminalInput`).
- `onTerminalOutput` is fired only by `appendTerminalOutput`
  ([useWebContainerRuntimeSession.ts:204](src/contexts/useWebContainerRuntimeSession.ts:204)),
  i.e. output from interactive terminal sessions.
- The startup install runs through `runForegroundCommand`
  ([useWebContainerRuntimeSession.ts:390](src/contexts/useWebContainerRuntimeSession.ts:390),
  called from `prepareRuntime` at
  [WebContainerRuntimeProviderImpl.tsx:201](src/contexts/WebContainerRuntimeProviderImpl.tsx:201)),
  whose output goes to `appendOutput` (runner log) — **no reverse-sync hook**. Same for the
  long-running dev server via `startRunnerProcess`.

So after auto-start, the lock file exists in the container but the workspace store is never
re-read. Opening a terminal happens to emit shell output → `onTerminalOutput` → reverse
sync → lock file appears. The terminal is incidental, not the mechanism the user should need.

### Fix design

**Primary fix — deterministic post-install sync.** Extract the duplicated reverse-sync
closure in `WebContainerRuntimeProviderImpl` (the bodies at lines 111–142 and 361–391 are
near-identical) into one helper, e.g. `requestReverseSync(instance, generation?)` with the
existing 150 ms debounce, then also call it:

1. In `prepareRuntime`, right after the init command exits with code 0
   (after [WebContainerRuntimeProviderImpl.tsx:209](src/contexts/WebContainerRuntimeProviderImpl.tsx:209)'s
   exit-code check, before `hasRunInitCommandRef.current = true` returns the instance).
   This is the exact moment the lock file is guaranteed to exist.
2. (Recommended) After `startRunnerProcess` reaches a running dev server — some tools write
   files on first run (cache manifests, generated route files). Hooking the existing
   `server-ready` / port-open lifecycle path in `useWebContainerRuntimeSession` covers this.

**Secondary option considered — `instance.fs.watch`.** A recursive FS watcher would catch
_every_ container-side write (including background processes) without event plumbing, but
WebContainer's watch API has platform quirks (recursive support/duplicate events), and
`readWorkspaceProject` walks the whole FS on each trigger — a watcher firing during
`pnpm install`'s thousands of `node_modules` writes would thrash even with debounce
(node*modules is ignored on \_import*, but the watcher can't ignore it before firing).
Stick with explicit post-command sync; revisit watching only if users report other missing
container-side writes.

### Implementation steps

1. In `WebContainerRuntimeProviderImpl.tsx`, hoist the reverse-sync body into a single
   helper using `reverseSyncTimeoutRef` (both existing call sites become one-liners; the
   `sendTerminalInput` variant's generation guard folds in as an optional check).
2. Call it after a successful init command in `prepareRuntime`.
3. Call it on the runner-ready lifecycle event (step 2 above), guarded by
   `lessonRunsInWebContainer` like the existing paths.
4. Sanity-check no sync loop: reverse sync calls `loadProject(...)`; the forward-sync
   effect keyed on `syncVersion`
   ([WebContainerRuntimeProviderImpl.tsx:520-538](src/contexts/WebContainerRuntimeProviderImpl.tsx:520))
   may fire, but `syncWorkspaceProject` diffs content and writes nothing when identical —
   this is already the established behavior on the terminal path. Verify `loadProject`
   doesn't flag unsaved changes for a reverse-synced project (whatever the terminal path
   does today is the accepted contract).

### Tests

- Extend the provider/session tests (see
  [useWebContainerWorkspaceSync.test.tsx](src/contexts/useWebContainerWorkspaceSync.test.tsx)
  for the mocking pattern): with a mocked instance whose `fs.readdir`/`readFile` expose a
  new `pnpm-lock.yaml` after the init command resolves, assert `loadProject` is called with
  a project containing that file — **without any terminal session existing**.
- Regression: assert reverse sync still fires on terminal output (existing behavior).
- `npx vp test run` + `tsc`.

### Risks / notes

- `readWorkspaceProject` is a full FS walk (skipping `node_modules`/`.git`); one extra walk
  per install/runner-start is the same cost the terminal path already pays per output burst
  — negligible.
- If the init command is customized to something that writes nothing, the sync is a no-op
  (`areWorkspaceProjectsEqual` short-circuits the `loadProject`).
- Recording sessions: reverse sync during recording emits the same workspace events the
  terminal-triggered sync already does — no new recording semantics.
