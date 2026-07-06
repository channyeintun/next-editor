# Upstash cache integration — progress

Tracking implementation of [upstash-cache-plan.md](upstash-cache-plan.md).

| #   | Task                                                 | Status |
| --- | ---------------------------------------------------- | ------ |
| 1   | Add @upstash/redis dependency and Env bindings       | done   |
| 2   | Create infra/worker/cache.ts cache-aside module      | done   |
| 3   | Wire cache-aside into infra/worker/routes/lessons.ts | done   |
| 4   | Add infra/worker/cache.test.ts tests                 | done   |
| 5   | Update docs for optional Upstash cache layer         | done   |
| 6   | Final verification: typecheck, lint, test, build     | done   |

## Log

- Task 1: added `@upstash/redis` dep, optional `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` bindings to `infra/worker/env.d.ts`, local `.dev.vars` placeholders (commented, gitignored), and doc comment in `infra/wrangler.toml`. typecheck + lint clean.
- Task 2: added `infra/worker/cache.ts` — uses `@upstash/redis/cloudflare` entrypoint (Workers-specific, no node-fetch warnings); `getCache(env)` returns `null` when Upstash isn't configured; `cached()` cache-aside helper and `invalidateCache()` both wrap every Redis call in try/catch so a Redis outage falls back to the D1 loader instead of failing the request. typecheck + lint clean.
- Task 3: wired `cached()` into `GET /api/lessons` (list, 60s TTL) and `GET /api/lessons/:slug` (300s TTL); added `invalidateCache()` calls on PATCH `/:id`, `/:id/publish`, `/:id/unpublish`, and DELETE `/:id` so publish/unpublish state changes don't serve stale cached responses. List cache relies on TTL only (no per-page invalidation), per the plan. typecheck + lint clean.
- Task 4: added `infra/worker/cache.test.ts` covering `cached()` (null cache, hit, miss+TTL, GET-throws, SET-throws) and `invalidateCache()` (null cache, delete, DEL-throws) against a minimal in-memory fake Redis. Fixed `require-mock-type-parameters` lint warnings by typing `vi.fn<...>()` per existing repo convention. Full suite: 53 files / 375 tests passing.
- Task 5: documented the cache layer in `docs/cloudflare-architecture.md` (new "Caching — optional Upstash Redis layer" section) and `docs/cloudflare-deploy-guide.md` (new "Optional: Upstash Redis cache" setup subsection). Skipped `SELF_HOSTING.md` — that doc covers the static Docker/Caddy deploy path only, which never runs the Worker/D1/R2 backend, so Upstash doesn't apply there.
- Task 6: `bun run build` succeeds, `bun run test` is 53 files / 375 tests passing, `bun run lint` clean. Plan complete — Upstash cache-aside layer is wired in, optional, and degrades gracefully when unconfigured.
