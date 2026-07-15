# Code review findings

Scope: static repository-wide review of tracked human-authored application code, tests, configuration, scripts, and documentation in the root app, `src/core`, `infra`, and `tube`. The `remote-runtime` package was excluded. Generated/minified code, lockfiles, fonts, WASM, and binary/media assets were inventoried but not line-reviewed as source. The findings below were subsequently remediated in the commits listed under resolution status; no background processes, full-repository typecheck, or full test suite was run.

## Findings

### [P0] Untrusted lesson slides execute scripts in the application origin

`src/components/CustomSlideRenderer.tsx:22-45`; `src/components/GoogleSvgSlide.tsx:28`

`RawHtmlSlide` inserts recording-controlled content into the main document and deliberately recreates every `<script>` element so it executes. Markdown and SVG paths also insert unsanitized markup. Published `.ne` uploads are not decoded or validated server-side (`infra/worker/routes/uploads.ts:28-68`), so a lesson author can run script as every viewer in the application's origin, including authenticated same-origin requests and access to browser-resident workspace/credentials. Render this content in a sandboxed, origin-isolated iframe with a narrow message API, or apply a strict active-content allowlist before it reaches the main document.

### [P1] Validate every proxy redirect before sending the next request

`src/shared/proxy.ts:97-115`

The public `/api/proxy` SSRF defense uses `fetch(..., { redirect: "follow" })` and validates `response.url` only after the redirect chain completes. A permitted URL can redirect to an internal address; the sensitive request is already sent before the final check rejects it. Hostnames resolving to private addresses also pass the lexical hostname test. Follow redirects manually with a hop limit and validate the resolved destination before every request, using DNS/IP enforcement or a strict host allowlist appropriate to the deployment.

### [P1] Bound response size and stream the public fetch proxy

`src/shared/proxy.ts:97-123`

The unauthenticated arbitrary-URL proxy has no timeout or upstream size limit and materializes every successful response with `arrayBuffer()`. A large or endless response, multiplied across concurrent requests, can exhaust Worker/local-process memory and egress. Stream with a byte-counting cap and cancellation; add an upstream timeout plus authentication/rate limiting or narrow the endpoint to its intended hosts.

### [P1] Enforce ZIP limits before decompression

`src/utils/workspaceZipImport.ts:217-262`

The importer calls synchronous `unzipSync` for the whole archive, then checks the 50 MB expanded-size limit only after all output buffers exist. A small compression bomb can allocate far beyond the cap and block or crash the tab before the guard runs. Validate central-directory uncompressed sizes and entry count first, then extract incrementally under the same hard limit.

### [P1] Bound SCR3 inflation and decoded record counts

`src/storage/streamingRecordingCodec/format.ts:162-165,261-280`; `src/storage/streamingRecordingCodec/decode.ts:382-415,424-503`

Arbitrary uploaded/imported `.ne` data is synchronously passed through `unzlibSync` and MessagePack decode for the header and every segment without a decompressed-byte, nesting, or record-count bound. The streaming reader also retains the entire compressed stream while accumulating all decoded state. A compact malicious header or segment can therefore expand to extreme memory on a viewer's main thread, independently of the network byte size. Reject excessive compressed header/segment lengths, use bounded/incremental inflation, cap decoded records and structural depth, and enforce a total recording budget.

### [P1] External-audio recording drops the selected file

`src/components/MediaControls.tsx:384-389`; `src/core/src/types.ts:393-397`; `src/contexts/NextEditorContext.ts:22-26`; `src/core/src/useNextEditor.ts:112-124`

The UI and public/context types pass the selected external file as `audioBlob`, but the action adapter declares and reads only `audioUrl`. The blob is consequently never placed on `START_RECORDING`; selecting external audio falls through to the no-external-audio behavior (and the conflicting function types can also fail a scoped typecheck). Make the option/event contract consistent and pass the blob through to the recording actor.

### [P1] Prevent a stale lesson's media task from overwriting a newer load

`src/hooks/useUrlLoader.ts:474-492,499-555`

The generation/abort checks protect the `.ne` fetch and caption callback, but `resolveExternalMedia` is launched detached and receives neither the abort signal nor `isStale`. If another URL is loaded while the old camera probe/audio download is pending, the old task can later call `extendRecording(current)` and replace/extend the newly loaded recording. Pass the generation/signal into all media operations and re-check immediately before applying their result.

### [P2] Send the clamped seek value to child actors

`src/core/src/machine/replayActions.ts:278-306`; `src/core/src/machine/editorMachine.ts:713-729,869-886`; `src/core/src/machine/timelineMachine.ts:54-59,105-110`

`seekToTime` clamps the requested value only in the editor context. Later actions in the same transition send raw `event.time` to the timeline and audio actors, and the timeline accepts it unchanged. Negative or beyond-duration programmatic seeks therefore leave editor state, timeline ticks, and audio at different positions. Compute one clamped value and use it for context, replay application, notifications, timeline, and audio.

### [P2] Wait for queued appends before closing an aborted recording sink

`src/storage/recordingStreamSink.ts:71-73,130-132,166-180`

`abort()` immediately starts `closeSink()`, but unlike `finish()`, it does not await `appendQueue`. Already queued segment work can resume afterward, call `flush()`, and enqueue writes after the sink has been closed. This can lose the tail, reject asynchronously, or violate a sink's close/write contract during unmount. Mark the bridge aborted, await or cancel the append queue, then close once no later flush can run.

### [P2] Do not cache mutable upload keys as immutable for a year

`infra/worker/routes/media.ts:40-44`; `infra/worker/routes/uploads.ts:38-68`

Media responses are cached as `max-age=31536000, immutable`, while the upload route permits an owner to overwrite the same R2 key. Re-uploading a recording or companion media can update R2 while browsers/CDNs keep serving the old bytes for a year. Make keys content-addressed/versioned and reject overwrites, or use revalidating cache headers and purge caches after replacement.

## Verification notes

This review and remediation were deliberately resource-bounded for the 900 MB host. Targeted searches, per-file inspection, and `git diff --check` were used; no background command, full-repository typecheck, or full test run was performed. The targeted test runner could not start because dependencies are absent (`vp: not found`), and dependencies were not installed on the constrained host. Findings are ordered by impact, not by file order.

## Resolution status

| Finding | Status | Remediation commit |
| --- | --- | --- |
| P0 untrusted slide execution | Fixed | `e31f7b3` |
| P1 redirect validation | Mitigated: manual validated hops, timeout, literal-host checks; generic cross-runtime DNS rebinding remains a deployment concern | `4b71dcd` |
| P1 proxy response buffering | Fixed | `4b71dcd` |
| P1 ZIP decompression | Fixed | `1a22f6e` |
| P1 SCR3 decompression | Fixed | `1a22f6e` |
| P1 external-audio blob handoff | Fixed | `3545356` |
| P1 stale media resolution | Fixed | `3545356` |
| P2 seek propagation | Fixed | `3545356` |
| P2 recording-sink abort ordering | Fixed | `3545356` |
| P2 mutable immutable-cache keys | Fixed | `db4667f` |
