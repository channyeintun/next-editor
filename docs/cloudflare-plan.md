# Tube on Cloudflare — Implementation Plan

> Status: **plan only. No implementation yet** (per request). This is the build
> order, the exact code touch-points, and the config/secrets to gather. Design
> rationale lives in [cloudflare-architecture.md](./cloudflare-architecture.md).

Guiding constraint: **all Cloudflare / D1 / R2 / OAuth / upload logic lands in a
new `infra/` package.** `src/` gains only two small, generic seams. `tube/` gets
a minimal catalog-source swap. If `infra/` were deleted, the app would still
build and the `/code` + static `/learn` routes would behave exactly as today.

## The `infra/` package layout

New workspace package `@next-editor/infra` (mirrors how `tube/` is set up):

```
infra/
  package.json                # private workspace pkg, peerDeps on react/hono/etc.
  wrangler.toml               # Worker + D1 + R2 + Static Assets bindings
  .dev.vars.example           # local secrets template (git-ignored real file)
  db/
    migrations/
      0001_init.sql           # users, sessions, lessons (+ indexes)
    queries.ts                # typed D1 helpers
    types.ts                  # DB row types
  worker/
    index.ts                  # Hono app entry (Worker fetch handler)
    auth/
      google.ts               # OAuth: login, callback, PKCE, session issue
      session.ts              # cookie parse/sign, session lookup middleware
    routes/
      lessons.ts              # GET/POST/PATCH/DELETE /api/lessons*
      uploads.ts              # POST /api/uploads/sign  (presign R2)
      media.ts                # GET /media/*  (R2 stream, Range, cache)
      slideImage.ts           # /api/slide-image (moved from api/slide-image.ts)
      proxy.ts                # /api/proxy (cross-origin .ne proxy)
    r2.ts                     # presign + get/put helpers
    env.d.ts                  # Worker Env bindings (DB, BUCKET, secrets)
  client/
    index.ts                  # public exports for the host app
    apiClient.ts              # thin fetch wrapper (credentials: 'include')
    auth/
      AuthProvider.tsx        # session state (useQuery /api/auth/me)
      useAuth.ts
      AuthMenu.tsx            # sign-in button / avatar menu for the Navbar slot
    upload/
      UploadLessonModal.tsx   # THE post-recording modal (passed as a prop)
      useUploadLesson.ts      # sign → PUT to R2 → create draft → publish
      resumeIntent.ts         # persist/restore across OAuth redirect
```

The Worker imports serialization helpers from `@app/...` where useful (same
`@app` alias `tube/` uses). The browser `client/*` code is the only part the
host app mounts, and only at composition roots (router wrapper + Navbar slot +
the editor's modal prop).

## `src/` touch-points — exactly two, both generic

### 1. `EditorProps.renderPostRecordingModal` (opt-in render-prop)

`src/components/Editor.tsx` — add one optional prop; when present and not
`readOnly`, render it once a recording finalizes, handing over the finished
`Recording` and a close handler. Absent prop ⇒ current behavior unchanged.

```ts
// src/components/Editor.tsx (EditorProps)
/** Render an app-supplied UI after a recording finalizes (e.g. an upload
 *  modal). Kept generic so src has no knowledge of what it renders. */
renderPostRecordingModal?: (ctx: {
  recording: Recording;
  onClose: () => void;
}) => React.ReactNode;
```

Wiring: the editor already knows when a recording stops (recorder machine
transition / the moment `exportAsFile` is offered in `EditorHeader`). On that
transition, if the prop is set, stash the finished `Recording` in local state and
render `renderPostRecordingModal({ recording, onClose })`. No import of infra.

### 2. Extract `buildRecordingFiles` from `exportAsFile` (pure, reused)

`src/storage/RecordingStorage.ts::exportAsFile` currently does two things:
(a) serialize the recording into `.ne` + externalized audio/camera **blobs**,
then (b) trigger browser **downloads**. Split (a) into a pure function so the
upload modal reuses the identical encoding (no divergence, no download side
effect):

```ts
// returns blobs + their sibling filenames; no DOM, no download
buildRecordingFiles(recording, baseName): {
  ne: Blob;
  audio?: { name: string; blob: Blob };
  camera?: { name: string; blob: Blob };
}
```

`exportAsFile` then = `buildRecordingFiles(...)` + `downloadBlob(...)`. Expose
`buildRecordingFiles` through the actions/context (`NextEditorContext`) so the
infra modal can call it via the render-prop context. This reuses
`encodeRecordingToStream` and the existing audio/camera externalization
verbatim — the codec stays in `src/`, infra only orchestrates the upload.

### 3. (Optional) Navbar auth slot

`src/components/Navbar.tsx` — add an optional `actions?: React.ReactNode` slot
rendered on the right, so the host can drop infra's `<AuthMenu>` (sign-in /
avatar) in without the Navbar importing infra. Falls back to today's layout when
omitted.

