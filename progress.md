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
