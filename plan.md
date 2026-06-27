# Plan: Lightweight API Client for backend lessons

Add a small, Postman-style **API Client** panel so backend lessons (currently the
`htmx-express` starter, plus any future server starters) can demonstrate calling
endpoints — pick a method, type a path, set headers/body, **Send**, and read the
response — without leaving the editor.

This is deliberately minimal: no collections, no environments, no auth flows, no
OpenAPI. Just one request → one response, plus a small in-session history. The whole
point is "very lightweight and compatible with the lessons," so it must reuse the
editor's existing surfaces and add ~no bundle weight.

---

## The two constraints that drive the design

1. **CORS.** Backend lessons run inside a WebContainer and the preview is a
   **cross-origin iframe** (`effectiveRuntimePreviewUrl`, e.g.
   `https://xxxx--3000.local-credentialless.webcontainer.io`). The Express starter
   (`src/starters/htmxExpress.ts`) sets **no CORS headers**, so a `fetch()` issued
   from the editor's origin to the server URL is blocked. → Requests must be
   **tunneled through the preview iframe** (same origin as the server).

2. **Record / replay.** Everything in the app is captured via the xstate event
   pipeline + rrweb and replayed on timeline. The API client should ride the same
   `PreviewEvent` rails so a recorded lesson replays the request and its response.
   (Scoped to a later phase so the core ships first — see Phase 5.)

Both are already solvable with machinery in the repo:

- `createRuntimePreviewScript()` in `src/contexts/webContainerRuntimeSupport.ts:160`
  is injected into **every** preview HTML response via `WebContainer.setPreviewScript`.
  We extend it with a tiny **fetch-proxy** that listens for a request message,
  performs a same-origin `fetch()` inside the iframe, and posts the response back.
- `usePreviewMessageBridge` (`src/components/preview/usePreviewMessageBridge.ts`)
  is the existing parent-side `window.message` listener — we add one message type.

---

## Architecture rule: reuse existing deps, don't hand-roll

Mirrors the captions plan. Before adding any new hook/context/`localStorage`+event
plumbing, use the patterns already here:

- **Panel state** (draft request, last response, history) → a store built with
  `@xstate/store-react` `createStore`, exactly like `src/stores/runtimePanelStore.ts`
  / `workspaceStore.ts` (`context` + `on:` handlers + `selectX` selectors + a
  `…StoreContext` consumed via `useSelector`). **Not** Zustand, not a bespoke
  `useSyncExternalStore`. (See memory: `store-convention-xstate-store`,
  `reuse-xstate-deps-not-handrolled`.)
- **Body / response editors** → the **Monaco** instance already in deps
  (`monaco-editor`, `@monaco-editor/react`), with the project's `monacoSetup.ts`.
  No new JSON editor dependency.
- **Icons** → `lucide-react` (already used throughout the preview chrome).
- **Styling** → Tailwind v4 classes matching `PreviewChrome.tsx` / `PreviewToolbar`
  (the `#242938` / `#1d1f29` / slate palette).
- **Transport** → the existing `setPreviewScript` injection + the postMessage bridge.
  No `axios`, no proxy server.
- **Gating** → `lessonRunsInWebContainer(lessonType)` (`src/types/workspace.ts:42`)
  plus runtime `status === "ready"`.

---

## UX shape: the preview panel has two modes

The preview panel becomes a single surface with **two view modes**, toggled by a
segmented control in its header (`PreviewChrome`). The same dock/float/resize chrome
hosts both — we are not adding a second panel.

- **Mode 1 — Browser** (default): today's runtime/preview iframe, unchanged.
- **Mode 2 — API**: the new API client view (request line, headers/body, response,
  history).

Mode rules:

- The mode toggle only appears when `lessonRunsInWebContainer(lessonType)` is true
  and the runtime is `ready`. Otherwise the panel is Browser-only and behaves
  exactly as today (no toggle shown).
- Switching to **API** hides the iframe but keeps it **mounted** — the runtime
  preview state and the fetch-proxy transport (which lives inside that iframe) must
  survive the mode switch. Switching back to **Browser** reveals it untouched.
- The active mode is panel state (`activeMode: "browser" | "api"`) owned by
  `usePreviewController`; it resets to `browser` when the toggle is hidden.

API client panel layout (top → bottom):

1. **Request line**: method `<select>` (GET/POST/PUT/PATCH/DELETE) + path input
   (relative, e.g. `/api/time`; the base URL is the runtime preview origin, shown
   as a read-only prefix) + **Send** button.
2. **Tabs**: `Headers` (editable key/value rows) · `Body` (Monaco, JSON, hidden for
   GET/HEAD).
3. **Response**: status badge + time + size, response headers (collapsible), and a
   Monaco read-only viewer (pretty-printed JSON / text / a note for binary).
4. **History**: a short in-session list of recent requests (method + path + status);
   click to repopulate the request line. Capped (e.g. last 25), memory-only.

---

## Transport: request tunneling (the core)

Parent → iframe (only when an iframe origin matches the runtime preview URL):

```
postMessage({ type: "API_CLIENT_REQUEST",
  payload: { id, method, path, headers, body } }, runtimePreviewOrigin)
```

Injected proxy (inside `createRuntimePreviewScript`), guarded by a setup marker like
the other injected scripts:

