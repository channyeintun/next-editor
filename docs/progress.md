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
- [ ] ⬜ P2.2 `infra/worker/auth/session.ts` — opaque `ne_session` cookie (DB-validated) + `GET /api/auth/me`/`POST /api/auth/logout`
- [ ] ⬜ P2.3 `infra/worker/auth/google.ts` — PKCE login/callback using Hono's signed-cookie helpers for the handshake state
- [ ] ⬜ P2.4 Mount both auth route groups in `worker/index.ts`; add `/api/auth` to the vite dev proxy
- [ ] ⬜ P2.5 `infra/client/auth/` — `AuthProvider`, `useAuth`, `AuthMenu`
- [ ] ⬜ P2.6 Mount `AuthProvider` at router root; `Navbar actions` slot wired to `AuthMenu`
- [ ] ⬜ P2.7 End-to-end sign-in test — needs a real browser click-through against accounts.google.com (Chan to verify; not automatable here)

## Phase 3 — Write path (upload + publish)

- [ ] ⬜ P3.1 `src/`: extract `buildRecordingFiles` from `RecordingStorage.exportAsFile` (pure); expose via `NextEditorContext`
- [ ] ⬜ P3.2 `src/components/Editor.tsx`: add `renderPostRecordingModal` render-prop (opt-in, no behavior change when absent)
- [ ] ⬜ P3.3 `frontend-ux-design` pass for `<UploadLessonModal>` states (signed-out, OAuth-return resume, form, uploading, success, error)
- [ ] ⬜ P3.4 `POST /api/uploads/sign` — presigned R2 PUT URLs, scoped to `lessons/<id>/…`
- [ ] ⬜ P3.5 `POST /api/lessons` (draft), `PATCH /api/lessons/:id`, `POST /api/lessons/:id/publish`, `DELETE /api/lessons/:id` — ownership-enforced
- [ ] ⬜ P3.6 `infra/client/upload/` — `UploadLessonModal`, `useUploadLesson`, `resumeIntent` (OAuth-redirect resume via IndexedDB-persisted recording)
- [ ] ⬜ P3.7 Wire `/code` route: `renderPostRecordingModal={(ctx) => <UploadLessonModal {...ctx} />}`
- [ ] ⬜ P3.8 Manual verification: record → sign in → upload → draft → publish → shows in gallery → plays back

## Phase 4 — Cutover & hardening — ⛔ needs real Cloudflare account auth (login or API token) + domain before this phase

- [ ] ⬜ P4.1 Move `/api/slide-image` and `/api/proxy` into the Worker (keep Vercel version until cutover)
- [ ] ⬜ P4.2 Real Cloudflare resources: `wrangler d1 create`, R2 bucket create, custom domain/route — **needs Chan: Cloudflare login or API token, account id, domain choice**
- [ ] ⬜ P4.3 Secrets: `wrangler secret put` for `GOOGLE_CLIENT_ID/SECRET`, `SESSION_SECRET`, (R2 signing keys if used) — **needs Chan**
- [ ] ⬜ P4.4 `bun run build` → `wrangler deploy`; smoke test production
- [ ] ⬜ P4.5 Reconcile cron (sweep abandoned draft uploads) — optional hardening

## Open items / decisions deferred (see plan doc "Open questions")

- Thumbnail: generated frame vs required upload — defaulting to generated + override
- Quotas — deferring, revisit post-launch
- `wrangler dev` + vite proxy vs Cloudflare vite plugin — decide in P0.6 based on what actually works with vite-plus

## Credentials/config needed from Chan (asked for when the blocking task is reached, not before)

- [ ] Google OAuth Client ID + Secret, consent screen scope `openid email profile` (Phase 2)
- [ ] Cloudflare account auth — interactive `wrangler login` (you run it) or a `CLOUDFLARE_API_TOKEN` for me to use non-interactively (Phase 4, or earlier if real resource IDs are wanted sooner)
- [ ] Production domain choice, or start on `*.workers.dev` (Phase 4)
