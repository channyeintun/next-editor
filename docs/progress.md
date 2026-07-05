# Tube on Cloudflare — Progress

Tracks implementation of [cloudflare-plan.md](./cloudflare-plan.md) /
[cloudflare-architecture.md](./cloudflare-architecture.md). Update after every
completed task. Checkbox = merged to `main`.

Legend: ✅ done · 🚧 in progress · ⛔ blocked (needs input from Chan) · ⬜ not started

## Phase 0 — Scaffolding (no cloud auth needed; local Miniflare only)

- [x] ✅ P0.1 `infra/` package skeleton (package.json, tsconfig for worker, dir layout)
- [x] ✅ P0.2 Root deps: `hono`, `wrangler`, `@cloudflare/workers-types` (bun add)
- [x] ✅ P0.3 D1 schema: `infra/db/migrations/0001_init.sql` (users, sessions, lessons)
- [x] ✅ P0.4 `infra/wrangler.toml` + `infra/worker/env.d.ts` + `.dev.vars.example`
- [x] ✅ P0.5 Hono worker skeleton (`infra/worker/index.ts`): `/api/health`, static-assets passthrough, COEP/COOP middleware
- [x] ✅ P0.6 Dev wiring: vite `server.proxy` for `/api/health`,`/media` → `wrangler dev` port; root `dev:worker`/`dev:all`/`d1:migrate:local` scripts
- [x] ✅ P0.7 Verify: `wrangler dev` boots locally, D1 migration applies `--local`, `/api/health` responds, SPA fallback + seed static assets serve correctly, COEP/COOP present on every response, `bun run dev` unaffected, typecheck/lint/build green

