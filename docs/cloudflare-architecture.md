# Tube on Cloudflare — Architecture

> Status: **design, not yet implemented.** Companion to [cloudflare-plan.md](./cloudflare-plan.md),
> which covers the build order and the exact code touch-points.

This describes how "Tube" (the `/learn` gallery) grows from a static, build-time
catalog into a live platform where a signed-in user can record a lesson, upload
it, and publish it — without dragging Cloudflare/D1/R2/OAuth logic into `src/`.

## Decisions locked in

| Question              | Decision                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment topology   | **Full Cloudflare, same-origin.** SPA served by Workers Static Assets; API, OAuth, and R2 all live behind the same origin via one Hono Worker.        |
| Lesson lifecycle      | **Draft → Publish.** Uploaded lessons start as private drafts; only `published` rows appear in the public gallery.                                    |
| Who can create        | **Any Google account.** Sign in with Google → you can record, upload, and publish.                                                                    |
| Existing JSON catalog | **Kept as-is.** The curated seed (e.g. `introduction`) stays static and D1-free — frequent-access, edge-cached. D1 only holds user-generated lessons. |

## Why same-origin is not negotiable here

The app ships with cross-origin isolation on **every** response:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy:   same-origin
```

(see `infra/worker/index.ts`, `vite.config.ts` `crossOriginHeaders`). This is
required for `SharedArrayBuffer` / the WebContainer runtime. Under
`require-corp`, **any subresource** — the `.ne` stream, the `.ogg`/`.weba`
audio, the camera `.webm`, the thumbnail — must either be same-origin, or
carry `Cross-Origin-Resource-Policy: cross-origin` **and** be requested with
the CORS `crossorigin` attribute. Serving lesson media from a separate origin
(a static SPA + a `api.*` Worker, or a public R2 bucket domain) means
retrofitting CORP + CORS onto every asset and every `<audio>`/`<video>` tag,
plus cross-site cookie handling for the OAuth session.

Serving the SPA, the API, and R2 bytes from **one Cloudflare origin** makes all
of that disappear: subresources are same-origin, so COEP is satisfied for free,
and the session cookie is a plain first-party `HttpOnly` cookie.

## Component boundaries — the whole point

Three layers, deliberately decoupled. The rule: **`src/` never imports
Cloudflare, D1, R2, OAuth, or the upload modal.** Dependencies point _inward_
toward `src/`, never outward.

```
┌──────────────────────────────────────────────────────────────────────┐
│  infra/  (@next-editor/infra)  ← NEW. All Cloudflare/D1/R2/OAuth here  │
│                                                                        │
│   worker/     Hono app: /api/*, /media/*, OAuth, D1 & R2 access        │
│   db/         D1 schema + migrations + typed queries                   │
│   client/     Browser pieces mounted by the host at composition roots: │
│                 • <UploadLessonModal>  (the post-recording modal)      │
│                 • <AuthMenu> / useAuth  (Google sign-in UI + state)    │
│                 • apiClient             (fetch wrapper for /api)        │
│   wrangler.toml                                                         │
└──────────────────────────────────────────────────────────────────────┘
          │ imports (allowed: infra → app, mirrors how tube imports @app)
          ▼
┌──────────────────────────────────────────────────────────────────────┐
│  src/  (the editor)   Gains exactly TWO tiny, generic seams:           │
│    1. EditorProps.renderPostRecordingModal?  (render-prop, opt-in)     │
│    2. buildRecordingFiles(recording)  extracted from exportAsFile      │
│       → { ne: Blob, audio?, camera? }  (pure, reused by download+upload)│
│  Knows nothing about R2/D1/OAuth. If the prop is absent, behaves as today.│
└──────────────────────────────────────────────────────────────────────┘
          ▲ imports @app (already does today)
          │
┌──────────────────────────────────────────────────────────────────────┐
│  tube/  (@next-editor/tube)   The /learn gallery.                      │
│    Catalog fetch swaps from "static shards only" to                    │
│    "static seed shards → then D1 pages" (the swap point the code       │
│    comments already anticipate). No R2/OAuth logic leaks in here.      │
└──────────────────────────────────────────────────────────────────────┘
```

`infra/` importing from `@app` is the same pattern `tube/` already uses
(`import Editor from "@app/components/Editor"` in `tube/src/components/LessonDetail.tsx`),
resolved by the `@app` alias in `vite.config.ts`.

## Runtime topology (production)

```
                         ┌───────────────────────────────────────────┐
   Browser  ───────────► │  Cloudflare Worker  (Hono)                │
   (one origin,          │                                           │
    cross-origin         │  /                 → Static Assets (dist) │──► SPA shell
    isolated)            │  /assets/*, /logo… → Static Assets        │
                         │  /lessons/*.json   → Static Assets (SEED) │──► curated catalog
                         │  /learn, /code …   → SPA fallback (index) │
                         │                                           │
                         │  /api/auth/google/*→ OAuth (Google)  ─────┼──► accounts.google.com
                         │  /api/lessons*     → D1 query        ─────┼──► D1 (lessons, users)
                         │  /api/uploads/sign → presign R2 PUT       │
                         │  /media/*          → R2 get         ─────┼──► R2 (lesson bytes)
                         │  /api/proxy        → cross-origin .ne proxy│
                         └───────────────────────────────────────────┘
```

Everything is one hostname, so COEP `require-corp` is satisfied and the session
cookie is first-party. Cloudflare's CDN caches static assets and (with cache
headers) `/media/*` at the edge.

## Data model — D1

```sql
-- users: one row per Google identity
CREATE TABLE users (
  id          TEXT PRIMARY KEY,          -- internal uuid
  google_sub  TEXT UNIQUE NOT NULL,      -- Google "sub" claim (stable id)
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  avatar_url  TEXT,
  created_at  INTEGER NOT NULL           -- epoch ms
);

-- sessions: server-side session store keyed by an opaque cookie token
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,          -- random 256-bit token (the cookie value)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- lessons: user-generated only. The seed (introduction) is NOT in D1.
CREATE TABLE lessons (
  id            TEXT PRIMARY KEY,        -- uuid; also the R2 folder + slug base
  slug          TEXT UNIQUE NOT NULL,    -- url-safe; "<kebab-title>-<short-id>"
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  thumbnail     TEXT,                    -- same-origin path, e.g. /media/lessons/<id>/thumbnail.png
  ne            TEXT NOT NULL,           -- same-origin path, e.g. /media/lessons/<id>/<id>.ne
  duration      TEXT,                    -- "4:12" (display string, matches Lesson type)
  tags          TEXT,                    -- JSON array string
  author        TEXT,                    -- denormalized display name (from users.name)
  author_url    TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'published'
  published_at  INTEGER,                 -- set on publish; NULL while draft
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_lessons_published ON lessons(status, published_at DESC);
CREATE INDEX idx_lessons_owner     ON lessons(owner_id, updated_at DESC);
```

The public gallery reads only `WHERE status='published'`. A user's drafts are
reachable via `/api/lessons/mine` (auth-scoped to `owner_id`). The JSON the API
returns per lesson is shaped to match tube's existing `Lesson` interface
(`tube/src/types.ts`) exactly, so the gallery components need no changes.

## Storage model — R2

One bucket, one folder per lesson id. Mirrors the sibling-file convention the
player already relies on (`useUrlLoader` resolves `audioFile`/`cameraFile`/
captions relative to the `.ne` URL), so **no player changes are needed**.

```
next-editor-tube-media/
  lessons/
    <lesson-id>/
      <lesson-id>.ne          # SCR3 stream (small, delta-compressed)
      <lesson-id>.ogg|.weba   # externalized audio  (sibling of the .ne)
      <lesson-id>.webm        # externalized camera (optional)
      <lesson-id>.en.vtt      # captions (optional)
      thumbnail.png|svg
  slide-images/
    <sha256-of-source-url>    # Google Slides deck images copied at import time
                              # (POST /api/slide-images); keyed by source URL so
                              # the same image is stored once across all decks
```

Bytes are served **through the Worker** at `/media/lessons/<id>/<file>` from the
R2 binding (`env.BUCKET.get(key)`), with `Content-Type`, long-lived
`Cache-Control: public, max-age=31536000, immutable`, and `Range` support for
audio/video streaming. Serving through the Worker (rather than a public bucket
domain) keeps media same-origin → COEP-clean and cache-friendly.

D1 stores the **path** (`/media/lessons/<id>/<id>.ne`), not the raw R2 key, so
the value drops straight into `lesson.ne` and the player's existing sibling
resolution finds the audio/captions with zero special-casing.

## Catalog resolution — seed stays static, D1 layered on top

Two sources, merged by the tube client (this is the "Swap point for a real
backend" the existing `tube/vite/lessonsApiPlugin.ts` and `tube/src/lib/lessons.ts`
comments already call out):

| Source                                  | Path                                              | Backed by                             | D1 hit? | Cache     |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------- | ------- | --------- |
| **Seed** (curated, e.g. `introduction`) | `/lessons/page-*.json`, `/lessons/by-slug/*.json` | Static assets (unchanged vite plugin) | No      | Edge/CDN  |
| **Dynamic** (user, published)           | `/api/lessons?page=`, `/api/lessons/:slug`        | D1 via Worker                         | Yes     | Short TTL |

- **Gallery** (`fetchLessonsPage`): serve the seed shard(s) first, then continue
  the infinite scroll into D1 pages. The `nextPage` cursor encodes which source
  and offset comes next, so the existing `useInfiniteQuery` wiring is untouched.
- **Detail** (`findLessonBySlug`): try the seed `by-slug` shard; on 404 fall
  back to `/api/lessons/:slug`. Returns `null` on a real miss (unchanged
  contract), so `LessonDetailRoute` still distinguishes not-found from error.

The introduction lesson therefore **never touches D1** and keeps being served as
plain edge-cached JSON + static assets — exactly the "frequent access" carve-out
requested.

## Caching — optional Upstash Redis layer

The "Short TTL" cache in the table above is `infra/worker/cache.ts`: an
optional cache-aside layer in front of the two highest-traffic D1 reads,
`GET /api/lessons` (list, 60s TTL) and `GET /api/lessons/:slug` (300s TTL).
Search (`/api/search`) is deliberately **not** cached — unbounded query
cardinality would burn through Upstash's free-tier command budget for little
benefit.

- **Optional by design.** `getCache(env)` returns `null` when
  `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` aren't set, and every
  Redis call in `cached()`/`invalidateCache()` is wrapped so a cache outage or
  missing config falls back to hitting D1 directly — Upstash can never take
  the app down.
- **Invalidation.** `PATCH /api/lessons/:id`, `/publish`, `/unpublish`, and
  `DELETE /api/lessons/:id` all `DEL` the affected lesson's slug-cache entry
  immediately (critical for unpublish — otherwise a cached response could
  keep serving an unpublished lesson for up to the 300s TTL). The paginated
  list relies on its 60s TTL rather than per-page invalidation.
- **Free tier fit** (256 MB storage / 10 GB bandwidth / 500K commands per
  month): every key carries a TTL, a cache hit costs 1 command and a miss 2
  (GET + SET), and search is excluded — comfortably inside the free tier for
  hobby-scale traffic.

See [upstash-cache-plan.md](../upstash-cache-plan.md) for the integration plan.

## Auth — Google OAuth, first-party session

Authorization Code flow with PKCE, terminated server-side in the Worker so the
client never sees the client secret or Google tokens.

```
1. Browser → GET /api/auth/google/login?returnTo=/code
             Worker sets short-lived signed cookie {state, code_verifier, returnTo},
             302 → accounts.google.com  (scope: openid email profile)

2. Google  → GET /api/auth/google/callback?code&state
             Worker verifies state (CSRF), exchanges code+verifier for tokens
             (server-to-server), fetches userinfo, UPSERTs users row by google_sub,
             creates sessions row, sets:
               Set-Cookie: ne_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/
             302 → returnTo

3. Browser → GET /api/auth/me         → { user } | 401
             POST /api/auth/logout     → delete session row + clear cookie
```

`SameSite=Lax` is sufficient because everything is same-origin. The session
token is opaque (random), validated against D1 on each authed request; sessions
expire (`expires_at`) and can be revoked by deleting the row.

**OAuth redirect + the recording:** a full-page redirect to Google would drop an
open modal and in-memory state. Mitigation: the finished recording is already
persisted to IndexedDB by the recorder, so before redirecting the modal stores a
small "resume intent" (recording id + `returnTo`); on return, the host reopens
the upload modal against the persisted recording. See the plan for the exact
sequencing.

## API surface (Hono routes)

| Method & path                   | Auth   | Purpose                                                                              |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `GET /api/auth/google/login`    | —      | Begin OAuth (PKCE), redirect to Google                                               |
| `GET /api/auth/google/callback` | —      | Exchange code, upsert user, set session cookie                                       |
| `GET /api/auth/me`              | cookie | Current user or 401                                                                  |
| `POST /api/auth/logout`         | cookie | End session                                                                          |
| `GET /api/lessons?page=`        | —      | Published lessons, paginated (D1)                                                    |
| `GET /api/lessons/:slug`        | —      | One published lesson (D1)                                                            |
| `GET /api/lessons/mine`         | cookie | Caller's lessons incl. drafts                                                        |
| `POST /api/uploads/sign`        | cookie | Presigned R2 PUT URLs for a new lesson's files                                       |
| `POST /api/lessons`             | cookie | Create **draft** row after upload completes                                          |
| `PATCH /api/lessons/:id`        | owner  | Edit metadata                                                                        |
| `POST /api/lessons/:id/publish` | owner  | `status='published'`, set `published_at`                                             |
| `DELETE /api/lessons/:id`       | owner  | Delete row + R2 objects                                                              |
| `GET /media/*`                  | —      | Stream R2 object (Range, immutable cache)                                            |
| `POST /api/slide-images`        | cookie | Copy Google Slides deck images into R2 at import time (`slide-images/<hash>` keys)   |
| `GET /api/proxy?url=`           | —      | Same-origin proxy for cross-origin `.ne` loads (path already used by `useUrlLoader`) |

## Upload & publish sequence

```
recording stops
   │
   ▼  src fires renderPostRecordingModal({ recording, onClose })
infra <UploadLessonModal>
   │  ── not signed in? → "Sign in with Google" (store resume intent, redirect)
   │  ── signed in:
   │       1. user fills title / description / tags / thumbnail
   │       2. build files: buildRecordingFiles(recording)  ← src helper (pure)
   │            → { ne: Blob, audio?: {name,blob}, camera?: {name,blob} }
   │       3. POST /api/uploads/sign  → { lessonId, put: {ne, audio, thumb, …} }
   │       4. PUT each blob directly to R2 (presigned URLs, off the Worker CPU)
   │       5. POST /api/lessons {id, title, ne path, …}  → D1 draft row
   │       6. success: show "Draft saved" + [Publish] + link to /learn/:slug
   │            Publish → POST /api/lessons/:id/publish
   ▼
gallery shows it (once published) alongside the static seed
```

`.ne` files are tiny; audio/camera can be tens of MB. Presigned **direct-to-R2**
PUTs keep large bodies off the Worker (Workers have request-size and CPU limits,
and the free tier bills CPU). A Worker-proxied `env.BUCKET.put()` is the simpler
fallback for small, `.ne`-only lessons.

## Security notes

- Client secret and R2 signing keys live only as **Worker secrets**, never shipped to the browser.
- Session cookie is `HttpOnly; Secure; SameSite=Lax`; tokens are opaque and DB-validated; PKCE + `state` guard the OAuth handshake.
- Ownership is enforced server-side on every mutating route (`owner_id === session.user_id`); "any Google account can create" does **not** mean any account can edit another's lesson.
- Upload signing validates content-type/size and scopes each presigned URL to one `lessons/<id>/…` key, so a token can't overwrite arbitrary objects.
- Draft lessons are never returned by the public gallery query; only `/api/lessons/mine` (owner-scoped) exposes them.

## Cost / free-tier fit

Workers (100k req/day), D1 (5 GB + generous daily rows), and R2 (10 GB storage,
**zero egress fees**) free tiers comfortably cover a small tube. Keeping the seed
static means the highest-traffic lesson (`introduction`) costs no D1 reads at
all. R2's no-egress pricing is the key reason media streaming is cheap here.

## What explicitly does **not** change

- The `.ne` / SCR3 format, the codec, the recorder machine, playback, sibling media resolution.
- The static seed catalog and `public/lessons/introduction/*` assets.
- The editor's behavior when `renderPostRecordingModal` is not supplied (i.e. the `/code` route stays byte-for-byte as today).
