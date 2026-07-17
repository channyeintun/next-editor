// Worker Env bindings — kept in sync with infra/wrangler.toml.
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BUCKET: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  PUBLIC_URL: string;
  // New rooms use the hibernating Durable Object WebSocket transport unless
  // this is explicitly set to "upstash-realtime" for a room-level rollback.
  COLLABORATION_DEFAULT_TRANSPORT?: string;
  COLLABORATION_ROOMS?: DurableObjectNamespace;
  // Cloudflare Workers KV cache (infra/worker/cache.ts). Optional in the type
  // so self-hosted/test environments can omit it and fall through to D1.
  CACHE?: KVNamespace;
  // Required by live collaboration. Upstash Redis is reserved for this data
  // plane and is never reused by the gallery cache.
  COLLAB_REDIS_REST_URL?: string;
  COLLAB_REDIS_REST_TOKEN?: string;
  // Optional in local development. When configured together, QStash handles
  // collaboration compaction and delayed room cleanup outside the edit path.
  QSTASH_TOKEN?: string;
  QSTASH_CURRENT_SIGNING_KEY?: string;
  QSTASH_NEXT_SIGNING_KEY?: string;
}