```
window.addEventListener("message", async (e) => {
  if (e.data?.type !== "API_CLIENT_REQUEST") return;
  const { id, method, path, headers, body } = e.data.payload;
  const started = performance.now();
  try {
    const res = await fetch(path, { method, headers,
      body: method === "GET" || method === "HEAD" ? undefined : body });
    const text = await res.text();
    parent.postMessage({ type: "API_CLIENT_RESPONSE", payload: {
      id, ok: true, status: res.status, statusText: res.statusText,
      headers: [...res.headers], body: text,
      durationMs: performance.now() - started } }, "*");
  } catch (err) {
    parent.postMessage({ type: "API_CLIENT_RESPONSE", payload: {
      id, ok: false, error: String(err),
      durationMs: performance.now() - started } }, "*");
  }
});
```

Parent side: `usePreviewMessageBridge` gains an `API_CLIENT_RESPONSE` branch that
resolves the pending request (matched by `id`) and writes it into the store.

Notes:

- `id` correlates request/response; the store keeps a `pending` map with a timeout
  (e.g. 30s) so a dead server surfaces a clean error.
- Relative `path` keeps requests same-origin inside the iframe → no CORS.
- **Fallback**: if the proxy is somehow unavailable, attempt a direct
  `fetch(previewUrl + path)` and, on a CORS/network failure, show an inline hint
  ("the lesson server must allow this origin"). Tunnel is the default path.

---

## Files

**New**

- `src/stores/apiClientStore.ts` — `createStore`: draft request, response, history,
  `pending` map; events `setMethod` / `setPath` / `setHeader` / `setBody` /
  `requestSent` / `responseReceived` / `selectFromHistory`; selectors.
- `src/contexts/ApiClientStoreContext.tsx` — provider + hook, mirroring
  `RuntimePanelStoreContext` / `CaptionStoreContext`.
- `src/components/preview/ApiClientPanel.tsx` — the panel UI (request line, tabs,
  response, history).
- `src/components/preview/useApiClient.ts` — orchestration: build the message, send
  via the iframe, await the response, update the store; owns the pending/timeout
  logic and the direct-fetch fallback.
- `src/utils/apiClientBridge.ts` — shared message-type constants + the injected
  proxy script factory (`createApiClientProxyScript(marker)`), unit-testable like
  `iframeInteractionCapture.ts`.
- Tests: `apiClientBridge.test.ts`, `apiClientStore.test.ts`,
  `useApiClient.test.ts` (jsdom + a mock iframe/postMessage, following
  `usePreviewController.test.ts`).

**Edited**

- `src/contexts/webContainerRuntimeSupport.ts` — concat `createApiClientProxyScript`
  into `createRuntimePreviewScript()` (new marker constant), and add it to
  `stripRuntimeSnapshotScript`'s strip list so it never lands in a snapshot/recording.
- `src/components/preview/usePreviewMessageBridge.ts` — handle `API_CLIENT_RESPONSE`.
- `src/components/preview/PreviewChrome.tsx` — `Browser | API` segmented control in
  the toolbar (gated), + `activeMode` / `onModeChange` props.
- `src/components/preview/usePreviewController.ts` — own `activeMode` state; expose it
  - the runtime preview origin to the panel; keep the iframe mounted in `api` mode.
- Wire `ApiClientStoreContext` provider near the other preview/runtime providers
  (find the existing provider stack; likely `Editor.tsx` / a providers module).

---

## Phases

### Phase 1 — Transport + bridge (no UI)

- [ ] `apiClientBridge.ts`: message constants + `createApiClientProxyScript`.
- [ ] Inject proxy into `createRuntimePreviewScript`; add to snapshot strip list.
- [ ] `API_CLIENT_RESPONSE` branch in `usePreviewMessageBridge`.
- [ ] `apiClientBridge.test.ts` (script shape, marker guard, strip).

### Phase 2 — Store + orchestration

- [ ] `apiClientStore.ts` + `ApiClientStoreContext.tsx` + provider wiring.
- [ ] `useApiClient.ts`: send/await/timeout/fallback.
- [ ] Store + hook tests.

### Phase 3 — Panel UI

- [ ] `ApiClientPanel.tsx` (request line, Headers/Body tabs, response, history).
- [ ] Monaco for body + response viewer, reusing `monacoSetup.ts`.

### Phase 4 — Preview integration + gating

- [ ] `Browser | API` mode toggle in `PreviewChrome`, gated on
      `lessonRunsInWebContainer` + runtime `ready`.
- [ ] `activeMode` in `usePreviewController`; keep iframe mounted in `api` mode.
- [ ] Seed the `htmx-express` starter expectation: `GET /api/time` works end-to-end.

### Phase 5 — Record / replay (optional, follow-up)

- [ ] Emit an `api_client_request` `PreviewEvent` (request + response) so recorded
      lessons replay the call on timeline; extend the recorded-event types and the
      replay path. Deferred so Phases 1–4 ship a working live tool first.

---

## Out of scope (keeps it "lightweight")

- Collections, saved environments, variables, scripting/tests.
- Auth helpers (OAuth, bearer flows) — users can add an `Authorization` header by hand.
- GraphQL/WebSocket/SSE protocols.
- Persisting history across reloads (memory-only for now).

## Open questions

- Show the `API` tab for **all** WebContainer lessons, or only backend-flavored ones
  (`htmx-express`)? Default: all webcontainer lessons (they all have a dev server),
  but it's most useful for server lessons.
- Should `Send` also be triggerable from the preview's address-bar Enter, or only the
  dedicated panel? Default: panel only, to keep the preview toolbar unchanged.
