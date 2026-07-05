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

## Phase 1 — Read path (D1 gallery, no auth yet)

- [x] ✅ P1.1 `infra/db/queries.ts` + `infra/db/types.ts` (typed D1 helpers for lessons)
- [x] ✅ P1.2 `GET /api/lessons` (published, paginated) + `GET /api/lessons/:slug`
- [ ] ⬜ P1.3 `GET /media/*` — R2 stream with Range support + immutable cache headers
- [ ] ⬜ P1.4 Swap `tube/src/lib/lessons.ts`: seed shards first, then D1 pages; encode source in `nextPage` cursor
- [ ] ⬜ P1.5 Local verification: seed `introduction` still loads w/ zero D1 hits; a hand-inserted local D1 row + local R2 object renders in gallery + plays back same-origin

## Phase 2 — Auth (Google OAuth) — ⛔ needs Google OAuth Client ID/Secret from Chan before live-testing

- [ ] ⬜ P2.1 `infra/worker/auth/session.ts` — cookie sign/parse, session middleware
- [ ] ⬜ P2.2 `infra/worker/auth/google.ts` — PKCE login/callback, user upsert
- [ ] ⬜ P2.3 `GET /api/auth/me`, `POST /api/auth/logout`
- [ ] ⬜ P2.4 `infra/client/auth/` — `AuthProvider`, `useAuth`, `AuthMenu`
- [ ] ⬜ P2.5 Mount `AuthProvider` at router root; `Navbar actions` slot wired to `AuthMenu`
- [ ] ⬜ P2.6 End-to-end sign-in test — **blocked until real Google OAuth credentials + redirect URIs are provided**

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
