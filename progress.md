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

## Phase 5: Record/replay via event-stream ✅

- [x] Add `api_client_mode` / `api_client_request` / `api_client_response` event types to `PreviewEvent`
- [x] Add `ApiClientRecordedRequest/Result` types, `activeMode`/`apiClientState` to `PreviewState`
- [x] Extend `mergePreviewEventState` to carry API client state during replay
- [x] Emit recording events: mode switch, request sent, response received
- [x] Apply replayed state during playback via `usePreviewPlaybackRegistration`
