# API Client Feature — Progress

## Phase 1: Transport + bridge (no UI)

- [ ] `apiClientBridge.ts`: message constants + `createApiClientProxyScript`
- [ ] Inject proxy into `createRuntimePreviewScript`; add to snapshot strip list
- [ ] `API_CLIENT_RESPONSE` branch in `usePreviewMessageBridge`
- [ ] `apiClientBridge.test.ts` (script shape, marker guard, strip)

## Phase 2: Store + orchestration

- [ ] `apiClientStore.ts` + `ApiClientStoreContext.tsx` + provider wiring
- [ ] `useApiClient.ts`: send/await/timeout/fallback
- [ ] Store + hook tests

## Phase 3: Panel UI

- [ ] `ApiClientPanel.tsx` (request line, Headers/Body tabs, response, history)
- [ ] Monaco for body + response viewer, reusing `monacoSetup.ts`

## Phase 4: Preview integration + gating

- [ ] `Browser | API` mode toggle in `PreviewChrome`, gated on `lessonRunsInWebContainer` + runtime `ready`
- [ ] `activeMode` in `usePreviewController`; keep iframe mounted in `api` mode
- [ ] Seed the `htmx-express` starter expectation: `GET /api/time` works end-to-end
