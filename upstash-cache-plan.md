# Plan: Integrate Upstash Redis for caching frequent lessons queries

## Goal

Add an optional Upstash Redis cache-aside layer in front of the read-heavy public
lesson endpoints, to cut D1 reads on the gallery and lesson-detail pages. Must
degrade gracefully (app works identically with Upstash absent or failing) and
stay within the free tier (256 MB storage / 10 GB bandwidth / 500K commands per
month).

## Context: what is actually queried

Backend is a Cloudflare Worker (Hono) over D1, in `infra/`. Query layer:
`infra/db/queries.ts`. Routes: `infra/worker/routes/`.

| Endpoint                     | Query fn                                            | Frequency                     | Cache decision                           |
| ---------------------------- | --------------------------------------------------- | ----------------------------- | ---------------------------------------- |
| `GET /api/lessons?page=N`    | `listPublishedLessons`                              | Highest (gallery/browse)      | Cache (TTL ~60s)                         |
| `GET /api/lessons/:slug`     | `getPublishedLessonBySlug`                          | High (lesson detail)          | Cache (TTL ~300s)                        |
| `GET /api/authors/:username` | `getUserByUsername` + `listPublishedLessonsByOwner` | Medium (profiles)             | Optional / later                         |
| `GET /api/search?q=`         | `searchPublishedLessons` + `searchUsers`            | Medium, unbounded cardinality | Do NOT cache (would burn command budget) |

Writes that must invalidate cache: publish / unpublish / update / delete lesson,
and username rename (`updateUsername` cascades `author_url` into every lesson row).

## Design

Cache-aside pattern. `queries.ts` stays pure D1; caching lives in the route layer
(routes already hold `c.env`). Upstash `@upstash/redis` REST client is the only
Redis client that works on Workers (no TCP). Auto JSON-serializes values.

### 1. Dependency & bindings

- `bun add @upstash/redis`
- Add to `infra/worker/env.d.ts` `Env`:
  - `UPSTASH_REDIS_REST_URL: string;`
  - `UPSTASH_REDIS_REST_TOKEN: string;`
- Local dev: add both to `infra/.dev.vars` (already gitignored).
- Production: put `UPSTASH_REDIS_REST_URL` in `infra/wrangler.toml` `[vars]`;
  set token as a secret: `wrangler secret put UPSTASH_REDIS_REST_TOKEN --config infra/wrangler.toml`.
- Construct per-request (Workers has no `process.env`, so no `Redis.fromEnv()`):
  `new Redis({ url: c.env.UPSTASH_REDIS_REST_URL, token: c.env.UPSTASH_REDIS_REST_TOKEN })`.

### 2. New module `infra/worker/cache.ts`

- `getCache(env)` -> returns `null` when either env var is absent (Upstash stays
  optional, matching `SELF_HOSTING.md`).
- `cached<T>(cache, key, ttlSeconds, loader)` -> cache-aside: GET; on miss run
  `loader()`, `SET key value EX ttl`, return. Every Redis call is try/caught so a
  failure or missing config silently falls back to the D1 loader. The cache can
  never take the site down or turn a rate-limit into an error.
- Key builders + a `KEY_VERSION` prefix constant (e.g. `l:v1:`) to allow a
  code-level namespace bump.

### 3. Wire cache-aside into read routes (`infra/worker/routes/lessons.ts`)

- `GET /:slug` -> key `l:v1:slug:{slug}`, TTL ~300s. Cache the mapped
  `lessonRowToLesson(row)` JSON.
- `GET /` (gallery) -> key `l:v1:list:{page}:{size}`, TTL ~60s.

### 4. Invalidation strategy

- Single-lesson (exact, cheap): on `PATCH /:id`, `publish`, `unpublish`,
  `delete` -> `DEL l:v1:slug:{slug}` for the affected lesson (slug is stable from
  creation; `RETURNING *` already returns it).
- Gallery list (paginated): rely on the short 60s TTL rather than tracking every
  page key. A newly published lesson appears within <=60s; keeps command count
  minimal (1 GET per hit).
  - Upgrade path (only if instant consistency is wanted): a `l:v1:list:ver`
    integer folded into the list key, `INCR`'d on any publish/unpublish/delete.
    Costs +1 command per list read. Left as a documented option; default is
    TTL-only.
- Username rename (`updateUsername`): rely on TTL for slug/author entries (rename
  is rare). Can be made exact later by DEL-ing that owner's cached slug keys.

### 5. Free-tier guardrails (256 MB / 10 GB / 500K cmds per month)

- TTL on every key (bounds storage and staleness).
- Do not cache search.
- Cache hit = 1 command; miss = 2 (GET + SET). At these TTLs, hobby traffic stays
  well under 500K/month.
- Add a one-line note in docs about watching the Upstash console for usage.

### 6. Tests & docs

- `infra/worker/cache.test.ts` (vitest, matching existing `*.test.ts`): hit,
  miss -> load -> set, and graceful degradation (Redis throws -> returns D1 value).
  Use a small in-memory fake Redis.
- Update `docs/cloudflare-architecture.md` and `SELF_HOSTING.md`: Upstash is an
  optional cache layer; app works identically without it.
- Verify with `bun run typecheck` and `bun run test`.

## Files touched

- `package.json` (add `@upstash/redis`)
- `infra/worker/env.d.ts` (2 new bindings)
- `infra/.dev.vars` (local secrets)
- `infra/wrangler.toml` (`[vars]` URL; token via `wrangler secret put`)
- NEW `infra/worker/cache.ts`
- `infra/worker/routes/lessons.ts` (cache-aside on GET, DEL on writes)
- NEW `infra/worker/cache.test.ts`
- `docs/cloudflare-architecture.md`, `SELF_HOSTING.md`

## Open decisions

1. Gallery invalidation: TTL-only (simplest, <=60s staleness) vs. version-stamp
   (instant, +1 command per list read). Default in plan: TTL-only.
2. Whether to also cache author-profile pages now or defer.

## Note on alternatives (non-blocking)

Since the app is already on Cloudflare, the Workers Cache API or KV would cache
these same GETs at the edge with no external dependency, no monthly command cap,
and lower latency. Upstash is the better choice if a shared Redis is wanted for
future rate-limiting/counters or cross-region coherence. Proceeding with Upstash
as requested.
