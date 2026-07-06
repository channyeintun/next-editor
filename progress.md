# Upstash cache integration — progress

Tracking implementation of [upstash-cache-plan.md](upstash-cache-plan.md).

| #   | Task                                                 | Status  |
| --- | ---------------------------------------------------- | ------- |
| 1   | Add @upstash/redis dependency and Env bindings       | done    |
| 2   | Create infra/worker/cache.ts cache-aside module      | done    |
| 3   | Wire cache-aside into infra/worker/routes/lessons.ts | pending |
| 4   | Add infra/worker/cache.test.ts tests                 | pending |
| 5   | Update docs for optional Upstash cache layer         | pending |
| 6   | Final verification: typecheck, lint, test, build     | pending |

## Log

- Task 1: added `@upstash/redis` dep, optional `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` bindings to `infra/worker/env.d.ts`, local `.dev.vars` placeholders (commented, gitignored), and doc comment in `infra/wrangler.toml`. typecheck + lint clean.
- Task 2: added `infra/worker/cache.ts` — uses `@upstash/redis/cloudflare` entrypoint (Workers-specific, no node-fetch warnings); `getCache(env)` returns `null` when Upstash isn't configured; `cached()` cache-aside helper and `invalidateCache()` both wrap every Redis call in try/catch so a Redis outage falls back to the D1 loader instead of failing the request. typecheck + lint clean.