**Findings from P0.4/P0.5/P0.7 (kept here since they'll matter again at deploy time):**

- An unrelated `~/.pnp.cjs` on this machine confuses esbuild's Yarn PnP detection when bundling the Worker (it walks up past the repo root). Fixed with an explicit `[alias] hono = "hono"` in `wrangler.toml` (Cloudflare's own documented workaround).
- Workers Static Assets caps individual files at 25 MiB — irrelevant to the seed (~1 MB total) but confirms large lesson media must go through R2/`/media/*`, never the assets directory. (Also found and cleared a 71 MiB stale/untracked file in a leftover local `dist/` — not part of the tracked seed, just cleaned it.)
- `env.ASSETS.fetch()` for `/index.html` explicitly returns a 307 redirect to `/`, not the page content. Fixed via `not_found_handling = "single-page-application"` in `[assets]` + fetching the original request path as-is.
- **Important:** exact-match static assets bypass the Worker entirely by default, which means they'd ship without the app's required COEP/COOP headers (breaks WebContainers). Fixed with `run_worker_first = true` so every request — including static files — routes through the Worker's header middleware first; the catch-all still forwards to `ASSETS.fetch` for the actual file bytes. Small Worker-CPU cost on static files, but non-negotiable for correctness here.
- The vite proxy deliberately whitelists `/api/health` (not a blanket `/api/*`) — the existing `slideImageProxyPlugin` dev route (`/api/slide-image`) would otherwise be shadowed before it moves into the Worker in Phase 4. Extend the proxy list route-by-route as `infra/worker/routes/*` gains real handlers (`/api/lessons` in Phase 1, `/api/auth`+`/api/uploads` in Phases 2-3).
- **P1.3 (`/media/*`) had two real bugs caught only by testing against a live Miniflare R2 object, not by typecheck:** (1) Hono's bare `"/*"` wildcard does not populate a `"*"` param (came back `undefined`) — use `"/:key{.+}"` to actually capture the tail. (2) `R2Range`'s TS type is a discriminated union, but Miniflare's real resolved `object.range` carries all three keys (`offset`/`length`/`suffix`) with unused ones set to `undefined` rather than omitted, so `"suffix" in range` is true even when unset — check `!== undefined` on values, not key presence. Also: `object.range` resolves to the whole object even with no Range header sent (when `range` is passed as a raw `Headers`), so gate the 206 branch on `c.req.header("range")` actually being present, not just `object.range` truthiness. `object.size` is always the full object size (not the slice length) in both branches. `Content-Length` doesn't need to be set manually — the runtime infers it correctly from the streamed body.
- **P1.4:** widened `nextPage` from `number | null` to an opaque `string | null` cursor (`"seed:n"` / `"d1:n"`) in `tube/src/lib/lessons.ts` — safe because `LessonGrid.tsx`/`useLessonsInfinite` already treat it opaquely (never inspect its type). Also overrode the queryClient-wide `staleTime: Infinity` (tuned for the old build-static-only manifest) with a finite `staleTime` on just the two lesson queries, since the D1 portion is now live data — otherwise a tab left open would never see newly published lessons. `tube/` had zero test coverage before this (vitest's `include` only covered `src/**`) — widened it to include `tube/src/**` and added `tube/src/lib/lessons.test.ts` (9 cases: seed pagination, seed->d1 handoff on both `nextPage:null` and a seed-shard 404, d1-only pagination, detail-route seed/d1/neither/error-passthrough). Full suite: 49 files / 355 tests, all green.

## Phase 1 — Read path (D1 gallery, no auth yet)

- [x] ✅ P1.1 `infra/db/queries.ts` + `infra/db/types.ts` (typed D1 helpers for lessons)
- [x] ✅ P1.2 `GET /api/lessons` (published, paginated) + `GET /api/lessons/:slug`
- [x] ✅ P1.3 `GET /media/*` — R2 stream with Range support + immutable cache headers
- [x] ✅ P1.4 Swap `tube/src/lib/lessons.ts`: seed shards first, then D1 pages; encode source in `nextPage` cursor
- [x] ✅ P1.5 Verification (see notes below) — automatable parts done; visual gallery check is for Chan to eyeball in a real browser (no browser automation used on this project)

## Phase 2 — Auth (Google OAuth) — ⛔ needs Google OAuth Client ID/Secret from Chan before live-testing

Real Google OAuth Client ID/Secret received from Chan and saved to `infra/.dev.vars` (git-ignored); redirect URI `http://localhost:5173/api/auth/google/callback` registered on the client.

- [x] ✅ P2.1 D1 user/session queries (`upsertUserByGoogleSub`, `createSession`, `getSessionUser`, `deleteSession`) + `UserRow`/`SessionRow`/`AuthUser` types — verified upsert/conflict path against real local D1
- [x] ✅ P2.2 `infra/worker/auth/session.ts` — opaque `ne_session` cookie (DB-validated) + `GET /api/auth/me`/`POST /api/auth/logout`
- [x] ✅ P2.3 `infra/worker/auth/google.ts` — PKCE login/callback using Hono's signed-cookie helpers for the handshake state
- [x] ✅ P2.4 Mounted both auth route groups in `worker/index.ts`; added `/api/auth` to the vite dev proxy
- [x] ✅ P2.5 `infra/client/auth/` — `useAuth`, `useSignOut`, `signInUrl`, `AuthMenu` (no `AuthProvider`/Context — see note below)
- [x] ✅ P2.6 `Navbar` gained an optional `actions` slot; `AuthMenu` wired in at `tube/src/LearnPage.tsx` (the `/learn` route) — scoped there rather than also the landing page, since that's where auth-gated functionality actually lives right now
- [ ] ⬜ P2.7 End-to-end sign-in test — needs a real browser click-through against accounts.google.com (Chan to verify; not automatable here)

**P2.5 deviation from the original plan:** dropped the planned `AuthProvider.tsx` Context wrapper. TanStack Query's shared cache already gives every `useAuth()` caller the same session state (identical to how `tube`'s `useLessonsInfinite`/`useLesson` work with no Provider) — a Context would only duplicate that. Deleted the placeholder file rather than leaving unused scaffolding.

**Real bug caught by an actual build, not typecheck:** the P0.1 scaffolding subagent added `@next-editor/infra` to `tsconfig.json`'s `paths` (type-checking only) but never added the matching entry to `vite.config.ts`'s `resolve.alias` (actual bundler resolution) — so the import would have type-checked fine while failing to resolve at runtime. Never surfaced until this task because nothing had imported `@next-editor/infra` until now. Caught by running `bun run build` (which eagerly resolves the whole module graph) after wiring `AuthMenu` into `LearnPage.tsx` — fixed by adding the alias. Full suite still 49/355 green after the fix.

**P2.2-P2.4 verification notes:** everything up to the real Google login screen is built and verified locally (`wrangler dev` + real `.dev.vars` credentials, both directly on :8787 and through the vite proxy on :5173):

