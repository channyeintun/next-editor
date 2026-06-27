# API Client Feature — Progress

## Phase 1: Transport + bridge (no UI) ✅

- [x] `apiClientBridge.ts`: message constants + `createApiClientProxyScript`
- [x] Inject proxy into `createRuntimePreviewScript`; add to snapshot strip list
- [x] `API_CLIENT_RESPONSE` branch in `usePreviewMessageBridge`
- [x] `apiClientBridge.test.ts` (script shape, marker guard, strip)

## Phase 2: Store + orchestration ✅

- [x] `apiClientStore.ts` + `ApiClientStoreContext.tsx` + provider wiring
- [x] `useApiClient.ts`: send/await/timeout/fallback
- [x] Store + hook tests

## Phase 3: Panel UI ✅

- [x] `ApiClientPanel.tsx` (request line, Headers/Body tabs, response, history)
- [x] Monaco for body + response viewer, reusing `monacoSetup.ts`

## Phase 4: Preview integration + gating ✅

- [x] `Browser | API` mode toggle in `PreviewChrome`, gated on `lessonRunsInWebContainer` + runtime `ready`
- [x] `activeMode` in `usePreviewController`; keep iframe mounted in `api` mode
- [x] Wire ApiClientPanel + useApiClient send/response through controller and message bridge

## Phase 5: Record/replay via rrweb-recorded API iframe ✅

Replace the React/Monaco overlay panel with a self-contained `srcdoc` iframe so the
existing rrweb pipeline records and replays it (no codec/replayer changes).

- [x] `apiClientRuntime.js` + `apiClientDocument.ts`: self-contained API client
      HTML/CSS/JS document (request line, headers, body, response with regex JSON
      highlight, history) + embedded rrweb recorder, posting requests via postMessage
- [x] Add on-demand `takeFullSnapshot` handler to the rrweb recorder (so leaving
      API mode re-snapshots the preview for replay)
- [x] Render the API iframe in `Preview.tsx` (srcdoc overlay, mounted only while
      it is the active frame so rrweb streams don't interleave)
- [x] `usePreviewMessageBridge`: accept rrweb messages from the API iframe; relay
      API_CLIENT_REQUEST → preview iframe and API_CLIENT_RESPONSE → API iframe
- [x] `usePreviewController`: manage API iframe ref + switch-back snapshot; post
      runtime readiness to the iframe
- [x] Remove the old React panel stack (ApiClientPanel, apiClientStore + test,
      ApiClientStoreContext, useApiClient, Editor provider wiring)