That is the **entire** `src/` change surface: one render-prop, one refactor+export,
one optional slot. No R2, D1, OAuth, or Cloudflare types enter `src/`.

## `tube/` touch-points — catalog source swap

`tube/src/lib/lessons.ts` — the file's own comment already names this as the swap
point. Change `fetchLessonsPage` / `findLessonBySlug` to serve the static seed
first, then fall through to the D1-backed `/api/lessons*`:

- `fetchLessonsPage(cursor)`: seed shard(s) → then `/api/lessons?page=`; encode
  source+offset in the returned `nextPage` cursor so `useInfiniteQuery` is untouched.
- `findLessonBySlug(slug)`: seed `by-slug` shard → on 404, `/api/lessons/:slug`.

No auth/R2 logic enters `tube/`. The gallery/detail components are unchanged.

## Host composition (where infra gets mounted)

- Wrap the router (or app root) in infra `<AuthProvider>`.
- `/code` route: pass `renderPostRecordingModal={(ctx) => <UploadLessonModal {...ctx} />}` to `<Editor>`.
- `Navbar actions={<AuthMenu />}`.

All three are a handful of lines in `src/router.tsx` / the route wrappers — the
composition root, not scattered through `src/`.

## Build order (phased)

**Phase 0 — Scaffolding (no behavior change)**

- Create `infra/` package, add to the workspace, `wrangler.toml` with D1 + R2 + Static Assets bindings.
- `wrangler d1 create next-editor-tube`; create R2 bucket; write `0001_init.sql`; `wrangler d1 migrations apply` (local + remote).
- Add dev wiring (below). Verify `bun run dev` still serves the app + a `GET /api/health` from the Worker.

**Phase 1 — Read path (D1 gallery, still no auth)**

- Implement `/api/lessons`, `/api/lessons/:slug`, `/media/*`.
- Seed one hand-inserted D1 row pointing at an R2 object to prove the player renders R2-hosted media same-origin.
- Swap `tube/src/lib/lessons.ts` to merge seed + D1. Confirm seed (`introduction`) still loads with zero D1 hits.

**Phase 2 — Auth**

- Implement Google OAuth (login/callback/me/logout), sessions in D1, `<AuthProvider>` + `<AuthMenu>`.
- Gate nothing yet beyond `/api/auth/me`.

**Phase 3 — Write path (upload + publish)**

- `buildRecordingFiles` refactor in `src/`; `renderPostRecordingModal` prop.
- `/api/uploads/sign` (presigned PUT), `POST /api/lessons` (draft), `POST /api/lessons/:id/publish`, `DELETE`.
- `<UploadLessonModal>` + `useUploadLesson` + `resumeIntent` (OAuth-redirect resume).
- Run the **frontend-ux-design** skill for the modal states before building the UI (states listed below).

**Phase 4 — Cutover & hardening**

- Move `/api/slide-image` + `/api/proxy` into the Worker; keep `api/slide-image.ts` (Vercel) until Cloudflare is primary.
- Deploy: `bun run build` → `wrangler deploy`. Point production DNS at the Worker. Keep Vercel as fallback.

Each phase is independently shippable and reversible; nothing before Phase 3 touches `src/`.

## Dev workflow

Keep the existing `vp dev` for the SPA; run the Worker alongside and proxy API
paths to it (avoids reworking the vite-plus pipeline):

