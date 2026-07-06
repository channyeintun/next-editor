// Worker Env bindings — kept in sync with infra/wrangler.toml.
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BUCKET: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  PUBLIC_URL: string;
  // Optional Upstash Redis REST cache layer (infra/worker/cache.ts). Absent
  // in local/self-hosted setups — the app must work identically without it.
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}
