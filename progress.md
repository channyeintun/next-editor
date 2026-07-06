# Upstash cache integration — progress

Tracking implementation of [upstash-cache-plan.md](upstash-cache-plan.md).

| #   | Task                                                 | Status  |
| --- | ---------------------------------------------------- | ------- |
| 1   | Add @upstash/redis dependency and Env bindings       | done    |
| 2   | Create infra/worker/cache.ts cache-aside module      | pending |
| 3   | Wire cache-aside into infra/worker/routes/lessons.ts | pending |
| 4   | Add infra/worker/cache.test.ts tests                 | pending |
| 5   | Update docs for optional Upstash cache layer         | pending |
| 6   | Final verification: typecheck, lint, test, build     | pending |

## Log

- Task 1: added `@upstash/redis` dep, optional `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` bindings to `infra/worker/env.d.ts`, local `.dev.vars` placeholders (commented, gitignored), and doc comment in `infra/wrangler.toml`. typecheck + lint clean.