- `/api/auth/me` correctly 401s when signed out, and returns the right `AuthUser` shape (no `google_sub` leaked) once a session exists.
- `/api/auth/google/login` redirects to Google with a byte-exact `redirect_uri` match, correct PKCE `code_challenge`/`S256`, and sets a signed, path-scoped (`/api/auth/google`), 10-minute handshake cookie.
- `/api/auth/google/callback` correctly 400s on missing code/state/handshake and on a `state` mismatch (tested independently); the handshake cookie is single-use (cleared unconditionally on read).
- `/api/auth/logout` clears the cookie, deletes the D1 session row, and a subsequent `/me` correctly 401s.
- Hit the same Yarn-PnP bundling false-positive as `hono` itself (see Phase 0 notes) for the `hono/cookie` subpath specifically — needed its own `[alias]` entry in `wrangler.toml` (aliasing "hono" alone wasn't enough).
- **Not (and can't be) automated here:** the actual Google login screen requires real browser interaction with accounts.google.com. Chan: open `http://localhost:5173/api/auth/google/login?returnTo=/code` with `bun run dev` + `bun run dev:worker` running, sign in, and confirm it lands back on `/code` signed in (`/api/auth/me` should then reflect your real Google profile).

## Phase 3 — Write path (upload + publish)

UX spec for the upload modal done via the `frontend-ux-design` skill and approved by Chan — see [upload-modal-ux-spec.md](./upload-modal-ux-spec.md) — before any code. Key decisions: modal auto-opens once per stopped recording (dismissible, never a gate — the recording is already safe in IndexedDB); signed-out state is metadata-free (just a Sign-in button) so nothing typed is ever at risk of being lost across the OAuth redirect _except_ the one case where the session expires mid-form, where the resume intent also carries the typed values; draft→publish is two explicit steps.

- [x] ✅ P3.1 `src/`: extracted `buildRecordingFiles` from `RecordingStorage.exportAsFile` (pure, tested directly — no `NextEditorContext` needed, since it's pure/stateless; infra imports it straight from `@app/storage/RecordingStorage`, same pattern as `@app/components/Editor`)
- [x] ✅ P3.2 `src/components/Editor.tsx`: added `renderPostRecordingModal` render-prop — see P3.6 below, the original edge-detection here had a real bug fixed after live testing
- [x] ✅ P3.3 Upload/publish backend routes — see notes below on the presigned-URL deviation and full ownership-model verification
- [x] ✅ P3.4 `infra/client/upload/` — `UploadLessonModal`, `useUploadLesson`/`uploadLesson` (pure logic + thin hook, mirrors `tube`'s lib/hook split), `resumeIntent` (own tiny IndexedDB store)
- [x] ✅ P3.5 Wired into `/code` via a new `src/components/CodeRoute.tsx` composition root; full write path verified end-to-end using the _real_ client `uploadLesson()`/`publishLesson()` functions (not mocks) against real local D1/R2 — see notes below. Visual/interactive click-through (the actual modal UI, the live Google sign-in) is for Chan to eyeball; not automatable here.
- [x] ✅ P3.6 Two bugs found by Chan's real manual test: the modal never appeared after a real recording, and the avatar image was blocked by COEP. Both fixed — see notes below.

**P3.6 fixes (found by Chan actually testing the feature, not caught by any automated check):**

- **The modal never appeared.** Root cause: `editorMachine.ts`'s real stop-recording transition (the common mic/camera case) goes `"recording"` → `"stoppingRecording"` (an intermediate state where `isRecording` already flips `false`) → later (up to ~2s, once the audio/camera recorder's STOPPED event arrives, or a 2s fallback timeout) → `"loading"`, where `finalizeRecording` finally populates `context.recording`. The original trigger was a plain ref-based `isRecording(true)->(false)` edge check, which fires-and-consumes-itself on the render where `currentRecording` is still `null` — permanently missing the later render where the finished recording actually appears. Fixed by extracting the trigger into `src/hooks/usePostRecordingTarget.ts`, using a _sticky_ "has this session ever been recording" flag plus "haven't shown this exact recording id yet", rather than a one-shot edge — survives however many intermediate machine states occur. Added `usePostRecordingTarget.test.ts`, which reproduces the exact multi-render sequence (`true`→`false,null`→`false,recording`) and would have failed against the original logic (traced by hand: the old code's ref flips to `false` on the middle render, before the target ever appears).
- **Avatar image blocked by COEP.** Google's avatar URLs (`*.googleusercontent.com`) send a `Cross-Origin-Resource-Policy` header that the app's `Cross-Origin-Embedder-Policy: require-corp` blocks from a direct `<img src>` — the exact same problem the Google Slides import feature already solved. Reused that existing, already-proven shared core (`src/googleSlides/imageProxy.ts`'s `proxySlideImage`, whose host allowlist already covers `googleusercontent.com`). **Revised after Chan asked why this needed a separate route from the existing one:** it doesn't — `infra/worker/routes/slideImage.ts` is now mounted at the _same_ canonical `/api/slide-image` path the Vercel Edge Function and Vite dev plugin already use, effectively completing the Worker side of P4.1 ahead of schedule. It's deliberately **not** added to the vite dev proxy list, since the existing `slideImageProxyPlugin` already intercepts that path directly inside the vite dev server regardless of whether the Worker is running — so plain `bun run dev` without `dev:worker` stays completely unaffected (verified: hits the plugin, 400s on a disallowed host, identical to before). The Worker's own copy only actually gets exercised once deployed to Cloudflare for real; the Vercel/Vite-plugin paths stay untouched until that cutover. `AuthMenu`'s avatar `<img>` points at `avatarProxyUrl(user.avatarUrl)` → `/api/slide-image?url=...`.
- Also worth noting for future worker routes: `@app/*` (the Vite-only alias) doesn't resolve inside `infra/worker/**` — Wrangler's own bundler doesn't read `vite.config.ts` at all, so it must be a relative import, same as every other worker file. Caught by the worker's _own_ `tsc -p infra/worker/tsconfig.json` (the root `tsc -b tsconfig.json` didn't catch it, since the root config's `@app` alias made it look fine there).

**P3.4/P3.5 notes:**

- **Deviation from the approved UX spec:** the spec's stated default was "auto-generate a thumbnail from a recording frame." A recording here is code-diff/cursor state, not a video — there's no simple frame to grab without a camera track (optional, often absent). v1 ships with the thumbnail field simply left blank (no generated image, no manual-upload affordance yet either) rather than building frame-grabbing as a side quest. Flagged here rather than silently doing something different from what was approved.
- **`resumeIntent.ts` has no automated test coverage:** jsdom (this project's test environment) doesn't implement `indexedDB` at all, and adding a polyfill (`fake-indexeddb`) just for one small module felt disproportionate. The actual resume-across-OAuth-redirect flow can only be verified with a real browser anyway, so it's folded into the same manual check as the live Google sign-in.
- **`CodeRoute.tsx`** is the composition root wiring `renderPostRecordingModal` into `<Editor>` _and_ independently checking for a pending resume intent on mount (a full-page OAuth redirect remounts the whole app, so Editor's live isRecording-edge trigger can't fire again on return). The resume-check (and the `useAuth()` call it depends on) is gated behind `readOnly` — the landing page's embedded live-demo iframe also loads `/code` (as `?readOnly=true`) and would otherwise pay for an unnecessary `/api/auth/me` fetch + IndexedDB open on every mount of an already mobile-crash-prone surface (see `isMobileBrowser()` in `LandingPage.tsx`) that can never trigger an upload anyway.
- **Extracted `uploadLesson.ts`/`publishLesson.ts`** as plain async functions separate from the `useUploadLesson`/`usePublishLesson` hooks specifically so the core upload orchestration (sequential .ne→audio→camera PUTs, combined progress accounting) could be unit-tested with mocked `apiClient` without needing new React-Query test scaffolding — no existing precedent in this codebase for testing a `useMutation`-based hook directly.
- **Real end-to-end verification** (beyond the mocked unit tests): with `wrangler dev` + `vite dev` both running against real local D1/R2 and a manually-seeded real session, ran a script calling the actual `uploadLesson()`/`publishLesson()` client functions (not test doubles) against the real backend — confirmed the draft is invisible via public slug lookup before publishing (404), becomes visible with exactly correct fields after publishing, and the uploaded `.ne` bytes are byte-identical whether fetched directly from R2 or through the `/media/*` route the player actually uses.
- Full suite after all of Phase 3: 50 test files / 362 tests, typecheck/lint/build all green.

**P3.3 notes:**

- **Deviation from the original plan:** no presigned R2 PUT URLs — we don't have R2 signing keys configured (that needs the real Cloudflare account, Phase 4). Instead the client PUTs bytes straight through a Worker route (`PUT /api/uploads/:id/media/:filename`), which streams them into R2 via the binding directly — works identically in local dev and real deployment, no external R2 API token needed. Filename is constrained by the route pattern itself to a safe charset + a known extension allow-list (verified: an `.exe` and a `../` traversal attempt both 405 — no matching route).
- **Ownership model, fully verified with two real local-D1 users (Alice/Bob) exercising every case:** before a lesson's D1 row exists, any signed-in user can upload media under a given id (fine — real ids are unguessable `crypto.randomUUID()` values, not the predictable test id used here); once `POST /api/lessons` claims that id, further uploads under it are checked against `owner_id` and a non-owner gets 403. `PATCH`/`POST .../publish`/`DELETE` all return the _same_ 404 for "doesn't exist" and "exists but not yours" (doesn't leak existence to a non-owner). `DELETE` confirmed to actually remove both the D1 row and every R2 object under `lessons/<id>/` (checked via a follow-up `r2 object get` returning "key does not exist"). Duplicate `id` on create correctly 409s rather than silently overwriting.

## Phase 4 — Cutover & hardening

Chan chose **full cutover** (point the main domain straight at the Worker, replacing the current Vercel site) rather than a subdomain-first rollout. Chan ran `wrangler login` themselves (account: `Chanyeintun@gmail.com's Account`, id `b9cae7e40e0a9182d9c1be5560d4dd71`).

- [x] ✅ P4.1a `/api/slide-image` — Worker-side done ahead of schedule in Phase 3 (see P3.6 notes); Vercel Edge Function + Vite dev plugin deliberately untouched until cutover
- [ ] ⬜ P4.1b `/api/proxy` (cross-origin `.ne` loading) — still to move into the Worker
- [x] ✅ P4.2 Real Cloudflare resources created: D1 `next-editor-tube` (id `c9dc42e5-2602-4740-86a1-71b5646b7bbf`), R2 bucket `next-editor-tube-media`, migration `0001_init.sql` applied to remote (verified: `users`/`sessions`/`lessons` tables exist)
- [x] ✅ P4.3 Production secrets set via `wrangler secret put` (piped from a scratchpad temp file, never as a CLI arg — deleted immediately after): `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (same real credentials as dev), `SESSION_SECRET` (freshly generated, distinct from the local one)
- [x] ✅ P4.4 Deployed — live at `https://next-editor-tube.chanyeintun.workers.dev`. Smoke tested for real: `/api/health` 200, COEP/COOP headers present, `/learn` SPA 200, seed catalog + seed audio (621626 bytes, byte-identical to local) served correctly, `/api/lessons` hits the real remote D1 (empty, as expected — no lessons published yet), `/api/auth/me` correctly 401s signed-out
- [x] ✅ P4.6 Custom domain cutover — **`nexteditor.dev` is live on Cloudflare.** Chan: registered the production redirect URI in Google Cloud Console, added the zone to Cloudflare and pointed nameservers at it (`ariadne`/`cullen`.ns.cloudflare.com), set `PUBLIC_URL = "https://nexteditor.dev"`. I added `[[routes]] pattern = "nexteditor.dev", custom_domain = true` to `wrangler.toml` (bare hostname, no path glob — Custom Domains cover every path by design, confirmed against Cloudflare's own docs rather than guessed). First deploy attempt 409'd: Cloudflare had imported the existing Vercel A records for the bare apex during zone setup and won't silently overwrite a record at a name a Custom Domain needs to claim. Chan deleted the two apex `A` records (216.198.79.1/.65) via the dashboard — left `www`, the wildcard, the CAA records, and the `_domainconnect` artifact untouched, all unrelated. Redeployed clean.
  - Verified for real (querying `1.1.1.1` directly to sidestep normal DNS propagation lag, since the apex records had just changed): `/api/health` 200, COEP/COOP headers present, `/learn` 200, seed catalog correct, and `/api/auth/google/login`'s redirect_uri is exactly `https://nexteditor.dev/api/auth/google/callback` with the session cookie now correctly carrying `Secure` (real HTTPS, derived from the request scheme same as local dev's http).
  - **Still needs Chan:** the actual Google sign-in click-through on the real domain — same as the local dev version, this can't be done without a human at a real browser.
- [ ] ⬜ P4.7 Reconcile cron (sweep abandoned draft uploads) — optional hardening

**Note on the OAuth redirect URI once the domain changes:** the _current_ Google OAuth client only has `http://localhost:5173/api/auth/google/callback` registered. Signing in on the production domain will fail with `redirect_uri_mismatch` until Chan adds the production callback URL in Google Cloud Console — same step as the original dev setup.

## Open items / decisions deferred (see plan doc "Open questions")

- Thumbnail: generated frame vs required upload — defaulting to generated + override
- Quotas — deferring, revisit post-launch
- `wrangler dev` + vite proxy vs Cloudflare vite plugin — decide in P0.6 based on what actually works with vite-plus

## Credentials/config needed from Chan (asked for when the blocking task is reached, not before)

- [ ] Google OAuth Client ID + Secret, consent screen scope `openid email profile` (Phase 2)
- [ ] Cloudflare account auth — interactive `wrangler login` (you run it) or a `CLOUDFLARE_API_TOKEN` for me to use non-interactively (Phase 4, or earlier if real resource IDs are wanted sooner)
- [ ] Production domain choice, or start on `*.workers.dev` (Phase 4)