- `wrangler dev` serves the Worker with **local** D1 + R2 (Miniflare) — no cloud resources touched.
- Add vite `server.proxy` for `/api`, `/media`, `/lessons` → the `wrangler dev` port (or run them on one port via the Cloudflare vite plugin if it proves compatible with vite-plus — evaluate, don't assume).
- The existing `tube/vite/lessonsApiPlugin` stays for the static seed shards in dev.
- `.dev.vars` holds local secrets (Google client id/secret pointing at a `localhost` redirect URI, `SESSION_SECRET`).

## Modal UX states (for the Phase 3 UX pass)

`<UploadLessonModal>` must handle: **signed-out** (Sign in with Google, persist
resume intent) → **returning from OAuth** (reopen against the IndexedDB-persisted
recording) → **metadata form** (title required; description, tags, auto-suggested
duration, thumbnail: generated frame or upload) → **uploading** (per-file
progress; `.ne` fast, media slow; cancel) → **success** (Draft saved; [Publish
now] + copyable `/learn/:slug` link; "manage in My Lessons") → **error/retry**
(network, 401 re-auth, quota). Don't auto-publish — Draft → Publish is explicit.

## Config & secrets to provide

I'll need these from you before Phases 2–4 (nothing needed for Phase 0/1 scaffolding besides a Cloudflare login):

**Google Cloud (OAuth) — Phase 2**

- OAuth **Client ID** and **Client Secret** (Web application).
- Authorized redirect URIs to register:
  - `https://<prod-domain>/api/auth/google/callback`
  - `http://localhost:<port>/api/auth/google/callback` (dev)
- Consent screen scopes: `openid email profile` (no sensitive scopes).

**Cloudflare — Phase 0**

- Which account (I'll `wrangler login`; tell me if there are multiple accounts).
- Production **domain / custom hostname** for the Worker (or use a `*.workers.dev` subdomain to start).
- Confirm names: D1 `next-editor-tube`, R2 bucket `next-editor-tube-media` (or your preferred names).

**Secrets set via `wrangler secret put` (never committed) — Phases 2–3**

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET` (random 32+ bytes; I can generate)
- If using presigned S3-style R2 uploads: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` (from R2 → Manage API Tokens). Not needed if we use Worker-proxied `env.BUCKET.put()` for small lessons.

## Testing

- **Worker**: unit-test route handlers with Miniflare's local D1/R2; cover auth (state/PKCE mismatch → 400, expired session → 401), ownership (non-owner PATCH/DELETE → 403), upload signing (key scoping), and gallery pagination/draft-exclusion.
- **`src/` refactor**: assert `buildRecordingFiles` produces the same `.ne`/audio bytes the current `exportAsFile` download produces (round-trip decode). Reuse existing `RecordingStorage.test.ts` fixtures.
- **`tube/` merge**: seed-only, D1-only, and mixed pagination; slug found in seed vs D1 vs neither.
- **Manual**: record → sign in → upload → publish → appears in gallery → plays back with audio same-origin (COEP clean). You eyeball the UI (per project convention).

## Rollout / rollback

- Ship Phases 0–2 behind no user-visible change (gallery still shows seed; auth menu can be feature-flagged).
- Cloudflare deploy is additive; Vercel stays live. Rollback = point DNS back / stop routing `/api` to the Worker; the static seed keeps working either way.
- `DELETE` must remove both the D1 row and R2 objects to avoid orphans; a periodic reconcile (Cron Trigger) can sweep drafts abandoned before `POST /api/lessons`.

## Open questions (non-blocking; sensible defaults chosen)

1. **Thumbnail**: auto-generate from a recording frame, or require upload? (Default: offer a generated frame, allow override.)
2. **Slug collisions / renames**: slug = `<kebab-title>-<short-id>` to guarantee uniqueness; editing the title doesn't change the slug. OK?
3. **Quotas**: per-user lesson count / total bytes cap for the free tier? (Default: soft cap, revisit.)
4. **Cloudflare vite plugin vs `wrangler dev` + proxy**: decide during Phase 0 based on vite-plus compatibility.
5. **Retire Vercel** once Cloudflare is primary, or keep as permanent fallback?
